import type { TaskStatus, Role } from "@shared/types";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "פתוח",
  in_progress: "בתהליך",
  done: "הושלם",
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "מנהל ראשי",
  manager: "מנהל",
  employee: "עובד",
};

export const WEEKDAYS_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
export const WEEKDAYS_LONG = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export function fmtDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" }).format(d);
}

export function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric" }).format(d);
}

export function fmtDateTime(isoTs: string): string {
  const d = new Date(isoTs);
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function fmtWeekdays(days: number[]): string {
  if (days.length === 7) return "כל יום";
  if (days.length === 6 && !days.includes(6)) return "כל יום חוץ משבת";
  if (days.length === 5 && !days.includes(5) && !days.includes(6)) return "ימים א׳–ה׳";
  return days.map((d) => WEEKDAYS_SHORT[d]).join(", ");
}

export function isoValid(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00"));
}

/** Stable per-person colour classes (index by position in the team list). */
const PERSON_COLORS = [
  "text-blue-700",
  "text-violet-700",
  "text-teal-700",
  "text-orange-700",
  "text-pink-700",
  "text-cyan-700",
  "text-lime-700",
  "text-rose-700",
  "text-indigo-700",
  "text-amber-700",
];

export function personColor(userId: number, all: { id: number }[]): string {
  const idx = [...all].sort((a, b) => a.id - b.id).findIndex((u) => u.id === userId);
  return PERSON_COLORS[(idx >= 0 ? idx : userId) % PERSON_COLORS.length];
}

/** First name; adds the surname initial when another teammate shares the first name. */
export function shortName(userId: number, all: { id: number; name: string }[]): string {
  const u = all.find((x) => x.id === userId);
  if (!u) return "";
  const [first, ...rest] = u.name.trim().split(/\s+/);
  const clash = all.some((x) => x.id !== userId && x.name.trim().split(/\s+/)[0] === first);
  return clash && rest.length > 0 ? `${first} ${rest[0][0]}.` : first;
}
