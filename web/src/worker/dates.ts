/** Date helpers in the company's timezone (Asia/Jerusalem by default). */

export function localDate(tz: string, d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

/** 0 = Sunday ... 6 = Saturday, for a YYYY-MM-DD string. */
export function weekdayOf(isoDate: string): number {
  return new Date(isoDate + "T00:00:00Z").getUTCDay();
}

export function nowIso(): string {
  return new Date().toISOString();
}
