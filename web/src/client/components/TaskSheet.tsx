import { useCallback, useEffect, useRef, useState } from "react";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, REMINDER_INTERVALS, REMINDER_INTERVAL_LABEL, isStandingOrder, type Attachment, type Deal, type DealDnd, type PaymentMethod, type Task, type TaskEvent, type TaskStatus } from "@shared/types";

type DealDraft = { key?: string; name: string; amount: string; method: PaymentMethod | ""; plusTraining: boolean; months: string; firstDue: string; upfront: string; dnd?: DealDnd };
const EMPTY_DEAL: DealDraft = { name: "", amount: "", method: "", plusTraining: false, months: "", firstDue: "", upfront: "" };
import { canAttachPhoto, canEditOrDelete, canManage, canMarkDone, noteRequiredForInProgress, taskTier } from "@shared/permissions";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Modal, PersonTag, Spinner, StatusBadge, inputCls } from "./ui";
import TaskForm from "./TaskForm";
import { PRIORITY_LABEL, STATUS_LABEL, daysBetween, fmtDateShort, fmtDateTime, fromLocalInput, toLocalInput, DND_STATUS_LABEL } from "../format";
import { makeThumb, prepareImage } from "../image";

interface Props {
  taskId: number | null;
  viewDate: string;
  onClose: () => void;
  onChanged: () => void;
}

