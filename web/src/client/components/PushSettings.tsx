import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, ErrorText } from "./ui";
import { disablePush, enablePush, getPushState, type PushState } from "../push";

const DISMISS_KEY = "push-banner-dismissed";

export function usePushState() {
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    getPushState().then(setState).catch(() => setState("unsupported"));
  }, []);
  return [state, setState] as const;
}

/** Banner on the board asking to turn notifications on (once). */
export function PushBanner() {
  const [state, setState] = usePushState();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (hidden || state === null || state === "on" || state === "unsupported" || state === "denied") return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mb-3 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="push-banner">
      {state === "needs-homescreen" ? (
        <>
          <b>רוצה לקבל התראות על משימות חדשות?</b> באייפון צריך קודם להוסיף את המערכת למסך הבית: לחץ על כפתור השיתוף בספארי ← "הוסף למסך הבית", ואז פתח משם והפעל התראות.
        </>
      ) : (
        <>
          <b>הפעל התראות</b> כדי לקבל עדכון כשמוסיפים לך משימה, ותזכורת בסוף היום.
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="mt-2 flex gap-2">
        {state === "off" && (
          <Button
            className="px-3 py-1.5"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setState(await enablePush());
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "מפעיל..." : "הפעל התראות"}
          </Button>
        )}
        <Button variant="ghost" className="px-3 py-1.5" onClick={dismiss}>
          לא עכשיו
        </Button>
      </div>
    </div>
  );
}

/** Toggle inside the menu. */
export function PushToggle() {
  const [state, setState] = usePushState();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  if (state === null) return null;
  const label =
    state === "on" ? "התראות: פעילות" : state === "denied" ? "התראות: חסומות בדפדפן" : state === "needs-homescreen" ? "התראות: הוסף למסך הבית קודם" : state === "unsupported" ? "התראות: לא נתמך" : "התראות: כבויות";
  return (
    <div className="flex flex-col gap-1 px-3 py-1">
      <button
        className="rounded-lg px-0 py-1 text-start text-sm font-semibold text-slate-300 hover:text-white disabled:opacity-50"
        disabled={busy || state === "denied" || state === "unsupported" || state === "needs-homescreen"}
        onClick={async () => {
          setBusy(true);
          setMsg("");
          try {
            setState(state === "on" ? await disablePush() : await enablePush());
          } catch (e) {
            setMsg((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "רגע..." : label}
      </button>
      {state === "on" && (
        <button
          className="text-start text-xs text-slate-400 hover:text-white"
          onClick={async () => {
            const r = await api.pushTest().catch(() => ({ delivered: 0 }));
            setMsg(r.delivered > 0 ? "נשלחה התראת בדיקה" : "לא נשלח. נסה לכבות ולהפעיל שוב.");
          }}
        >
          שלח התראת בדיקה
        </button>
      )}
      {msg && <span className="text-xs text-slate-400">{msg}</span>}
    </div>
  );
}
