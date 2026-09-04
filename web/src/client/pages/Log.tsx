import { useCallback, useEffect, useState } from "react";
import type { LogEntry } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Empty, ErrorText, Spinner, inputCls } from "../components/ui";
import TaskSheet, { eventText } from "../components/TaskSheet";
import { addDays, fmtDateTime } from "../format";

const TYPE_STYLE: Record<string, string> = {
  created: "bg-slate-100 text-slate-700",
  status: "bg-brand-100 text-brand-700",
  note: "bg-amber-100 text-amber-800",
  edited: "bg-sky-100 text-sky-800",
  reassigned: "bg-sky-100 text-sky-800",
  deleted: "bg-red-100 text-red-700",
};

export default function Log() {
  const s = useSession();
  const [from, setFrom] = useState(addDays(s.today, -6));
  const [to, setTo] = useState(s.today);
  const [who, setWho] = useState<number | "all">("all");
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState("");
  const [openTask, setOpenTask] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await api.log(from, to)).entries);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [from, to]);
  useEffect(() => {
    setEntries(null);
    load();
  }, [load]);

  const visible = s.users.filter((u) => s.canSee(u.id));
  const shown = (entries ?? []).filter((e) => who === "all" || e.taskAssigneeId === who);

  return (
    <div>
      <h1 className="mb-3 text-lg font-bold text-ink-900">יומן פעילות</h1>
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl bg-white p-3 shadow-sm sm:grid-cols-3">
        <label className="text-xs font-semibold text-slate-600">
          מתאריך
          <input type="date" className={`${inputCls} mt-1`} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          עד תאריך
          <input type="date" className={`${inputCls} mt-1`} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="col-span-2 text-xs font-semibold text-slate-600 sm:col-span-1">
          עובד
          <select className={`${inputCls} mt-1`} value={who} onChange={(e) => setWho(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">כולם</option>
            {visible.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      {entries === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Empty>אין פעילות בטווח שנבחר</Empty>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((e) => (
            <li key={e.id}>
              <button onClick={() => setOpenTask(e.taskId)} className="w-full rounded-xl bg-white px-3 py-2 text-start shadow-sm hover:bg-slate-50">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span>{fmtDateTime(e.createdAt)}</span>
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${TYPE_STYLE[e.type] ?? ""}`}>{eventText(e)}</span>
                  <b className="text-ink-800">{s.nameOf(e.actorId)}</b>
                  {e.actorId !== e.taskAssigneeId && <span>· משימה של {s.nameOf(e.taskAssigneeId)}</span>}
                </div>
                <div className="mt-1 text-sm font-semibold text-ink-900">{e.taskTitle}</div>
                {e.note && <div className="mt-0.5 whitespace-pre-wrap text-xs text-slate-700">{e.note}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <TaskSheet taskId={openTask} viewDate={s.today} onClose={() => setOpenTask(null)} onChanged={load} />
    </div>
  );
}
