import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CallItem } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, Empty, ErrorText, Field, Spinner, inputCls } from "../components/ui";
import { fmtDateTime, toLocalInput } from "../format";

/** The shared call list: anyone adds a person to call; whoever takes a row picks the time and gets a task with a reminder. */
export default function Calls() {
  const s = useSession();
  const [items, setItems] = useState<CallItem[] | null>(null);
  const [done, setDone] = useState<CallItem[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [taking, setTaking] = useState<number | null>(null);
  const [when, setWhen] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.calls();
      setItems(r.items);
      setDone(r.done);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api.addCall({ name: name.trim(), phone: phone.trim(), note: note.trim() });
      setName("");
      setPhone("");
      setNote("");
    });
  }

  function startTake(id: number) {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 60 - (d.getMinutes() % 30), 0, 0);
    setWhen(toLocalInput(d.toISOString()));
    setTaking(id);
  }

  const open = (items ?? []).filter((i) => i.status === "open");
  const scheduled = (items ?? []).filter((i) => i.status === "scheduled");

  return (
    <div>
      <h1 className="mb-1 text-lg font-bold text-ink-900">📞 רשימת שיחות משותפת</h1>
      <p className="mb-3 text-sm text-slate-600">כולם רואים את אותה רשימה. מוסיפים מי שצריך להתקשר אליו; מי שלוקח שיחה קובע לה שעה, והיא נכנסת לו ללו"ז עם תזכורת.</p>
      <form onSubmit={add} className="mb-4 space-y-2 rounded-2xl bg-white p-3 shadow-sm" data-testid="call-add">
        <div className="grid grid-cols-2 gap-2">
          <Field label="למי להתקשר">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="שם" data-testid="call-add-name" />
          </Field>
          <Field label="טלפון">
            <input type="tel" dir="ltr" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-000-0000" data-testid="call-add-phone" />
          </Field>
        </div>
        <Field label="על מה השיחה? (לא חובה)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="call-add-note" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !name.trim()} data-testid="call-add-submit">
            + הוספה לרשימה
          </Button>
        </div>
      </form>
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <section>
            <h2 className="mb-2 text-sm font-bold text-ink-800">🟢 פנויות ({open.length})</h2>
            {open.length === 0 ? (
              <Empty>אין שיחות פנויות</Empty>
            ) : (
              <ul className="space-y-2">
                {open.map((i) => (
                  <li key={i.id} className="rounded-2xl bg-white p-3 shadow-sm" data-testid={`call-${i.id}`}>
                    <Row item={i} nameOf={s.nameOf} />
                    {taking === i.id ? (
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="block text-xs font-semibold text-slate-600">
                          מתי השיחה?
                          <input type="datetime-local" className={`${inputCls} mt-1`} value={when} onChange={(e) => setWhen(e.target.value)} data-testid={`call-when-${i.id}`} />
                        </label>
                        <Button disabled={busy || !when} onClick={() => run(async () => { await api.takeCall(i.id, new Date(when).toISOString()); setTaking(null); })} data-testid={`call-confirm-${i.id}`}>
                          קביעה ✓
                        </Button>
                        <Button variant="secondary" onClick={() => setTaking(null)}>ביטול</Button>
                      </div>
                    ) : (
                      <div className="mt-2 flex justify-between gap-2">
                        <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => startTake(i.id)} data-testid={`call-take-${i.id}`}>
                          לקבוע שיחה
                        </Button>
                        {(i.createdById === s.user.id || s.user.role === "admin") && (
                          <button type="button" className="text-xs text-slate-500 hover:text-red-600" onClick={() => run(() => api.deleteCall(i.id))} data-testid={`call-delete-${i.id}`}>
                            מחיקה
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-bold text-ink-800">📅 נקבעו ({scheduled.length})</h2>
            {scheduled.length === 0 ? (
              <Empty>עוד לא נקבעו שיחות</Empty>
            ) : (
              <ul className="space-y-2">
                {scheduled.map((i) => (
                  <li key={i.id} className="rounded-2xl border border-sky-200 bg-sky-50/40 p-3" data-testid={`call-${i.id}`}>
                    <Row item={i} nameOf={s.nameOf} />
                    <div className="mt-1 text-sm font-semibold text-sky-800" data-testid={`call-sched-${i.id}`}>
                      {i.takenById ? s.nameOf(i.takenById) : ""} · {i.scheduledAt ? fmtDateTime(i.scheduledAt) : ""}
                    </div>
                    {(i.takenById === s.user.id || s.user.role === "admin") && (
                      <div className="mt-2 flex gap-2">
                        <Button className="px-3 py-1.5" disabled={busy} onClick={() => run(() => api.doneCall(i.id))} data-testid={`call-done-${i.id}`}>
                          בוצע ✓
                        </Button>
                        <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => startTake(i.id)}>
                          שינוי שעה
                        </Button>
                        <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => run(() => api.releaseCall(i.id))} data-testid={`call-release-${i.id}`}>
                          שחרור
                        </Button>
                      </div>
                    )}
                    {taking === i.id && (
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="block text-xs font-semibold text-slate-600">
                          שעה חדשה
                          <input type="datetime-local" className={`${inputCls} mt-1`} value={when} onChange={(e) => setWhen(e.target.value)} data-testid={`call-when-${i.id}`} />
                        </label>
                        <Button disabled={busy || !when} onClick={() => run(async () => { await api.takeCall(i.id, new Date(when).toISOString()); setTaking(null); })} data-testid={`call-confirm-${i.id}`}>
                          קביעה ✓
                        </Button>
                        <Button variant="secondary" onClick={() => setTaking(null)}>ביטול</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-bold text-ink-800">✅ בוצעו בשבוע האחרון ({done.length})</h2>
              <ul className="space-y-1">
                {done.map((i) => (
                  <li key={i.id} className="rounded-xl bg-white/70 px-3 py-2 text-sm text-slate-600" data-testid={`call-${i.id}`}>
                    <span className="line-through">{i.name}</span>
                    {i.takenById ? ` · ${s.nameOf(i.takenById)}` : ""}
                    {i.doneAt ? ` · ${fmtDateTime(i.doneAt)}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ item, nameOf }: { item: CallItem; nameOf: (id: number) => string }) {
  return (
    <div>
      <div className="text-sm font-bold text-ink-900">{item.name}</div>
      <div className="text-xs text-slate-600">
        {item.phone && (
          <a href={`tel:${item.phone}`} dir="ltr" className="text-brand-700">
            {item.phone}
          </a>
        )}
        {item.phone && item.note ? " · " : ""}
        {item.note}
      </div>
      <div className="text-xs text-slate-500">הוסיף/ה: {nameOf(item.createdById)}</div>
    </div>
  );
}
