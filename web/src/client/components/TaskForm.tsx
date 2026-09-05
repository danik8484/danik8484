import { useState, type FormEvent } from "react";
import type { Task, TaskPriority } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Field, inputCls } from "./ui";
import { PRIORITY_HINT, PRIORITY_LABEL, WEEKDAYS_SHORT } from "../format";
import { canManage, isCoordinator } from "@shared/permissions";

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
  // "Managed" = boards I run (mine, my reports'; a coordinator: only their own). Everyone else gets a request.
  const managed = allActive.filter((u) => canManage(s.user, u.id, s.users));
  const others = allActive.filter((u) => !canManage(s.user, u.id, s.users));
  const [title, setTitle] = useState(existing?.title ?? "");
  const [details, setDetails] = useState(existing?.details ?? "");
  const [assigneeId, setAssigneeId] = useState(existing?.assigneeId ?? defaultAssigneeId);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? defaultDate);
  const [recurring, setRecurring] = useState(forceRecurring);
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [leads, setLeads] = useState(false);
  const [priority, setPriority] = useState<TaskPriority>(existing?.priority ?? "normal");
  const [notifyNow, setNotifyNow] = useState(false);
  const isManager = s.user.role !== "employee" && !isCoordinator(s.user);
  // Recurring tasks are for people whose board you manage (a coordinator manages only their own).
  const canRecur = canManage(s.user, assigneeId, s.users);
  // An instance of a recurring task keeps its person and its date; a task with a manager's reminder stays where it is.
  const instance = !!existing?.recurringId;
  const assigneeLocked = instance || (!!existing?.reminderAt && isCoordinator(s.user) && existing!.assigneeId !== s.user.id);
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
        await api.updateTask(existing.id, { title, details, ...(existing.recurringId ? {} : { dueDate, assigneeId, priority }) });
      } else {
        if (recurring && weekdays.length === 0) throw new Error("יש לבחור לפחות יום אחד");
        await api.createTask({
          title,
          details,
          assigneeId,
          dueDate,
          weekdays: recurring ? weekdays : [],
          kind: recurring && leads ? "leads" : "normal",
          priority: recurring ? "normal" : priority,
          notifyNow: !recurring && isManager && notifyNow && assigneeId !== s.user.id,
        });
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
      <Field label="פירוט">
        <textarea className={inputCls} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={3000} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="איש צוות">
          <select className={inputCls} value={assigneeId} onChange={(e) => setAssigneeId(Number(e.target.value))} disabled={assigneeLocked}>
            {managed.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === s.user.id ? `${u.name} (אני)` : u.name}
              </option>
            ))}
            {others.length > 0 && !recurring && (
              <optgroup label="בקשה לאיש צוות אחר">
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
          <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} required disabled={instance} />
        </Field>
      </div>
      {instance && <p className="text-xs text-slate-500">משימה קבועה: איש הצוות והתאריך נקבעים אוטומטית.</p>}
      {!instance && assigneeLocked && <p className="text-xs text-slate-500">על המשימה יש תזכורת של המנהל, לכן אי אפשר להעביר אותה לאיש צוות אחר.</p>}

      {!recurring && !existing?.recurringId && (
        <fieldset>
          <legend className="mb-1 block text-sm font-semibold text-ink-700">חשיבות</legend>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" data-testid="priority">
            {(["urgent", "high", "normal"] as TaskPriority[]).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={priority === p}
                onClick={() => {
                  setPriority(p);
                  if (p === "urgent" && isManager) setNotifyNow(true);
                }}
                className={`rounded-lg border px-2 py-2 text-sm font-semibold ${
                  priority === p
                    ? p === "urgent"
                      ? "border-red-600 bg-red-600 text-white"
                      : p === "high"
                        ? "border-amber-500 bg-amber-500 text-white"
                        : "border-slate-600 bg-slate-600 text-white"
                    : "border-slate-300 bg-white text-ink-700"
                }`}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">{PRIORITY_HINT[priority]}</p>
        </fieldset>
      )}
      {!existing && !recurring && isManager && assigneeId !== s.user.id && (
        <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={notifyNow} onChange={(e) => setNotifyNow(e.target.checked)} data-testid="notify-now" />
          <span>
            <b>שלח הודעה מיידית</b> ל{s.nameOf(assigneeId)} עם פירוט המשימה (וואטסאפ + התראה), בלי לחכות להודעה המרוכזת.
          </span>
        </label>
      )}
      {!canManage(s.user, assigneeId, s.users) && assigneeId !== s.user.id && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">
          המשימה תופיע אצל {s.nameOf(assigneeId)} כבקשה ממך.
          {!s.canSee(assigneeId) && ' תוכל לעקוב אחרי הסטטוס שלה ב"משימות ששלחתי לאחרים", בלי לראות את שאר הלו"ז.'}
        </p>
      )}
      {!existing && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink-700">
            <input
              type="checkbox"
              className="size-4 accent-brand-600"
              checked={recurring}
              disabled={forceRecurring || !canRecur}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            משימה קבועה (חוזרת כל שבוע)
          </label>
          {!canRecur && <p className="mt-1 text-xs text-slate-500">משימה קבועה אפשר להגדיר רק לעצמך או לאנשי צוות שאתה מנהל.</p>}
          {recurring && (
            <label className="mt-3 flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" className="size-4 accent-brand-600" checked={leads} onChange={(e) => setLeads(e.target.checked)} />
              משימת לידים (בעדכון אפשר לרשום כמות נסלקים ושיחות)
            </label>
          )}
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
