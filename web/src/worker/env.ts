export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: "development" | "production";
  APP_NAME: string;
  TIMEZONE: string;
  ADMIN_EMAIL?: string;
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
}
