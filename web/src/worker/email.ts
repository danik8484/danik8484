import type { Env } from "./env";

export class EmailNotConfigured extends Error {}

export async function sendLoginCode(env: Env, to: string, code: string): Promise<void> {
  const subject = `${env.APP_NAME} – קוד כניסה: ${code}`;
  const text = `קוד הכניסה שלך למערכת ${env.APP_NAME} הוא: ${code}\n\nהקוד תקף ל-10 דקות. אם לא ביקשת קוד, התעלם מהודעה זו.`;
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6">
    <p>קוד הכניסה שלך למערכת <b>${escapeHtml(env.APP_NAME)}</b>:</p>
    <p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
    <p>הקוד תקף ל-10 דקות. אם לא ביקשת קוד, התעלם מהודעה זו.</p>
  </div>`;

  if (!env.BREVO_API_KEY || !env.MAIL_FROM) {
    if (env.APP_ENV === "development") {
      console.log(`[dev] login code for ${to}: ${code}`);
      return;
    }
    throw new EmailNotConfigured("email not configured");
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || env.APP_NAME },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Brevo error", res.status, body);
    throw new Error("Failed to send email");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Generic plain-text email (used as a fallback for notifications). */
export async function sendPlainEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) throw new EmailNotConfigured("email not configured");
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || env.APP_NAME },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;white-space:pre-wrap">${escapeHtml(text)}</div>`,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}`);
}
