import type { AppSettings } from "@shared/types";

/**
 * WhatsApp Business Cloud API (Meta). Business-initiated messages must use approved templates.
 * - Updates/reminders: a UTILITY template with one {{1}} body parameter, e.g. "עדכון מלו"ז יומי: {{1}}".
 * - Login codes: an AUTHENTICATION template (body with {{1}} = code and a copy-code button).
 * Credentials live in the admin settings screen (database), not in the repository.
 */
export const WA_PHONE_ID_RE = /^\d{5,25}$/;

export function whatsappConfigured(s: AppSettings): boolean {
  return s.whatsappToken.length >= 20 && WA_PHONE_ID_RE.test(s.whatsappPhoneId);
}

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
function sanitizeParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").slice(0, 1000);
}

async function post(s: AppSettings, body: unknown): Promise<void> {
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

export async function sendWhatsApp(s: AppSettings, toPhone: string, text: string): Promise<void> {
  if (!whatsappConfigured(s)) throw new Error("WhatsApp is not configured");
  await post(s, {
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

/** One-time login code through an AUTHENTICATION template. */
export async function sendWhatsAppCode(s: AppSettings, toPhone: string, code: string): Promise<void> {
  if (!whatsappConfigured(s)) throw new Error("WhatsApp is not configured");
  await post(s, {
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
