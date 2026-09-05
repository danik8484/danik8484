import type { AppSettings } from "@shared/types";

/**
 * Two ways to reach WhatsApp:
 *
 * 1. "bridge" (default): the company's own Baileys bridge, which speaks the Green API HTTP format:
 *    POST {host}/waInstance{id}/sendMessage/{token}  { chatId: "<phone>@c.us", message: "..." }
 *    Plain text, no templates, works for login codes and notifications alike. A real Green API
 *    account works with the same settings (host https://api.green-api.com).
 *
 * 2. "meta": WhatsApp Business Cloud API. Business-initiated messages must use approved templates:
 *    a UTILITY template with one {{1}} body parameter for updates, and an AUTHENTICATION template
 *    (code in body + copy-code button) for login codes.
 *
 * Credentials live in the admin settings screen (database), never in the repository.
 */

export const WA_PHONE_ID_RE = /^\d{5,25}$/;
export const BRIDGE_HOST_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?$/;

export function bridgeConfigured(s: AppSettings): boolean {
  return BRIDGE_HOST_RE.test(s.bridgeHost) && /^\d{3,30}$/.test(s.bridgeInstanceId) && s.bridgeToken.length >= 8;
}

export function metaConfigured(s: AppSettings): boolean {
  return s.whatsappToken.length >= 20 && WA_PHONE_ID_RE.test(s.whatsappPhoneId);
}

export function whatsappConfigured(s: AppSettings): boolean {
  return s.whatsappMode === "meta" ? metaConfigured(s) : bridgeConfigured(s);
}

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
function sanitizeParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").slice(0, 1000);
}

/* ---------------- bridge (Green API format) ---------------- */

async function bridgePost(s: AppSettings, method: string, body: unknown): Promise<void> {
  const url = `${s.bridgeHost}/waInstance${encodeURIComponent(s.bridgeInstanceId)}/${method}/${encodeURIComponent(s.bridgeToken)}`;
  const delays = [800, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      if (attempt === delays.length) throw new Error(`bridge unreachable: ${(e as Error).message}`);
    }
    if (res) {
      if (res.ok) return;
      const text = await res.text().catch(() => "");
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === delays.length) {
        console.error("WhatsApp bridge error", res.status, text.slice(0, 300));
        throw new Error(`bridge ${res.status}`);
      }
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

async function bridgeSendText(s: AppSettings, toPhone: string, text: string): Promise<void> {
  await bridgePost(s, "sendMessage", { chatId: `${toPhone}@c.us`, message: text.slice(0, 4000) });
}

/* ---------------- Meta Cloud API ---------------- */

async function metaPost(s: AppSettings, body: unknown): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(s.whatsappPhoneId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.whatsappToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("WhatsApp error", res.status, text.slice(0, 500));
    throw new Error(`WhatsApp ${res.status}: ${text.slice(0, 200)}`);
  }
}

/* ---------------- public API ---------------- */

export async function sendWhatsApp(s: AppSettings, toPhone: string, text: string): Promise<void> {
  if (!whatsappConfigured(s)) throw new Error("WhatsApp is not configured");
  if (s.whatsappMode !== "meta") return bridgeSendText(s, toPhone, text);
  await metaPost(s, {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: s.whatsappTemplate || "task_update",
      language: { code: s.whatsappLang || "he" },
      components: [{ type: "body", parameters: [{ type: "text", text: sanitizeParam(text) }] }],
    },
  });
}

/** One-time login code. */
export async function sendWhatsAppCode(s: AppSettings, toPhone: string, code: string): Promise<void> {
  if (!whatsappConfigured(s)) throw new Error("WhatsApp is not configured");
  if (s.whatsappMode !== "meta") {
    return bridgeSendText(s, toPhone, `קוד הכניסה שלך ללו"ז יומי: *${code}*\nהקוד תקף ל-10 דקות. אם לא ביקשת קוד, התעלם מההודעה.`);
  }
  await metaPost(s, {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: s.whatsappLoginTemplate || "login_code",
      language: { code: s.whatsappLang || "he" },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
      ],
    },
  });
}
