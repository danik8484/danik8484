export function str(v: unknown, max: number, { required = true } = {}): string | null {
  if (v === undefined || v === null) return required ? null : "";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (required && s.length === 0) return null;
  if (s.length > max) return null;
  return s;
}

export function int(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

export function weekdays(v: unknown): number[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((x) => (typeof x === "number" ? x : Number(x))))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (out.length !== v.length) return null;
  return out.sort((a, b) => a - b);
}

export class BadRequest extends Error {
  status = 415;
}

/** Parse a JSON body. Non-JSON content types are refused so HTML forms cannot post here (login CSRF). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const hasBody = req.method !== "GET" && req.headers.get("content-length") !== "0" && ct !== "";
  if (hasBody && ct !== "application/json") throw new BadRequest("expected application/json");
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Split ids into groups small enough for D1's bound-parameter limit. */
export function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Normalize an Israeli/international phone number to E.164 digits (e.g. 972538322343). */
export function phone(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  let d = v.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 10) d = "972" + d.slice(1);
  if (!/^\d{9,15}$/.test(d)) return undefined;
  return d;
}
