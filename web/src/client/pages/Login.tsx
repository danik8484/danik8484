import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { Button, ErrorText, Field, inputCls } from "../components/ui";

export default function Login({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [devCode, setDevCode] = useState<string | undefined>();
  const [linkBusy, setLinkBusy] = useState(() => new URLSearchParams(window.location.search).has("t"));

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("t");
    if (!token) return;
    window.history.replaceState({}, "", "/");
    api
      .loginWithLink(token)
      .then(() => onLoggedIn())
      .catch((err) => setError((err as Error).message))
      .finally(() => setLinkBusy(false));
  }, [onLoggedIn]);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.requestCode(email);
      setDevCode(res.devCode);
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.verifyCode(email, code);
      await onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-900 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand-500 text-xl font-black text-white">✓</span>
          <div>
            <h1 className="text-xl font-extrabold text-ink-900">לו"ז יומי</h1>
            <p className="text-sm text-slate-500">כניסה עם קוד למייל</p>
          </div>
        </div>

        {linkBusy ? (
          <p className="py-4 text-center text-sm text-slate-600">מתחבר באמצעות הקישור...</p>
        ) : step === "email" ? (
          <form onSubmit={sendCode} className="space-y-4">
            <Field label="כתובת מייל">
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                dir="ltr"
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "שולח..." : "שלח לי קוד"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <p className="text-sm text-slate-600">
              שלחנו קוד בן 6 ספרות אל <b dir="ltr">{email}</b>. אם המייל רשום במערכת, הקוד יגיע תוך דקה.
            </p>
            {devCode && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="dev-code">
                מצב פיתוח – הקוד: <b>{devCode}</b>
              </p>
            )}
            <Field label="קוד כניסה">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={6}
                className={`${inputCls} text-center text-2xl tracking-[0.5em]`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                autoFocus
              />
            </Field>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? "בודק..." : "כניסה"}
            </Button>
            <button type="button" className="w-full text-sm text-slate-500 hover:text-ink-900" onClick={() => { setStep("email"); setCode(""); setError(""); }}>
              שינוי מייל / שליחת קוד חדש
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
