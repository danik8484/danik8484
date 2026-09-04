import { useEffect, type ReactNode } from "react";
import type { TaskStatus } from "@shared/types";
import { STATUS_LABEL, personColor, shortName } from "../format";

export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";
  const styles = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm",
    secondary: "bg-white text-ink-800 border border-slate-300 hover:bg-slate-50",
    ghost: "text-ink-700 hover:bg-slate-100",
    danger: "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100",
  }[variant];
  return (
    <button className={`${base} ${styles} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-ink-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const cls = {
    open: "bg-slate-100 text-slate-700",
    in_progress: "bg-amber-100 text-amber-800",
    done: "bg-brand-100 text-brand-700",
  }[status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{STATUS_LABEL[status]}</span>;
}

export function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "done")
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-500 text-white" aria-label="הושלם">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-amber-400 bg-amber-50" aria-label="בתהליך">
        <span className="size-2.5 rounded-full bg-amber-400" />
      </span>
    );
  return <span className="block size-6 shrink-0 rounded-full border-2 border-slate-300 bg-white" aria-label="פתוח" />;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-enter max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-w-lg sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink-900">{title}</h2>
          <button onClick={onClose} className="grid size-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100" aria-label="סגירה">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p>;
}

export function Spinner() {
  return <div className="mx-auto my-10 size-8 animate-spin rounded-full border-4 border-slate-200 border-t-brand-500" aria-label="טוען" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

/** "(דני ש.)" in that person's colour, for showing who added a task. */
export function PersonTag({ userId, users }: { userId: number; users: { id: number; name: string }[] }) {
  return <span className={`font-bold ${personColor(userId, users)}`}>({shortName(userId, users)})</span>;
}
