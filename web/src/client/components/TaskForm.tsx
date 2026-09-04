import { useState, type FormEvent } from "react";
import type { Task } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Field, inputCls } from "./ui";
import { WEEKDAYS_SHORT } from "../format";

interface Props {
  defaultAssigneeId: number;
  defaultDate: string;
  existing?: Task;
  forceRecurring?: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

export default function TaskForm({ defaultAssigneeId, defaultDate, existing, forceRecurring = false, onSaved, onCancel }: Props) {
  const s = useSession();
  const allActive = s.users.filter((u) => u.active);
  const managed = allActive.filter((u) => s.canSee(u.id));
  const others = allActive.filter((u) => !s.canSee(u.id));
  const [title, setTitle] = useState(existing?.title ?? "");
  const [details, setDetails] = useState(existing?.details ?? "");
  const [assigneeId, setAssigneeId] = useState(existing?.assigneeId ?? defaultAssigneeId);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? defaultDate);
  const [recurring, setRecurring] = useState(forceRecurring);
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggleDay(d: number) {
    setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (existing) {
        await api.updateTask(existing.id, { title, details, dueDate, assigneeId });
      } else {
        if (recurring && weekdays.length === 0) throw new Error("יש לבחור לפחות יום אחד");
        await api.createTask({ title, details, assigneeId, dueDate, weekdays: recurring ? weekdays : [] });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="משימה">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus placeholder="למשל: להתקשר ל-5 לידים חדשים" />
      </Field>
      <Field label="פירוט (לא חובה)">
        <textarea className={inputCls} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={3000} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="עובד">
          <select className={inputCls} value={assigneeId} onChange={(e) => setAssigneeId(Number(e.target.value))}>
            {managed.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === s.user.id ? `${u.name} (אני)` : u.name}
              </option>
            ))}
            {others.length > 0 && !recurring && (
              <optgroup label="בקשה לעובד אחר">
                {others.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label={recurring ? "החל מתאריך" : "תאריך יעד"}>
          <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
      </div>

      {!s.canSee(assigneeId) && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">
          המשימה תופיע אצל {s.nameOf(assigneeId)} כבקשה ממך. תוכל לעקוב אחרי הסטטוס שלה ב"משימות ששלחתי לאחרים", בלי לראות את שאר הלו"ז.
        </p>
      )}
      {!existing && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink-700">
            <input
              type="checkbox"
              className="size-4 accent-brand-600"
              checked={recurring}
              disabled={forceRecurring || !s.canSee(assigneeId)}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            משימה קבועה (חוזרת כל שבוע)
          </label>
          {!s.canSee(assigneeId) && <p className="mt-1 text-xs text-slate-500">משימה קבועה אפשר להגדיר רק לעצמך או לעובדים שאתה מנהל.</p>}
          {recurring && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {WEEKDAYS_SHORT.map((label, d) => (
                <button
                  type="button"
                  key={d}
                  onClick={() => toggleDay(d)}
                  className={`min-w-10 rounded-lg border px-2 py-1.5 text-sm font-semibold ${
                    weekdays.includes(d) ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-ink-700"
                  }`}
                  aria-pressed={weekdays.includes(d)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onCancel}>
          ביטול
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "שומר..." : existing ? "שמירת שינויים" : "הוספה"}
        </Button>
      </div>
    </form>
  );
}
