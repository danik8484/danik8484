import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PublicUser, Task } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Modal, PersonTag, Spinner, StatusIcon } from "../components/ui";
import TaskForm from "../components/TaskForm";
import TaskSheet from "../components/TaskSheet";
import { PushBanner } from "../components/PushSettings";
import { PRIORITY_ORDER, ROLE_LABEL, addDays, daysBetween, fmtDateLong, fmtDateShort, isoValid } from "../format";
import { taskTier } from "@shared/permissions";

export default function Board() {
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const date = isoValid(params.get("date")) ? (params.get("date") as string) : s.today;
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [upcoming, setUpcoming] = useState<Task[]>([]);
  const [sent, setSent] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const [addFor, setAddFor] = useState<number | null>(null);
  const [openTask, setOpenTask] = useState<number | null>(() => {
    // Deep link from notifications: /?task=123
    const t = Number(new URLSearchParams(window.location.search).get("task"));
    return Number.isInteger(t) && t > 0 ? t : null;
  });
  const [showUpcoming, setShowUpcoming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.board(date);
      setTasks(res.tasks);
      setUpcoming(res.upcoming);
      setSent(res.sent);
      setError("");
      // The phone may stay open past midnight: follow the server's "today".
      if (res.today !== s.today) s.refresh().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [date, s]);

  useEffect(() => {
    setTasks(null);
    load();
  }, [load]);

  // Refresh when the tab regains focus and every 60 seconds while visible,
  // so a manager's board follows the team's updates without reloading.
  useEffect(() => {
    const onFocus = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [load]);

  const setDate = (d: string) => setParams(d === s.today ? {} : { date: d });

  // When looking at a past day, show each task as it was on that day:
  // a task completed later is still "open" on that day's view.
  const asOf = useMemo(() => (tasks ?? []).map((t) => (t.status === "done" && t.completedDate && t.completedDate > date ? { ...t, status: "open" as const } : t)), [tasks, date]);

  const byUser = useMemo(() => {
    const m = new Map<number, Task[]>();
    for (const t of asOf) {
      if (!m.has(t.assigneeId)) m.set(t.assigneeId, []);
      m.get(t.assigneeId)!.push(t);
    }
    return m;
  }, [asOf]);

  const orderedUsers = useMemo(() => {
    // Deactivated teammates keep a card only while they still have tasks on this day, so nothing gets lost.
    const shown = s.users.filter((u) => u.active || (byUser.get(u.id)?.length ?? 0) > 0);
    const mine = shown.filter((u) => u.id === s.user.id);
    const visible = shown.filter((u) => u.id !== s.user.id && s.canSee(u.id));
    const hidden = shown.filter((u) => !s.canSee(u.id));
    return [...mine, ...visible, ...hidden];
  }, [s, byUser]);

  const summary = useMemo(() => {
    const done = asOf.filter((t) => t.status === "done").length;
    const inProgress = asOf.filter((t) => t.status === "in_progress").length;
    const open = asOf.filter((t) => t.status === "open").length;
    const overdue = asOf.filter((t) => t.status !== "done" && daysBetween(t.dueDate, date) > 0).length;
    return { done, inProgress, open, overdue, total: asOf.length };
  }, [asOf, date]);

  const isToday = date === s.today;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2 rounded-2xl bg-white p-2 shadow-sm">
        <button onClick={() => setDate(addDays(date, -1))} className="grid size-10 place-items-center rounded-xl hover:bg-slate-100" aria-label="יום קודם">
          <Chevron dir="right" />
        </button>
        <div className="text-center">
          <div className="text-base font-bold text-ink-900">{fmtDateLong(date)}</div>
          <div className="text-xs text-slate-500">
            {isToday ? "היום" : daysBetween(date, s.today) > 0 ? `לפני ${daysBetween(date, s.today)} ימים` : `בעוד ${daysBetween(s.today, date)} ימים`}
            {!isToday && (
              <button onClick={() => setDate(s.today)} className="ms-2 font-semibold text-brand-700 underline">
                חזרה להיום
              </button>
            )}
          </div>
        </div>
        <button onClick={() => setDate(addDays(date, 1))} className="grid size-10 place-items-center rounded-xl hover:bg-slate-100" aria-label="יום הבא">
          <Chevron dir="left" />
        </button>
      </div>

      <PushBanner />
      {tasks !== null && s.visibleUserIds.length > 1 && summary.total > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-white px-3 py-2 text-xs shadow-sm" data-testid="summary">
          <span className="font-bold text-ink-800">סיכום היום</span>
          <span className="text-brand-700">
            <b>{summary.done}</b> הושלמו
          </span>
          <span className="text-amber-800">
            <b>{summary.inProgress}</b> בתהליך
          </span>
          <span className="text-slate-700">
            <b>{summary.open}</b> פתוחות
          </span>
          {summary.overdue > 0 && (
            <span className="text-red-600">
              <b>{summary.overdue}</b> נגררות
            </span>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {tasks === null && !error ? (
        <Spinner />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {orderedUsers.map((u) => (
            <UserCard
              key={u.id}
              user={u}
              tasks={byUser.get(u.id) ?? []}
              viewDate={date}
              visible={s.canSee(u.id)}
              onAdd={() => setAddFor(u.id)}
              onOpen={setOpenTask}
            />
          ))}
        </div>
      )}

      {sent.length > 0 && (
        <div className="mt-4 rounded-2xl bg-white p-3 shadow-sm" data-testid="sent">
          <h2 className="text-sm font-bold text-ink-800">משימות ששלחתי לאחרים ({sent.length})</h2>
          <p className="mb-1 text-xs text-slate-500">בקשות שהוספת לאנשי צוות שהלו"ז שלהם לא חשוף לך. רואים רק את הסטטוס של הבקשה עצמה.</p>
          <ul className="divide-y divide-slate-100">
            {sent.map((t) => (
              <li key={t.id}>
                <button onClick={() => setOpenTask(t.id)} className="flex w-full items-center gap-3 py-2 text-start" data-testid={`task-${t.id}`}>
                  <StatusIcon status={t.status} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${t.status === "done" ? "text-slate-400 line-through" : "text-ink-900"}`}>{t.title}</span>
                    <span className="block text-xs text-slate-500">
                      ל<PersonTag userId={t.assigneeId} users={s.users} /> · {fmtDateShort(t.dueDate)}
                      {t.status === "in_progress" && t.progressNote && <span className="text-amber-800"> · {t.progressNote}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="mt-4 rounded-2xl bg-white p-3 shadow-sm">
          <button className="flex w-full items-center justify-between text-sm font-bold text-ink-800" onClick={() => setShowUpcoming((v) => !v)}>
            <span>משימות עתידיות ({upcoming.length})</span>
            <span className="text-slate-400">{showUpcoming ? "▲" : "▼"}</span>
          </button>
          {showUpcoming && (
            <ul className="mt-2 divide-y divide-slate-100">
              {upcoming.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setOpenTask(t.id)} className="flex w-full items-center gap-3 py-2 text-start" data-testid={`task-${t.id}`}>
                    <StatusIcon status={t.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink-900">{t.title}</span>
                      <span className="block text-xs text-slate-500">
                        <PersonTag userId={t.assigneeId} users={s.users} /> · {fmtDateShort(t.dueDate)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        onClick={() => setAddFor(s.user.id)}
        className="fixed bottom-5 end-5 z-30 flex h-14 items-center gap-2 rounded-full bg-brand-600 px-5 text-base font-bold text-white shadow-lg hover:bg-brand-700 active:scale-95"
        aria-label="הוספת משימה"
      >
        <span className="text-2xl leading-none">+</span> משימה
      </button>

      <Modal open={addFor !== null} onClose={() => setAddFor(null)} title="משימה חדשה">
        {addFor !== null && (
          <TaskForm
            defaultAssigneeId={addFor}
            defaultDate={date < s.today ? s.today : date}
            onCancel={() => setAddFor(null)}
            onSaved={() => {
              setAddFor(null);
              load();
            }}
          />
        )}
      </Modal>

      <TaskSheet taskId={openTask} viewDate={date} onClose={() => setOpenTask(null)} onChanged={load} />
    </div>
  );
}

function UserCard({
  user,
  tasks,
  viewDate,
  visible,
  onAdd,
  onOpen,
}: {
  user: PublicUser;
  tasks: Task[];
  viewDate: string;
  visible: boolean;
  onAdd: () => void;
  onOpen: (id: number) => void;
}) {
  const s = useSession();
  const isMe = user.id === s.user.id;
  const open = tasks.filter((t) => t.status === "open");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const done = tasks.filter((t) => t.status === "done");
  const byPriority = (a: Task, b: Task) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  const active = [...inProgress, ...open];
  // Urgent tasks always come first, whoever added them; then management, own, and requests from teammates,
  // each group with high priority before normal.
  const urgent = active.filter((t) => t.priority === "urgent");
  const rest = active.filter((t) => t.priority !== "urgent");
  const fromManagement = rest.filter((t) => taskTier(t, s.users) === 0).sort(byPriority);
  const own = rest.filter((t) => taskTier(t, s.users) === 1).sort(byPriority);
  const fromPeers = rest.filter((t) => taskTier(t, s.users) === 2).sort(byPriority);
  const showHeaders = [fromManagement, own, fromPeers].filter((g) => g.length > 0).length > 1;

  return (
    <section className={`rounded-2xl bg-white shadow-sm ${isMe ? "ring-2 ring-brand-500" : ""}`} data-testid={`card-${user.id}`} aria-label={user.name}>
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`grid size-9 place-items-center rounded-full text-sm font-bold ${isMe ? "bg-brand-500 text-white" : "bg-slate-200 text-ink-800"}`}>
            {user.name.slice(0, 1)}
          </span>
          <div>
            <div className="text-sm font-bold text-ink-900">
              {user.name}
              {isMe && <span className="ms-1 text-xs font-normal text-slate-500">(אני)</span>}
            </div>
            <div className="text-xs text-slate-500">
              {ROLE_LABEL[user.role]}
              {!user.active && <span className="ms-1 font-semibold text-red-600">· מושבת</span>}
            </div>
          </div>
        </div>
        {visible ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="rounded-full bg-brand-100 px-2 py-0.5 font-semibold text-brand-700" title="הושלמו">
              ✓ {done.length}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800" title="בתהליך">
              {inProgress.length}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700" title="פתוחות">
              {open.length}
            </span>
          </div>
        ) : (
          <span className="text-slate-400" title="אין הרשאת צפייה">🔒</span>
        )}
      </header>

      {!visible && (
        <div className="relative px-3 py-3">
          <ul className="blurred space-y-2" aria-hidden="true">
            {[80, 60, 70].map((w, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="size-6 rounded-full border-2 border-slate-300" />
                <span className="h-3 rounded bg-slate-300" style={{ width: `${w}%` }} />
              </li>
            ))}
          </ul>
          <p className="absolute inset-0 grid place-items-center text-xs font-semibold text-slate-500">הלו"ז של {user.name} אינו חשוף לך</p>
        </div>
      )}
      {!visible && (
        <div className="px-2 pb-1">
          <Button variant="ghost" className="w-full text-brand-700" onClick={onAdd}>
            + בקשת משימה מ{user.name}
          </Button>
        </div>
      )}
      {visible && (
        <div className="px-1 py-1">
          {tasks.length === 0 && <p className="px-3 py-4 text-center text-sm text-slate-400">אין משימות ליום זה</p>}
          {urgent.length > 0 && (
            <ul className="mx-1 mb-1 rounded-xl border border-red-200 bg-red-50/60" data-testid={`group-urgent-${user.id}`}>
              {urgent.map((t) => (
                <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
              ))}
            </ul>
          )}
          {fromManagement.length > 0 && (
            <>
              {showHeaders && <GroupHeader>מההנהלה</GroupHeader>}
              <ul data-testid={`group-management-${user.id}`}>
                {fromManagement.map((t) => (
                  <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
          {own.length > 0 && (
            <>
              {showHeaders && <GroupHeader>{isMe ? "שלי" : `של ${user.name}`}</GroupHeader>}
              <ul data-testid={`group-own-${user.id}`}>
                {own.map((t) => (
                  <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
          {fromPeers.length > 0 && (
            <>
              <div className="mx-3 mt-1 border-t border-dashed border-violet-200" />
              <GroupHeader className="text-violet-700">בקשות מאנשי צוות אחרים</GroupHeader>
              <ul data-testid={`group-peers-${user.id}`}>
                {fromPeers.map((t) => (
                  <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
          {done.length > 0 && (
            <>
              {active.length > 0 && <div className="mx-3 my-1 border-t border-dashed border-slate-200" />}
              <ul>
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
          <div className="px-2 pb-1 pt-1">
            <Button variant="ghost" className="w-full text-brand-700" onClick={onAdd}>
              + הוספת משימה ל{isMe ? "עצמי" : user.name}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function GroupHeader({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-3 pb-0.5 pt-2 text-[11px] font-bold uppercase tracking-wide text-slate-400 ${className}`}>{children}</div>;
}

function TaskRow({ task, viewDate, onOpen }: { task: Task; viewDate: string; onOpen: (id: number) => void }) {
  const s = useSession();
  const overdue = task.status !== "done" ? daysBetween(task.dueDate, viewDate) : 0;
  const byOther = task.createdById !== task.assigneeId;
  return (
    <li>
      <button onClick={() => onOpen(task.id)} className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-start hover:bg-slate-50" data-testid={`task-${task.id}`}>
        <span className="pt-0.5">
          <StatusIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-sm ${task.status === "done" ? "font-semibold text-slate-400 line-through" : task.priority === "urgent" ? "font-black text-red-700" : task.priority === "high" ? "font-extrabold text-ink-900" : "font-semibold text-ink-900"}`}
          >
            {task.priority === "urgent" && task.status !== "done" && <span aria-label="דחוף">🚨 </span>}
            {task.priority === "high" && task.status !== "done" && <span aria-label="עדיפות גבוהה">⬆️ </span>}
            {task.title}
            {byOther && (
              <>
                {" "}
                <PersonTag userId={task.createdById} users={s.users} />
              </>
            )}
          </span>
          {task.status === "in_progress" && task.progressNote && <span className="mt-0.5 line-clamp-2 block text-xs text-amber-800">{task.progressNote}</span>}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            {task.recurringId && <span className="text-sky-700">קבועה</span>}
            {!!task.photoCount && <span title="תמונות">📷 {task.photoCount}</span>}
            {task.kind === "leads" && (task.metricDeals != null || task.metricCalls != null) && (
              <span className="font-semibold text-emerald-700">
                {task.metricDeals != null && `נסלקים: ${task.metricDeals}`}
                {task.metricDeals != null && task.metricCalls != null && " · "}
                {task.metricCalls != null && `שיחות: ${task.metricCalls}`}
              </span>
            )}
            {overdue > 0 && <span className="font-semibold text-red-600">נגררת {overdue} ימים</span>}
            {task.status === "done" && task.completedAt && <span className="text-brand-700">הושלם {new Date(task.completedAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "right" ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
    </svg>
  );
}
