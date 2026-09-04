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

/** Offset (minutes east of UTC) of `tz` at a given instant. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** ISO instant (UTC) of local midnight at the start of `isoDate` in `tz`. */
export function startOfLocalDay(tz: string, isoDate: string): string {
  const guess = new Date(isoDate + "T00:00:00Z");
  const offset = tzOffsetMinutes(tz, guess);
  const adjusted = new Date(guess.getTime() - offset * 60000);
  // Re-check in case the offset differs across the DST boundary
  const offset2 = tzOffsetMinutes(tz, adjusted);
  return new Date(guess.getTime() - offset2 * 60000).toISOString();
}

/** ISO instant (UTC) of the end of `isoDate` in `tz` (start of the next day). */
export function endOfLocalDay(tz: string, isoDate: string): string {
  const next = new Date(isoDate + "T00:00:00Z");
  next.setUTCDate(next.getUTCDate() + 1);
  return startOfLocalDay(tz, next.toISOString().slice(0, 10));
}

const WD = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
/** "0,1,2" → "א׳, ב׳, ג׳" (or "כל יום"). */
export function fmtWeekdaysHe(weekdays: string): string {
  const days = weekdays.split(",").filter(Boolean).map(Number);
  if (days.length === 7) return "כל יום";
  return days.map((d) => WD[d]).join(", ");
}
