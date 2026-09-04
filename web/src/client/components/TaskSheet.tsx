import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, Deal, Task, TaskEvent, TaskStatus } from "@shared/types";
import { canEditOrDelete, canMarkDone, noteRequiredForInProgress, taskTier } from "@shared/permissions";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Modal, PersonTag, Spinner, StatusBadge, inputCls } from "./ui";
import TaskForm from "./TaskForm";
import { STATUS_LABEL, daysBetween, fmtDateShort, fmtDateTime } from "../format";
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
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealsOpen, setDealsOpen] = useState(false);
  const [calls, setCalls] = useState<string>("");
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (taskId === null) return;
    const res = await api.task(taskId);
    setTask(res.task);
    setEvents(res.events);
    setPhotos(res.attachments);
    setStatus(res.task.status);
    setNote(res.task.status === "in_progress" ? res.task.progressNote : "");
    setDeals(res.task.deals);
    setDealsOpen(res.task.deals.length > 0);
    setCalls(res.task.metricCalls == null ? "" : String(res.task.metricCalls));
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setMode("view");
    setError("");
    setReason("");
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const editable = task ? canEditOrDelete(s.user, task, s.users) : false;
  const canChangeStatus = task ? s.canSee(task.assigneeId) : false;
  const canDone = task ? canMarkDone(s.user, task, s.users) : false;
  const noteRequired = task ? noteRequiredForInProgress(task) : true;
  const tier = task ? taskTier(task, s.users) : 1;
  const cleanDeals = deals.filter((d) => d.name.trim() !== "");
  const metricsDirty = task ? task.kind === "leads" && (JSON.stringify(cleanDeals) !== JSON.stringify(task.deals) || calls !== (task.metricCalls == null ? "" : String(task.metricCalls))) : false;
  const statusDirty = task ? status !== task.status || (status === "in_progress" && note !== task.progressNote) || (status !== "in_progress" && note.trim() !== "") || metricsDirty : false;

  async function saveStatus() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api.setStatus(task.id, status, note, task.kind === "leads" ? { deals: cleanDeals.map((d) => ({ name: d.name.trim(), amount: d.amount })), metricCalls: calls === "" ? null : Number(calls) } : undefined);
      await load();
      setNote(status === "in_progress" ? note : "");
      onChanged();
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
              {task.recurringId && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">משימה קבועה</span>}
              {tier === 0 && task.createdById !== task.assigneeId && <span className="rounded-full bg-ink-900 px-2 py-0.5 text-xs font-semibold text-white">מההנהלה</span>}
              {tier === 2 && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">בקשה מעמית</span>}
              {task.kind === "leads" && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">לידים</span>}
              {task.status !== "done" && daysBetween(task.dueDate, viewDate) > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">נגררת {daysBetween(task.dueDate, viewDate)} ימים</span>
              )}
            </div>
            <h3 className="mt-2 text-xl font-bold text-ink-900">
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
                          {d.name}
                          {d.amount != null && ` · ${d.amount.toLocaleString("he-IL")} ₪`}
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
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">רק {s.nameOf(task.assigneeId)} או המנהל שלו יכולים לעדכן את הסטטוס. אתה יכול לערוך או למחוק את הבקשה.</p>
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
                  {/* TODO(DND CASH): connect closed deals to the DND CASH system */}
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3" data-testid="deals-panel">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink-700">נסלקים{cleanDeals.length > 0 && ` (${cleanDeals.length})`}</span>
                      {!dealsOpen && (
                        <Button
                          variant="secondary"
                          className="px-3 py-1.5"
                          onClick={() => {
                            setDealsOpen(true);
                            if (deals.length === 0) setDeals([{ name: "", amount: null }]);
                          }}
                        >
                          + הוספת נסלק
                        </Button>
                      )}
                    </div>
                    {dealsOpen && (
                      <div className="mt-2 space-y-2">
                        {deals.map((d, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              className={`${inputCls} flex-1`}
                              placeholder="שם לקוח"
                              value={d.name}
                              onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                              data-testid={`deal-name-${i}`}
                            />
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              className={`${inputCls} w-28`}
                              placeholder="סכום ₪"
                              value={d.amount ?? ""}
                              onChange={(e) => setDeals((arr) => arr.map((x, j) => (j === i ? { ...x, amount: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                              data-testid={`deal-amount-${i}`}
                            />
                            <button
                              type="button"
                              className="grid size-9 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-red-600"
                              aria-label="הסרת נסלק"
                              onClick={() => setDeals((arr) => arr.filter((_, j) => j !== i))}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <button type="button" className="text-sm font-semibold text-brand-700" onClick={() => setDeals((arr) => [...arr, { name: "", amount: null }])} data-testid="deal-add">
                          + עוד לקוח
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <ErrorText>{error}</ErrorText>
              <div className="mt-3 flex justify-end">
                <Button onClick={saveStatus} disabled={busy || !statusDirty || (status === "in_progress" && noteRequired && !note.trim())}>
                  {busy ? "שומר..." : "שמירת עדכון"}
                </Button>
              </div>
            </div>
          )}

          <div data-testid="photos">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink-700">תמונות{photos.length > 0 && ` (${photos.length})`}</span>
              {!task.deletedAt && (
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
                  {(lightbox.uploadedById === s.user.id || s.user.role === "admin") && (
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
    default:
      return ev.type;
  }
}
