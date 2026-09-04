import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { MeResponse } from "@shared/types";
import { api, ApiError } from "./api";
import { SessionContext, type Session } from "./state";
import { Spinner } from "./components/ui";
import Login from "./pages/Login";
import Board from "./pages/Board";
import Recurring from "./pages/Recurring";
import Log from "./pages/Log";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Deals from "./pages/Deals";
import { PushToggle } from "./components/PushSettings";
import { disablePush, resyncPush } from "./push";

export default function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [linkError, setLinkError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    // A one-time login link works whether or not someone is already signed in on this device.
    const token = new URLSearchParams(window.location.search).get("t");
    const start = token
      ? api
          .loginWithLink(token)
          .catch((e) => setLinkError((e as Error).message))
          .finally(() => window.history.replaceState({}, "", "/"))
      : Promise.resolve();
    start.then(() => refresh().catch(() => setMe(null)));
    const onExpired = () => refresh().catch(() => setMe(null));
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, [refresh]);

  useEffect(() => {
    if (me) resyncPush();
  }, [me?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = useMemo<Session | null>(() => {
    if (!me) return null;
    const byId = new Map(me.users.map((u) => [u.id, u]));
    return {
      ...me,
      refresh,
      logout: async () => {
        await disablePush().catch(() => undefined);
        await api.logout();
        setMe(null);
      },
      userById: (id) => byId.get(id),
      nameOf: (id) => (id == null ? "" : (byId.get(id)?.name ?? "משתמש")),
      canSee: (id) => me.visibleUserIds.includes(id),
    };
  }, [me, refresh]);

  if (me === undefined) return <Spinner />;
  if (!session) return <Login onLoggedIn={refresh} initialError={linkError} />;

  return (
    <SessionContext.Provider value={session}>
      <Layout>
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/log" element={session.user.role === "employee" ? <Navigate to="/" replace /> : <Log />} />
          <Route path="/users" element={session.user.role === "admin" ? <Users /> : <Navigate to="/" replace />} />
          <Route path="/settings" element={session.user.role === "admin" ? <Settings /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </SessionContext.Provider>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-dvh">
      <Header menuOpen={open} onToggleMenu={() => setOpen((v) => !v)} />
      <main className="mx-auto w-full max-w-5xl px-3 pb-24 pt-3 sm:px-4">{children}</main>
    </div>
  );
}

function Header({ menuOpen, onToggleMenu }: { menuOpen: boolean; onToggleMenu: () => void }) {
  return (
    <SessionContext.Consumer>
      {(session) => {
        if (!session) return null;
        const links = [
          { to: "/", label: "לו\"ז" },
          { to: "/recurring", label: "משימות קבועות" },
          { to: "/deals", label: "נסלקים" },
          ...(session.user.role !== "employee" ? [{ to: "/log", label: "יומן פעילות" }] : []),
          ...(session.user.role === "admin" ? [{ to: "/users", label: "אנשי צוות" }, { to: "/settings", label: "הגדרות" }] : []),
        ];
        const linkCls = ({ isActive }: { isActive: boolean }) =>
          `rounded-lg px-3 py-2 text-sm font-semibold transition ${isActive ? "bg-white/15 text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"}`;
        return (
          <header className="sticky top-0 z-40 bg-ink-900 text-white shadow-md">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-brand-500 text-base font-black text-white">✓</span>
                <span className="text-base font-extrabold">לו"ז יומי</span>
              </div>
              <nav className="hidden items-center gap-1 sm:flex">
                {links.map((l) => (
                  <NavLink key={l.to} to={l.to} end className={linkCls}>
                    {l.label}
                  </NavLink>
                ))}
              </nav>
              <div className="flex items-center gap-2">
                <span className="hidden text-sm text-slate-300 sm:inline">{session.user.name}</span>
                <div className="hidden sm:block">
                  <PushToggle />
                </div>
                <button
                  onClick={() => session.logout()}
                  className="hidden rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white sm:inline"
                >
                  יציאה
                </button>
                <button
                  onClick={onToggleMenu}
                  className="grid size-9 place-items-center rounded-lg text-slate-200 hover:bg-white/10 sm:hidden"
                  aria-label="תפריט"
                  aria-expanded={menuOpen}
                >
                  ☰
                </button>
              </div>
            </div>
            {menuOpen && (
              <nav className="border-t border-white/10 px-3 pb-3 pt-2 sm:hidden">
                <p className="px-3 pb-1 text-xs text-slate-400">מחובר כ{session.user.name}</p>
                <div className="flex flex-col gap-1">
                  {links.map((l) => (
                    <NavLink key={l.to} to={l.to} end className={linkCls}>
                      {l.label}
                    </NavLink>
                  ))}
                  <PushToggle />
                  <button onClick={() => session.logout()} className="rounded-lg px-3 py-2 text-start text-sm font-semibold text-red-300 hover:bg-white/10">
                    יציאה
                  </button>
                </div>
              </nav>
            )}
          </header>
        );
      }}
    </SessionContext.Consumer>
  );
}