export default function TaskSheet({ taskId, viewDate, onClose, onChanged }: Props) {
  const s = useSession();
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [photos, setPhotos] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<TaskStatus>("open");
  const [note, setNote] = useState("");
  const [deals, setDeals] = useState<DealDraft[]>([]);
  const [dealsOpen, setDealsOpen] = useState(false);
  const [calls, setCalls] = useState<string>("");
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderValue, setReminderValue] = useState("");
  const [reminderEvery, setReminderEvery] = useState<number>(30);
  const [nudged, setNudged] = useState(false);
  const [clarifyQ, setClarifyQ] = useState("");
  const [clarified, setClarified] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (taskId === null) return;
    const res = await api.task(taskId);
    if (res.task.id !== taskId) return; // a different task was opened meanwhile
    setTask(res.task);
    setEvents(res.events);
    setPhotos(res.attachments);
    setStatus(res.task.status);
    setNote(res.task.status === "in_progress" ? res.task.progressNote : "");
    setDeals(
      res.task.deals.map((d) => ({
        key: d.key,
        name: d.name,
        amount: d.amount ? String(d.amount) : "",
        method: d.method,
        plusTraining: !!d.plusTraining,
        months: d.months ? String(d.months) : "",
        firstDue: d.firstDue ?? "",
        upfront: d.upfront ? String(d.upfront) : "",
        dnd: d.dnd,
      })),
    );
    setDealsOpen(res.task.deals.length > 0);
    setCalls(res.task.metricCalls == null ? "" : String(res.task.metricCalls));
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setMode("view");
    setError("");
    setReason("");
    setReminderOpen(false);
    setNudged(false);
    setClarified(false);
    setClarifyQ("");
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const editable = task ? canEditOrDelete(s.user, task, s.users) : false;
  const canChangeStatus = task ? canManage(s.user, task.assigneeId, s.users) : false;
  const canDone = task ? canMarkDone(s.user, task, s.users) : false;
  const noteRequired = task ? noteRequiredForInProgress(task) : true;
  const tier = task ? taskTier(task, s.users) : 1;
  const cleanDeals: Deal[] = deals
    .filter((d) => d.name.trim() !== "" || d.amount !== "" || d.method !== "")
    .map((d) => ({
      ...(d.key ? { key: d.key } : {}),
      name: d.name.trim(),
      amount: d.amount === "" ? 0 : Number(d.amount),
      method: d.method,
      plusTraining: d.plusTraining,
      months: isStandingOrder(d.method) && d.months !== "" ? Number(d.months) : null,
      firstDue: isStandingOrder(d.method) && d.firstDue ? d.firstDue : null,
      upfront: isStandingOrder(d.method) && d.upfront !== "" ? Number(d.upfront) : null,
    }));
  const dealsIncomplete = cleanDeals.some((d) => d.name.split(/\s+/).length < 2 || !(d.amount > 0) || !d.method || (isStandingOrder(d.method) && !((d.months ?? 0) >= 1)));
  // What the person can change; the DND CASH state and the row keys are not theirs to edit.
  const shownDeal = (d: Deal) => ({ name: d.name, amount: d.amount, method: d.method, plusTraining: !!d.plusTraining, months: d.months ?? null, firstDue: d.firstDue ?? null, upfront: d.upfront ?? null });
  const canPlusTraining = !!task && s.features.plusTrainingUserIds.includes(task.assigneeId);
  const metricsDirty = task
    ? task.kind === "leads" && (JSON.stringify(cleanDeals.map(shownDeal)) !== JSON.stringify(task.deals.map(shownDeal)) || calls !== (task.metricCalls == null ? "" : String(task.metricCalls)))
    : false;
  const statusDirty = task ? status !== task.status || (status === "in_progress" && note.trim() !== task.progressNote) || (status !== "in_progress" && note.trim() !== "") || metricsDirty : false;

  async function saveStatus() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      if (task.kind === "leads" && dealsIncomplete) throw new Error("לכל נסלק חובה שם מלא, סכום ואמצעי תשלום (ולהוראת קבע גם מספר חודשים)");
      await api.setStatus(task.id, status, note, task.kind === "leads" ? { deals: cleanDeals, metricCalls: calls === "" ? null : Number(calls) } : undefined);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** "Push": send the task to its person again, right now. */
  async function sendNudge() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.nudge(task.id);
      setNudged(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** One tap: make the task urgent (or take the urgency off). */
  async function toggleUrgent() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.updateTask(task.id, { priority: task.priority === "urgent" ? "normal" : "urgent" });
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** "צריך חידוד": ask whoever gave me this task what exactly is wanted. */
  async function sendClarify() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.clarify(task.id, clarifyQ);
      setClarified(true);
      setClarifyQ("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!task || !files || files.length === 0) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files).slice(0, 10)) {
        const img = await prepareImage(file);
        const saved = await api.uploadPhoto(task.id, img.blob, img.name, img.width, img.height);
        const thumb = await makeThumb(img.blob);
        if (thumb) await api.uploadThumb(saved.id, thumb);
      }
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removePhoto(p: Attachment) {
    if (!confirm("למחוק את התמונה?")) return;
    try {
      await api.deletePhoto(p.id);
      setLightbox(null);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveReminder(value: string | null) {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.setReminder(task.id, value ? fromLocalInput(value) : null, reminderEvery);
      await load();
      setReminderOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteTask(task.id, reason);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "edit" ? "עריכת משימה" : mode === "delete" ? "מחיקת משימה" : "פרטי משימה";

  return (
    <Modal open={taskId !== null} onClose={onClose} title={title}>
      {!task ? (
        error ? <ErrorText>{error}</ErrorText> : <Spinner />
      ) : mode === "edit" ? (
        <TaskForm
          defaultAssigneeId={task.assigneeId}
          defaultDate={viewDate}
          existing={task}
          onCancel={() => setMode("view")}
          onSaved={async () => {
            await load();
            setMode("view");
            onChanged();
          }}
        />
      ) : mode === "delete" ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            המשימה <b>{task.title}</b> תימחק. המחיקה נרשמת ביומן הפעילות יחד עם הסיבה.
          </p>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">סיבת המחיקה (חובה)</span>
            <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode("view")}>ביטול</Button>
            <Button variant="danger" onClick={doDelete} disabled={busy || reason.trim().length < 2}>
              {busy ? "מוחק..." : "מחיקה"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {task.status === "done" && task.completedDate && task.completedDate > viewDate && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              ביום שנבחר המשימה עדיין לא הושלמה. היא הושלמה ב-{fmtDateShort(task.completedDate)}.
            </div>
          )}
          {task.deletedAt && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <b>המשימה נמחקה</b> על ידי {s.nameOf(task.deletedById)} ב-{fmtDateTime(task.deletedAt)}.
              <br />
              סיבה: {task.deleteReason}
            </div>
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={task.status} />
              {task.priority === "urgent" && <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">{PRIORITY_LABEL.urgent}</span>}
              {task.priority === "high" && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">{PRIORITY_LABEL.high}</span>}
              {task.recurringId && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">משימה קבועה</span>}
              {tier === 0 && task.createdById !== task.assigneeId && <span className="rounded-full bg-ink-900 px-2 py-0.5 text-xs font-semibold text-white">מההנהלה</span>}
              {tier === 2 && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">בקשה מעמית</span>}
              {task.kind === "leads" && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">לידים</span>}
              {task.status !== "done" && daysBetween(task.dueDate, viewDate) > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">נגררת {daysBetween(task.dueDate, viewDate)} ימים</span>
              )}
            </div>
            <h3 className={`mt-2 text-xl text-ink-900 ${task.priority === "normal" ? "font-bold" : "font-black"}`}>
              {task.title}
              {task.createdById !== task.assigneeId && (
                <>
                  {" "}
                  <PersonTag userId={task.createdById} users={s.users} />
                </>
              )}
            </h3>
            {task.details && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{task.details}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
              <dt>איש צוות</dt>
              <dd className="font-semibold text-ink-700">{s.nameOf(task.assigneeId)}</dd>
              <dt>נוסף על ידי</dt>
              <dd className="font-semibold text-ink-700">
                {s.nameOf(task.createdById)} · {fmtDateTime(task.createdAt)}
              </dd>
              <dt>תאריך יעד</dt>
              <dd className="font-semibold text-ink-700">{fmtDateShort(task.dueDate)}</dd>
              {task.completedAt && (
                <>
                  <dt>הושלם</dt>
                  <dd className="font-semibold text-brand-700">
                    {s.nameOf(task.completedById)} · {fmtDateTime(task.completedAt)}
                  </dd>
                </>
              )}
            </dl>
            {task.kind === "leads" && (task.deals.length > 0 || task.metricCalls != null) && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                {task.metricCalls != null && <div>שיחות: <b>{task.metricCalls}</b></div>}
                {task.deals.length > 0 && (
                  <div>
                    נסלקים: <b>{task.deals.length}</b>
                    <ul className="mt-1 list-disc ps-5 text-xs">
                      {task.deals.map((d, i) => (
                        <li key={i}>
                          {d.name} · {d.amount.toLocaleString("he-IL")} ₪{d.method && ` · ${PAYMENT_METHOD_LABEL[d.method]}`}
                          {d.months ? ` · ${d.months} חודשים` : ""}
                          {d.plusTraining ? " · מכירה + אימון" : ""}
                          {d.dnd && <span className={d.dnd.status === "sent" ? "text-emerald-700" : d.dnd.status === "error" ? "text-red-600" : "text-slate-500"}> · {DND_STATUS_LABEL[d.dnd.status]}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {task.status === "in_progress" && task.progressNote && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
                <span className="block text-xs font-semibold text-amber-800">מה בוצע ומה נשאר</span>
                <p className="mt-0.5 whitespace-pre-wrap text-amber-900">{task.progressNote}</p>
              </div>
            )}
          </div>

          {!task.deletedAt && !canChangeStatus && (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">רק {s.nameOf(task.assigneeId)} או המנהל שלו יכולים לעדכן את הסטטוס.{editable ? " אתה יכול לערוך או למחוק את הבקשה." : ""}</p>
          )}
          {!task.deletedAt && canChangeStatus && task.status === "done" && !canDone && (
            <p className="rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700">המשימה סומנה כהושלמה על ידי {s.nameOf(task.completedById)}. רק המנהל יכול לפתוח אותה מחדש.</p>
          )}
          {!task.deletedAt && canChangeStatus && !(task.status === "done" && !canDone) && (
            <div className="rounded-xl border border-slate-200 p-3">
              <span className="mb-2 block text-sm font-semibold text-ink-700">עדכון סטטוס</span>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup">
                {(["open", "in_progress", "done"] as TaskStatus[]).map((st) => (
                  <button
                    key={st}
                    type="button"
                    role="radio"
                    aria-checked={status === st}
                    disabled={st === "done" && !canDone}
                    title={st === "done" && !canDone ? "רק המנהל מסמן הושלם" : undefined}
                    onClick={() => setStatus(st)}
                    className={`rounded-lg border px-2 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                      status === st
                        ? st === "done"
                          ? "border-brand-600 bg-brand-600 text-white"
                          : st === "in_progress"
                            ? "border-amber-500 bg-amber-500 text-white"
                            : "border-slate-600 bg-slate-600 text-white"
                        : "border-slate-300 bg-white text-ink-700"
                    }`}
                  >
                    {STATUS_LABEL[st]}
                  </button>
                ))}
              </div>
              {!canDone && task.status !== "done" && (
                <p className="mt-2 text-xs text-slate-500">"הושלם" על משימה שניתנה על ידי {s.nameOf(task.createdById)} מסמן רק המנהל. כשסיימת, סמן "בתהליך" וכתוב שבוצע.</p>
              )}
              <label className="mt-3 block">
                <span className="mb-1 block text-sm font-semibold text-ink-700">
                  {status === "in_progress" ? (noteRequired ? "מה בוצע ומה נשאר? (חובה)" : "מה בוצע ומה נשאר?") : status === "done" ? "הערת סיום" : "הערה"}
                </span>
                <textarea
                  className={inputCls}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={status === "in_progress" ? "למשל: דיברתי עם 3 מתוך 5 לידים, נשארו 2 למחר" : ""}
                />
              </label>
              {task.kind === "leads" && (
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-sm font-semibold text-ink-700">כמות שיחות</span>
                    <input type="number" inputMode="numeric" min={0} step={1} className={inputCls} value={calls} onChange={(e) => setCalls(e.target.value)} data-testid="metric-calls" />
                  </label>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3" data-testid="deals-panel">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink-700">נסלקים{cleanDeals.length > 0 && ` (${cleanDeals.length})`}</span>
                      {!dealsOpen && (
                        <Button
                          variant="secondary"
                          className="px-3 py-1.5"
                          onClick={() => {
                            setDealsOpen(true);
                            if (deals.length === 0) setDeals([{ ...EMPTY_DEAL }]);
                          }}
                        >
                          + הוספת נסלק
                        </Button>
                      )}
                    </div>
                    {dealsOpen && (
                      <div className="mt-2 space-y-3">
                        {deals.map((d, i) => (
                          <div key={i} className="rounded-xl border border-emerald-200 bg-white p-2">
                            <div className="flex items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <input
                                  className={inputCls}
                                  placeholder="שם מלא של הלקוח"
                                  value={d.name}
                                  onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                                  data-testid={`deal-name-${i}`}
                                />
                              </div>
                              <div className="w-28 shrink-0">
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={1}
                                  className={inputCls}
                                  placeholder="סכום ₪"
                                  value={d.amount}
                                  onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                                  data-testid={`deal-amount-${i}`}
                                />
                              </div>
                              <button
                                type="button"
                                className="grid size-9 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-red-600"
                                aria-label="הסרת נסלק"
                                onClick={() => setDeals((arr) => arr.filter((_, j) => j !== i))}
                              >
                                ✕
                              </button>
                            </div>
                            <select
                              className={`${inputCls} mt-2`}
                              value={d.method}
                              onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, method: e.target.value as PaymentMethod | "" } : x)))}
                              data-testid={`deal-method-${i}`}
                            >
                              <option value="">אמצעי תשלום...</option>
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {PAYMENT_METHOD_LABEL[m]}
                                </option>
                              ))}
                            </select>
                            {isStandingOrder(d.method) && (
                              <div className="mt-2" data-testid={`deal-so-${i}`}>
                                <div className="grid grid-cols-3 gap-2">
                                  <label className="block text-xs font-semibold text-slate-600">
                                    מספר חודשים
                                    <input
                                      type="number"
                                      inputMode="numeric"
                                      min={1}
                                      max={120}
                                      className={`${inputCls} mt-1`}
                                      value={d.months}
                                      onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, months: e.target.value } : x)))}
                                      data-testid={`deal-months-${i}`}
                                    />
                                  </label>
                                  <label className="block text-xs font-semibold text-slate-600">
                                    מקדמה ₪
                                    <input
                                      type="number"
                                      inputMode="decimal"
                                      min={0}
                                      className={`${inputCls} mt-1`}
                                      value={d.upfront}
                                      onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, upfront: e.target.value } : x)))}
                                      data-testid={`deal-upfront-${i}`}
                                    />
                                  </label>
                                  <label className="block text-xs font-semibold text-slate-600">
                                    תשלום ראשון
                                    <input
                                      type="date"
                                      className={`${inputCls} mt-1`}
                                      value={d.firstDue}
                                      onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, firstDue: e.target.value } : x)))}
                                      data-testid={`deal-firstdue-${i}`}
                                    />
                                  </label>
                                </div>
                                {Number(d.amount) > 0 && Number(d.months) >= 1 && (
                                  <p className="mt-1 text-xs text-slate-500">
                                    {Number(d.months)} תשלומים של {Math.round((Number(d.amount) - (Number(d.upfront) || 0)) / Number(d.months)).toLocaleString("he-IL")} ₪
                                    {d.firstDue ? "" : " · התשלום הראשון בתאריך המשימה"}
                                  </p>
                                )}
                              </div>
                            )}
                            {canPlusTraining && (
                              <label className="mt-2 block text-xs font-semibold text-slate-600">
                                סוג עסקה
                                <select
                                  className={`${inputCls} mt-1`}
                                  value={d.plusTraining ? "plus" : "sales"}
                                  onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, plusTraining: e.target.value === "plus" } : x)))}
                                  data-testid={`deal-plus-${i}`}
                                >
                                  <option value="sales">מכירה בלבד (10%)</option>
                                  <option value="plus">מכירה + אימון (20%)</option>
                                </select>
                              </label>
                            )}
                            {d.dnd && (
                              <p className={`mt-1 text-xs ${d.dnd.status === "sent" ? "text-emerald-700" : d.dnd.status === "error" ? "text-red-600" : "text-slate-500"}`} data-testid={`deal-dnd-${i}`}>
                                {DND_STATUS_LABEL[d.dnd.status]}
                                {d.dnd.error ? ` · ${d.dnd.error}` : ""}
                                {d.dnd.stale ? " · שונה אחרי השליחה, לעדכן ידנית ב-DND CASH" : ""}
                              </p>
                            )}
                          </div>
                        ))}
                        {dealsIncomplete && <p className="text-xs text-red-600">לכל נסלק חובה שם מלא, סכום ואמצעי תשלום. להוראת קבע גם מספר חודשים.</p>}
                        <button type="button" className="text-sm font-semibold text-brand-700" onClick={() => setDeals((arr) => [...arr, { ...EMPTY_DEAL }])} data-testid="deal-add">
                          + עוד לקוח
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <ErrorText>{error}</ErrorText>
              <div className="mt-3 flex justify-end">
                <Button onClick={saveStatus} disabled={busy || !statusDirty || (status === "in_progress" && noteRequired && !note.trim()) || (task.kind === "leads" && dealsIncomplete)}>
                  {busy ? "שומר..." : "שמירת עדכון"}
                </Button>
              </div>
            </div>
          )}

          {!task.deletedAt && task.status !== "done" && task.assigneeId !== s.user.id && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3" data-testid="nudge">
              <span className="text-sm text-ink-700">🔔 לשלוח ל{s.nameOf(task.assigneeId)} את המשימה שוב עכשיו</span>
              <Button variant="secondary" className="px-3 py-1.5" disabled={busy || nudged} onClick={sendNudge} data-testid="nudge-button">
                {nudged ? "נשלח ✓" : "פוש"}
              </Button>
            </div>
          )}

          {!task.deletedAt && task.status !== "done" && editable && !task.recurringId && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50/50 p-3" data-testid="urgent">
              <span className="text-sm text-ink-700">{task.priority === "urgent" ? "🚨 המשימה מסומנת כדחופה" : "🚨 לסמן כדחופה – עולה לראש הרשימה ומי שהמשימה שלו מקבל הודעה"}</span>
              <Button variant="secondary" className="shrink-0 px-3 py-1.5" disabled={busy} onClick={toggleUrgent} data-testid="urgent-toggle">
                {task.priority === "urgent" ? "בטל דחיפות" : "הפוך לדחופה"}
              </Button>
            </div>
          )}

          {!task.deletedAt && task.status !== "done" && task.assigneeId === s.user.id && task.createdById !== s.user.id && (
            <div className="rounded-xl border border-purple-200 bg-purple-50/50 p-3" data-testid="clarify">
              <div className="text-sm text-ink-700">❓ לא בטוח מה בדיוק צריך? {s.nameOf(task.createdById)} יקבל הודעה שצריך חידוד.</div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  className={inputCls}
                  placeholder="מה לא ברור? (לא חובה)"
                  value={clarifyQ}
                  onChange={(e) => setClarifyQ(e.target.value)}
                  maxLength={500}
                  disabled={busy || clarified}
                  data-testid="clarify-text"
                />
                <Button variant="secondary" className="shrink-0 px-3 py-1.5" disabled={busy || clarified} onClick={sendClarify} data-testid="clarify-button">
                  {clarified ? "נשלח ✓" : "צריך חידוד"}
                </Button>
              </div>
            </div>
          )}

          {!task.deletedAt && task.status !== "done" && canChangeStatus && (
            <div className="rounded-xl border border-slate-200 p-3" data-testid="reminder">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink-700">
                  ⏰ תזכורת
                  {task.reminderAt && (
                    <span className="ms-2 text-xs font-normal text-slate-600">
                      ל-{fmtDateTime(task.reminderAt)}, ואז כל {REMINDER_INTERVAL_LABEL[task.reminderEveryMin ?? 30] ?? `${task.reminderEveryMin} דקות`} עד שמסמנים הושלם
                    </span>
                  )}
                </span>
                {!reminderOpen && (
                  <div className="flex gap-1">
                    {task.reminderAt && (
                      <Button variant="ghost" className="px-2 py-1.5 text-red-700" onClick={() => saveReminder(null)} disabled={busy}>
                        ביטול
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      className="px-3 py-1.5"
                      onClick={() => {
                        setReminderValue(task.reminderAt ? toLocalInput(task.reminderAt) : toLocalInput(new Date(Date.now() + 60 * 60 * 1000).toISOString()));
                        setReminderEvery(task.reminderEveryMin ?? 30);
                        setReminderOpen(true);
                      }}
                    >
                      {task.reminderAt ? "שינוי" : "הוספת תזכורת"}
                    </Button>
                  </div>
                )}
              </div>
              {reminderOpen && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="block flex-1">
                    <span className="mb-1 block text-xs font-semibold text-slate-600">מתי לעשות / מתי להמשיך</span>
                    <input type="datetime-local" className={inputCls} value={reminderValue} onChange={(e) => setReminderValue(e.target.value)} data-testid="reminder-input" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-slate-600">ואז להזכיר שוב כל</span>
                    <select className={inputCls} value={reminderEvery} onChange={(e) => setReminderEvery(Number(e.target.value))} data-testid="reminder-every">
                      {REMINDER_INTERVALS.map((m) => (
                        <option key={m} value={m}>
                          {REMINDER_INTERVAL_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button onClick={() => saveReminder(reminderValue)} disabled={busy || !reminderValue}>
                    שמירה
                  </Button>
                  <Button variant="ghost" onClick={() => setReminderOpen(false)}>
                    ביטול
                  </Button>
                </div>
              )}
            </div>
          )}

          <div data-testid="photos">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink-700">תמונות{photos.length > 0 && ` (${photos.length})`}</span>
              {!task.deletedAt && canAttachPhoto(s.user, task, s.users) && (
                <>
                  <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} data-testid="photo-input" />
                  <Button variant="secondary" className="px-3 py-1.5" onClick={() => fileInput.current?.click()} disabled={uploading}>
                    {uploading ? "מעלה..." : "📷 צילום / העלאת תמונה"}
                  </Button>
                </>
              )}
            </div>
            {photos.length === 0 ? (
              <p className="text-xs text-slate-400">אין תמונות עדיין</p>
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setLightbox(p)} className="block aspect-square w-full overflow-hidden rounded-xl bg-slate-100" aria-label={`תמונה: ${p.fileName}`}>
                      <img
                        src={`/api/photos/${p.id}?thumb=1`}
                        alt={p.fileName}
                        loading="lazy"
                        className="size-full object-cover"
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (!img.dataset.retried) {
                            img.dataset.retried = "1";
                            window.setTimeout(() => (img.src = `/api/photos/${p.id}?r=${Date.now()}`), 1500);
                          }
                        }}
                      />
                    </button>
                    <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                      {s.nameOf(p.uploadedById)} · {fmtDateTime(p.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {lightbox && (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black/90" onClick={() => setLightbox(null)} role="dialog" aria-label="תצוגת תמונה">
              <div className="flex items-center justify-between p-3 text-white" onClick={(e) => e.stopPropagation()}>
                <span className="truncate text-sm">
                  {lightbox.fileName} · {s.nameOf(lightbox.uploadedById)} · {fmtDateTime(lightbox.createdAt)}
                </span>
                <div className="flex shrink-0 gap-2">
                  {(s.user.role === "admin" || (lightbox.uploadedById === s.user.id && canAttachPhoto(s.user, task, s.users))) && (
                    <button className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold" onClick={() => removePhoto(lightbox)}>
                      מחיקה
                    </button>
                  )}
                  <button className="rounded-lg bg-white/20 px-3 py-1.5 text-sm font-semibold" onClick={() => setLightbox(null)}>
                    סגירה
                  </button>
                </div>
              </div>
              <img src={`/api/photos/${lightbox.id}`} alt={lightbox.fileName} className="min-h-0 flex-1 object-contain p-2" />
            </div>
          )}

          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-700">היסטוריה</span>
            <ol className="space-y-2 border-s-2 border-slate-200 ps-3">
              {events.map((ev) => (
                <li key={ev.id} className="text-xs">
                  <span className="text-slate-500">{fmtDateTime(ev.createdAt)}</span>
                  <span className="mx-1 text-slate-400">·</span>
                  <b className="text-ink-800">{s.nameOf(ev.actorId)}</b>
                  <span className="mx-1 text-slate-400">·</span>
                  <span className="text-ink-700">{eventText(ev)}</span>
                  {ev.note && <p className="mt-0.5 whitespace-pre-wrap rounded-lg bg-slate-50 px-2 py-1 text-slate-700">{ev.note}</p>}
                </li>
              ))}
            </ol>
          </div>

          {!task.deletedAt && editable && (
            <div className="flex justify-between gap-2 border-t border-slate-200 pt-3">
              <Button variant="danger" onClick={() => setMode("delete")}>מחיקה</Button>
              <Button variant="secondary" onClick={() => setMode("edit")}>עריכה</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function eventText(ev: TaskEvent): string {
  switch (ev.type) {
    case "created":
      return "נוצרה";
    case "status":
      return `${STATUS_LABEL[ev.fromStatus ?? "open"]} ← ${STATUS_LABEL[ev.toStatus ?? "open"]}`;
    case "note":
      return "עדכון פירוט";
    case "edited":
      return "נערכה";
    case "reassigned":
      return "הועברה";
    case "deleted":
      return "נמחקה";
    case "photo":
      return "הוסיף תמונה";
    case "photo_removed":
      return "מחק תמונה";
    case "reminder":
      return "תזכורת";
    case "clarify":
      return "ביקש חידוד";
    default:
      return ev.type;
  }
}
