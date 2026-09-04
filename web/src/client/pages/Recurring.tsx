import { useCallback, useEffect, useState } from "react";
import type { RecurringTask } from "@shared/types";
import { canEditOrDelete } from "@shared/permissions";
import { api } from "../api";
import { useSession } from "../state";
import { Button, Empty, ErrorText, Field, Modal, Spinner, inputCls } from "../components/ui";
import TaskForm from "../components/TaskForm";
import { WEEKDAYS_SHORT, fmtWeekdays } from "../format";

export default function Recurring() {
  const s = useSession();
  const [items, setItems] = useState<RecurringTask[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RecurringTask | null>(null);
  const [deleting, setDeleting] = useState<RecurringTask | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.recurring()).recurring);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(r: RecurringTask) {
    try {
      await api.updateRecurring(r.id, { active: !r.active });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-ink-900">משימות קבועות</h1>
        <Button onClick={() => setAdding(true)}>+ משימה קבועה</Button>
      </div>
      <p className="mb-3 text-sm text-slate-600">משימות שנוצרות אוטומטית בימים שנבחרו. משימה שלא הושלמה נגררת ליום הבא כרגיל.</p>
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty>אין משימות קבועות עדיין</Empty>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => {
            const editable = canEditOrDelete(s.user, r, s.users);
            return (
              <li key={r.id} className={`rounded-2xl bg-white p-3 shadow-sm ${r.active ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-ink-900">{r.title}</div>
                    {r.details && <div className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600">{r.details}</div>}
                    <div className="mt-1 text-xs text-slate-500">
                      {s.nameOf(r.assigneeId)} · {fmtWeekdays(r.weekdays)} · נוסף ע"י {s.nameOf(r.createdById)}
                      {!r.active && <span className="ms-2 font-semibold text-red-600">מושהית</span>}
                    </div>
                  </div>
                  {editable && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" className="px-2" onClick={() => toggle(r)} title={r.active ? "השהיה" : "הפעלה"}>
                        {r.active ? "השהיה" : "הפעלה"}
                      </Button>
                      <Button variant="ghost" className="px-2" onClick={() => setEditing(r)}>
                        עריכה
                      </Button>
                      <Button variant="ghost" className="px-2 text-red-700" onClick={() => setDeleting(r)}>
                        מחיקה
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="משימה קבועה חדשה">
        {adding && (
          <TaskForm
            defaultAssigneeId={s.user.id}
            defaultDate={s.today}
            forceRecurring
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              load();
            }}
          />
        )}
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title="עריכת משימה קבועה">
        {editing && (
          <EditRecurring
            item={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        )}
      </Modal>

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="מחיקת משימה קבועה">
        {deleting && (
          <DeleteRecurring
            item={deleting}
            onCancel={() => setDeleting(null)}
            onDeleted={() => {
              setDeleting(null);
              load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function EditRecurring({ item, onCancel, onSaved }: { item: RecurringTask; onCancel: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [details, setDetails] = useState(item.details);
  const [weekdays, setWeekdays] = useState(item.weekdays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api.updateRecurring(item.id, { title, details, weekdays });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="משימה">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </Field>
      <Field label="פירוט">
        <textarea className={inputCls} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
      </Field>
      <Field label="ימים">
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS_SHORT.map((label, d) => (
            <button
              type="button"
              key={d}
              onClick={() => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))}
              className={`min-w-10 rounded-lg border px-2 py-1.5 text-sm font-semibold ${weekdays.includes(d) ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-ink-700"}`}
              aria-pressed={weekdays.includes(d)}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>ביטול</Button>
        <Button type="submit" disabled={busy || weekdays.length === 0}>{busy ? "שומר..." : "שמירה"}</Button>
      </div>
    </form>
  );
}

function DeleteRecurring({ item, onCancel, onDeleted }: { item: RecurringTask; onCancel: () => void; onDeleted: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">
        המשימה הקבועה <b>{item.title}</b> תפסיק להיווצר. משימות שכבר נוצרו יישארו.
      </p>
      <Field label="סיבת המחיקה (חובה)">
        <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>ביטול</Button>
        <Button
          variant="danger"
          disabled={busy || reason.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api.deleteRecurring(item.id, reason);
              onDeleted();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "מוחק..." : "מחיקה"}
        </Button>
      </div>
    </div>
  );
}
