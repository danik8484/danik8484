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

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
