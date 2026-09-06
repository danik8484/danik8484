import { useCallback, useEffect, useState } from "react";
import { PAYMENT_METHOD_LABEL, type DealsResponse, type PaymentMethod } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Empty, ErrorText, Spinner, inputCls } from "../components/ui";
import TaskSheet from "../components/TaskSheet";
import { DND_STATUS_LABEL, fmtDateShort } from "../format";

export default function Deals() {
  const s = useSession();
  const [from, setFrom] = useState(s.today.slice(0, 8) + "01");
  const [to, setTo] = useState(s.today);
  const [who, setWho] = useState<number | "all">("all");
  const [data, setData] = useState<DealsResponse | null>(null);
  const [error, setError] = useState("");
  const [openTask, setOpenTask] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.deals(from, to, who === "all" ? undefined : who));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [from, to, who]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const visible = s.users.filter((u) => s.canSee(u.id));
  const fmt = (n: number) => n.toLocaleString("he-IL", { maximumFractionDigits: 2 });

  return (
    <div>
      <h1 className="mb-3 text-lg font-bold text-ink-900">נסלקים</h1>
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl bg-white p-3 shadow-sm sm:grid-cols-3">
        <label className="text-xs font-semibold text-slate-600">
          מתאריך
          <input type="date" className={`${inputCls} mt-1`} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          עד תאריך
          <input type="date" className={`${inputCls} mt-1`} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        {visible.length > 1 && (
          <label className="col-span-2 text-xs font-semibold text-slate-600 sm:col-span-1">
            איש צוות
            <select className={`${inputCls} mt-1`} value={who} onChange={(e) => setWho(e.target.value === "all" ? "all" : Number(e.target.value))}>
              <option value="all">כולם</option>
              {visible.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-white px-3 py-2 text-sm shadow-sm" data-testid="deals-summary">
            <span className="font-bold text-ink-800">סה"כ</span>
            <span className="text-emerald-700">
              <b>{data.deals.length}</b> נסלקים
            </span>
            <span className="text-emerald-700">
              <b>{fmt(data.total)}</b> ₪
            </span>
            {Object.entries(data.byMethod).map(([m, v]) => (
              <span key={m} className="text-xs text-slate-600">
                {m === "unknown" ? "לא צוין" : PAYMENT_METHOD_LABEL[m as PaymentMethod]}: {v.count} · {fmt(v.amount)} ₪
              </span>
            ))}
          </div>
          {data.deals.length === 0 ? (
            <Empty>אין נסלקים בטווח שנבחר</Empty>
          ) : (
            <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-start font-semibold">תאריך</th>
                    <th className="px-3 py-2 text-start font-semibold">לקוח</th>
                    <th className="px-3 py-2 text-start font-semibold">סכום</th>
                    <th className="px-3 py-2 text-start font-semibold">אמצעי תשלום</th>
                    <th className="px-3 py-2 text-start font-semibold">DND CASH</th>
                    {visible.length > 1 && <th className="px-3 py-2 text-start font-semibold">איש צוות</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.deals.map((d, i) => (
                    <tr key={i} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenTask(d.taskId)} data-testid="deal-row">
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDateShort(d.date)}</td>
                      <td className="px-3 py-2 font-semibold text-ink-900">{d.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmt(d.amount)} ₪</td>
                      <td className="px-3 py-2">
                        {d.method ? PAYMENT_METHOD_LABEL[d.method] : "לא צוין"}
                        {d.months ? ` · ${d.months} חודשים` : ""}
                        {d.plusTraining ? " · מכירה + אימון" : ""}
                      </td>
                      <td className={`px-3 py-2 text-xs ${d.dnd?.status === "sent" ? "text-emerald-700" : d.dnd?.status === "error" ? "text-red-600" : "text-slate-500"}`} data-testid="deal-dnd">
                        {d.dnd ? DND_STATUS_LABEL[d.dnd.status] : "—"}
                        {d.dnd?.stale ? " · שונה אחרי השליחה" : ""}
                      </td>
                      {visible.length > 1 && <td className="px-3 py-2">{s.nameOf(d.assigneeId)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <TaskSheet taskId={openTask} viewDate={s.today} onClose={() => setOpenTask(null)} onChanged={load} />
    </div>
  );
}
