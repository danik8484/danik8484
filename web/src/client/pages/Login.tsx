import { useEffect, useState, type FormEvent } from "react";
import type { AuthConfig } from "@shared/types";
import { api } from "../api";
import { Button, ErrorText, Field, Spinner, inputCls } from "../components/ui";

export default function Login({ onLoggedIn, initialError = "" }: { onLoggedIn: () => Promise<void>; initialError?: string }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(null);
  const [email, setEmail] = useState("");
  const [useEmail, setUseEmail] = useState(false);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"pick" | "code">("pick");
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [devCode, setDevCode] = useState<string | undefined>();

  useEffect(() => {
    api
      .authConfig()
      .then(setConfig)
      .catch(() => setConfig({ team: [], whatsapp: false, email: false }));
  }, []);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (useEmail) {
        const res = await api.requestCode(email);
        setDevCode(res.devCode);
        setSentTo(email);
      } else {
        if (!picked) return;
        const res = await api.requestUserCode(picked.id);
        setDevCode(res.devCode);
        setSentTo(res.to ? `וואטסאפ ${res.to}` : "וואטסאפ");
      }
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
      if (useEmail) await api.verifyCode(email, code);
      else await api.verifyUserCode(picked!.id, code);
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
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand-500 text-xl font-black text-white">✓</span>
          <div>
            <h1 className="text-xl font-extrabold text-ink-900">לו"ז יומי</h1>
            <p className="text-sm text-slate-500">{step === "pick" ? "מי אתה?" : "קוד אימות"}</p>
          </div>
        </div>

        {config === null ? (
          <Spinner />
        ) : step === "pick" ? (
          <div className="space-y-4">
            {!useEmail ? (
              <>
                <ul className="grid grid-cols-1 gap-2" data-testid="team-picker">
                  {config.team.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(u)}
                        aria-pressed={picked?.id === u.id}
                        aria-label={u.name}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start text-sm font-semibold transition ${
                          picked?.id === u.id ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-ink-800 hover:bg-slate-50"
                        }`}
                      >
                        <span className={`grid size-8 place-items-center rounded-full text-sm font-bold ${picked?.id === u.id ? "bg-brand-500 text-white" : "bg-slate-200 text-ink-800"}`}>
                          {u.name.slice(0, 1)}
                        </span>
                        {u.name}
                      </button>
                    </li>
                  ))}
                  {config.team.length === 0 && <li className="text-sm text-slate-500">אין אנשי צוות פעילים</li>}
                </ul>
                <ErrorText>{error}</ErrorText>
                <Button className="w-full" disabled={!picked || busy} onClick={() => sendCode()}>
                  {busy ? "שולח..." : "שלח לי קוד לוואטסאפ"}
                </Button>
                {config.email && (
                  <button type="button" className="w-full text-xs text-slate-500 hover:text-ink-900" onClick={() => { setUseEmail(true); setError(""); }}>
                    כניסה עם קוד למייל
                  </button>
                )}
              </>
            ) : (
              <form onSubmit={sendCode} className="space-y-4">
                <Field label="כתובת מייל">
                  <input type="email" inputMode="email" autoComplete="email" dir="ltr" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </Field>
                <ErrorText>{error}</ErrorText>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "שולח..." : "שלח לי קוד"}
                </Button>
                <button type="button" className="w-full text-xs text-slate-500 hover:text-ink-900" onClick={() => { setUseEmail(false); setError(""); }}>
                  חזרה לבחירת שם
                </button>
              </form>
            )}
          </div>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <p className="text-sm text-slate-600">
              {useEmail ? (
                <>שלחנו קוד בן 6 ספרות אל <b dir="ltr">{sentTo}</b>.</>
              ) : (
                <>
                  היי <b>{picked?.name}</b>, שלחנו קוד בן 6 ספרות ל{sentTo}.
                </>
              )}
            </p>
            {devCode && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="dev-code">
                מצב פיתוח – הקוד: <b>{devCode}</b>
              </p>
            )}
            <Field label="קוד אימות">
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
            <button type="button" className="w-full text-sm text-slate-500 hover:text-ink-900" onClick={() => { setStep("pick"); setCode(""); setError(""); }}>
              חזרה / שליחת קוד חדש
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
