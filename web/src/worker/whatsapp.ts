import type { Env } from "./env";

/**
 * WhatsApp Business Cloud API (Meta). Business-initiated messages must use an approved template;
 * the template is expected to have one text parameter {{1}} in its body, e.g.
 *   "עדכון מלו"ז יומי: {{1}}"
 * Configure: WHATSAPP_TOKEN (secret), WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE (default task_update), WHATSAPP_LANG (default he).
 */
export function whatsappConfigured(env: Env): boolean {
  return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
}

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
function sanitizeParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").slice(0, 1000);
}

export async function sendWhatsApp(env: Env, toPhone: string, text: string): Promise<void> {
  if (!whatsappConfigured(env)) throw new Error("WhatsApp is not configured");
  const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: env.WHATSAPP_TEMPLATE || "task_update",
        language: { code: env.WHATSAPP_LANG || "he" },
        components: [{ type: "body", parameters: [{ type: "text", text: sanitizeParam(text) }] }],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("WhatsApp error", res.status, body.slice(0, 500));
    throw new Error(`WhatsApp ${res.status}`);
  }
}
