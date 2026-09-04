export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  ASSETS: Fetcher;
  APP_ENV: "development" | "production";
  APP_NAME: string;
  TIMEZONE: string;
  ADMIN_EMAIL?: string;
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  BOOTSTRAP_ADMIN_LINK_HASH?: string;
  VAPID_SUBJECT?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_TEMPLATE?: string;
  WHATSAPP_LANG?: string;
  APP_URL?: string; // public URL used in notification links
}
