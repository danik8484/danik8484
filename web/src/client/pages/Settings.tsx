import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ClientSettings } from "../api";
import { Button, ErrorText, Field, Spinner, inputCls } from "../components/ui";
import { WEEKDAYS_LONG } from "../format";

export default function Settings() {
  const [s, setS] = useState<ClientSettings | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [tgOwn, setTgOwn] = useState(false);
  const [waMode, setWaMode] = useState<"bridge" | "meta">("bridge");
  const [brHost, setBrHost] = useState("");
  const [brId, setBrId] = useState("");
  const [brToken, setBrToken] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waTemplate, setWaTemplate] = useState("");
  const [waLoginTemplate, setWaLoginTemplate] = useState("");
  const [waLang, setWaLang] = useState("");
  const [times, setTimes] = useState<string[]>([]);
  const [chats, setChats] = useState<{ id: string; name: string }[] | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.settings();
      setS(data);
      setTgChat(data.telegramChatId);
      setTgOwn(data.telegramNotifyOwnActions);
      setWaMode(data.whatsappMode);
      setBrHost(data.bridgeHost);
      setBrId(data.bridgeInstanceId);
      setBrToken("");
      setWaPhoneId(data.whatsappPhoneId);
      setWaTemplate(data.whatsappTemplate);
      setWaLoginTemplate(data.whatsappLoginTemplate);
      setWaLang(data.whatsappLang);
      setTimes(data.reminderTimes);
      setTgToken("");
      setWaToken("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await fn();
      setMsg(label);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await run("ההגדרות נשמרו", async () => {
      await api.saveSettings({
        telegramBotToken: tgToken,
        telegramChatId: tgChat,
        telegramNotifyOwnActions: tgOwn,
        whatsappMode: waMode,
        bridgeHost: brHost,
        bridgeInstanceId: brId,
        bridgeToken: brToken,
        whatsappToken: waToken,
        whatsappPhoneId: waPhoneId,
        whatsappTemplate: waTemplate,
        whatsappLoginTemplate: waLoginTemplate,
        whatsappLang: waLang,
        reminderTimes: times,
      });
      await load();
    });
  }

  if (!s) return error ? <ErrorText>{error}</ErrorText> : <Spinner />;

  return (
    <form onSubmit={save} className="space-y-4">
      <h1 className="text-lg font-bold text-ink-900">הגדרות</h1>
      <p className="text-sm text-slate-600">הפרטים כאן נשמרים במסד הנתונים של המערכת בלבד, לא בקוד.</p>
      <ErrorText>{error}</ErrorText>
      {msg && <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">{msg}</p>}

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-ink-900">
          טלגרם למנהל הראשי{" "}
          <span className={`ms-2 rounded-full px-2 py-0.5 text-xs ${s.telegramConfigured ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600"}`}>{s.telegramConfigured ? "מחובר" : "לא מחובר"}</span>
        </h2>
        <ol className="list-decimal space-y-1 ps-5 text-xs text-slate-600">
          <li>בטלגרם: חפש <b>@BotFather</b> ← <b>/newbot</b> ← תן שם ← העתק את ה-token.</li>
          <li>שלח הודעה כלשהי לבוט החדש (למשל "היי").</li>
          <li>הדבק כאן את ה-token, שמור, ולחץ "זהה צ'אט". אחר כך "שלח בדיקה".</li>
        </ol>
        <Field label="Bot token" hint={s.telegramBotToken ? `שמור: ${s.telegramBotToken}. השאר ריק כדי לא לשנות, או "-" למחיקה.` : undefined}>
          <input dir="ltr" className={inputCls} value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456789:AA..." autoComplete="off" />
        </Field>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Chat ID (הצ'אט שלך עם הבוט)">
              <input dir="ltr" className={inputCls} value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="123456789" />
            </Field>
          </div>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => run("", async () => setChats((await api.telegramChats()).chats))}>
            זהה צ'אט
          </Button>
        </div>
        {chats && (
          <div className="flex flex-wrap gap-2">
            {chats.length === 0 && <span className="text-xs text-slate-500">לא נמצאו צ'אטים. שלח הודעה לבוט ונסה שוב.</span>}
            {chats.map((c) => (
              <button key={c.id} type="button" className="rounded-full border border-slate-300 px-3 py-1 text-xs" onClick={() => setTgChat(c.id)}>
                {c.name} · {c.id}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" className="size-4 accent-brand-600" checked={tgOwn} onChange={(e) => setTgOwn(e.target.checked)} />
          לשלוח לי גם על פעולות שאני עצמי עושה
        </label>
        <Button type="button" variant="secondary" disabled={busy || !s.telegramConfigured} onClick={() => run("נשלחה הודעת בדיקה לטלגרם", () => api.telegramTest())}>
          שלח בדיקה לטלגרם
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-ink-900">
          וואטסאפ{" "}
          <span className={`ms-2 rounded-full px-2 py-0.5 text-xs ${s.whatsappConfigured ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600"}`}>{s.whatsappConfigured ? "מחובר" : "לא מחובר"}</span>
        </h2>
        <p className="text-xs text-slate-600">קודי כניסה, משימות חדשות ותזכורות נשלחות מהקו של החברה למספר הפרטי של כל איש צוות.</p>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" data-testid="wa-mode">
          {(["bridge", "meta"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={waMode === m}
              onClick={() => setWaMode(m)}
              className={`rounded-lg border px-2 py-2 text-sm font-semibold ${waMode === m ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-ink-700"}`}
            >
              {m === "bridge" ? "גשר Baileys (הקו הקיים)" : "WhatsApp Business API"}
            </button>
          ))}
        </div>
        {waMode === "bridge" ? (
          <>
            <p className="text-xs text-slate-600">
              אותו גשר שמשמש את בוט AutoFit. הערכים נמצאים ב-Railway במשתני הסביבה של הבוט: <b dir="ltr">WA_HOST</b> (כתובת הגשר), <b dir="ltr">GREEN_API_ID_BIZ</b> (מספר ה-instance של הקו העסקי) ו-<b dir="ltr">BRIDGE_TOKEN</b>. לקו הראשי: <b dir="ltr">MAIN_WA_HOST</b>, <b dir="ltr">GREEN_API_ID</b>, <b dir="ltr">MAIN_BRIDGE_TOKEN</b>.
            </p>
            <Field label="כתובת הגשר (WA_HOST)">
              <input dir="ltr" className={inputCls} value={brHost} onChange={(e) => setBrHost(e.target.value)} placeholder="https://....up.railway.app" data-testid="bridge-host" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Instance ID">
                <input dir="ltr" className={inputCls} value={brId} onChange={(e) => setBrId(e.target.value)} placeholder="7107645253" data-testid="bridge-id" />
              </Field>
              <Field label="Token (BRIDGE_TOKEN)" hint={s.bridgeToken ? `שמור: ${s.bridgeToken}. השאר ריק כדי לא לשנות, או "-" למחיקה.` : undefined}>
                <input dir="ltr" className={inputCls} value={brToken} onChange={(e) => setBrToken(e.target.value)} autoComplete="off" data-testid="bridge-token" />
              </Field>
            </div>
          </>
        ) : (
          <>
        <p className="text-xs text-slate-600">WhatsApp Business Cloud API של Meta, עם תבניות מאושרות. ההוראות המלאות להקמה נמצאות בקובץ README של המערכת.</p>
        <Field label="Access token" hint={s.whatsappToken ? `שמור: ${s.whatsappToken}. השאר ריק כדי לא לשנות, או "-" למחיקה.` : undefined}>
          <input dir="ltr" className={inputCls} value={waToken} onChange={(e) => setWaToken(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Phone number ID">
          <input dir="ltr" className={inputCls} value={waPhoneId} onChange={(e) => setWaPhoneId(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="תבנית עדכונים">
            <input dir="ltr" className={inputCls} value={waTemplate} onChange={(e) => setWaTemplate(e.target.value)} />
          </Field>
          <Field label="תבנית קוד כניסה">
            <input dir="ltr" className={inputCls} value={waLoginTemplate} onChange={(e) => setWaLoginTemplate(e.target.value)} />
          </Field>
          <Field label="שפה">
            <input dir="ltr" className={inputCls} value={waLang} onChange={(e) => setWaLang(e.target.value)} />
          </Field>
        </div>
          </>
        )}
        <Button type="button" variant="secondary" disabled={busy || !s.whatsappConfigured} onClick={() => run("נשלחה הודעת בדיקה לוואטסאפ שלך", () => api.whatsappTest())}>
          שלח בדיקה לוואטסאפ שלי
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-ink-900">תזכורות יומיות</h2>
        <p className="text-xs text-slate-600">
          א׳–ה׳ ושישי: תזכורת "מלא ועדכן לו"ז" למי שיש לו משימות שלא עודכנו. שבת: תזכורת לכולם להוסיף ללו"ז את המשימות ההכרחיות לשבוע. השאר ריק כדי לבטל יום.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEEKDAYS_LONG.map((name, i) => (
            <label key={i} className="block text-xs font-semibold text-slate-600">
              {name}
              <input type="time" className={`${inputCls} mt-1`} value={times[i] ?? ""} onChange={(e) => setTimes((t) => t.map((v, j) => (j === i ? e.target.value : v)))} data-testid={`reminder-${i}`} />
            </label>
          ))}
        </div>
        <Button type="button" variant="ghost" onClick={() => run("השעות אופסו לברירת המחדל", async () => load().then(() => api.resetReminders()).then(load))}>
          איפוס לברירת מחדל (21:00, שישי 14:00, שבת 19:00)
        </Button>
      </section>

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "שומר..." : "שמירת הגדרות"}
        </Button>
      </div>
    </form>
  );
}
