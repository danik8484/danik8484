import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PublicUser, Task } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Modal, Spinner, StatusIcon } from "../components/ui";
import TaskForm from "../components/TaskForm";
import TaskSheet from "../components/TaskSheet";
import { ROLE_LABEL, addDays, daysBetween, fmtDateLong, fmtDateShort, isoValid } from "../format";

export default function Board() {
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const date = isoValid(params.get("date")) ? (params.get("date") as string) : s.today;
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [upcoming, setUpcoming] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const [addFor, setAddFor] = useState<number | null>(null);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [showUpcoming, setShowUpcoming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.board(date);
      setTasks(res.tasks);
      setUpcoming(res.upcoming);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [date]);

  useEffect(() => {
    setTasks(null);
    load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const setDate = (d: string) => setParams(d === s.today ? {} : { date: d });

  const orderedUsers = useMemo(() => {
    const active = s.users.filter((u) => u.active);
    const mine = active.filter((u) => u.id === s.user.id);
    const visible = active.filter((u) => u.id !== s.user.id && s.canSee(u.id));
    const hidden = active.filter((u) => !s.canSee(u.id));
    return [...mine, ...visible, ...hidden];
  }, [s]);

  const byUser = useMemo(() => {
    const m = new Map<number, Task[]>();
    for (const t of tasks ?? []) {
      if (!m.has(t.assigneeId)) m.set(t.assigneeId, []);
      m.get(t.assigneeId)!.push(t);
    }
    return m;
  }, [tasks]);

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
                  <button onClick={() => setOpenTask(t.id)} className="flex w-full items-center gap-3 py-2 text-start">
                    <StatusIcon status={t.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink-900">{t.title}</span>
                      <span className="block text-xs text-slate-500">
                        {s.nameOf(t.assigneeId)} · {fmtDateShort(t.dueDate)}
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
  const active = [...inProgress, ...open];

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
            <div className="text-xs text-slate-500">{ROLE_LABEL[user.role]}</div>
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

      {!visible ? (
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
      ) : (
        <div className="px-1 py-1">
          {tasks.length === 0 && <p className="px-3 py-4 text-center text-sm text-slate-400">אין משימות ליום זה</p>}
          <ul>
            {active.map((t) => (
              <TaskRow key={t.id} task={t} viewDate={viewDate} onOpen={onOpen} />
            ))}
          </ul>
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

function TaskRow({ task, viewDate, onOpen }: { task: Task; viewDate: string; onOpen: (id: number) => void }) {
  const s = useSession();
  const overdue = task.status !== "done" ? daysBetween(task.dueDate, viewDate) : 0;
  const creator = task.createdById !== task.assigneeId ? s.nameOf(task.createdById) : null;
  return (
    <li>
      <button onClick={() => onOpen(task.id)} className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-start hover:bg-slate-50" data-testid={`task-${task.id}`}>
        <span className="pt-0.5">
          <StatusIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-semibold ${task.status === "done" ? "text-slate-400 line-through" : "text-ink-900"}`}>{task.title}</span>
          {task.status === "in_progress" && task.progressNote && <span className="mt-0.5 line-clamp-2 block text-xs text-amber-800">{task.progressNote}</span>}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            {creator && <span>מאת {creator}</span>}
            {task.recurringId && <span className="text-sky-700">קבועה</span>}
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
