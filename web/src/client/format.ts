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
