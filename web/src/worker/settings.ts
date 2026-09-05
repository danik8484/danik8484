import { eq, sql } from "drizzle-orm";
import type { Env } from "./env";
import type { Db } from "./db/client";
import { appMeta } from "./db/schema";
import type { AppSettings } from "@shared/types";

const KEY = "settings";

export const DEFAULT_REMINDERS = ["21:00", "21:00", "21:00", "21:00", "21:00", "14:00", "19:00"]; // Sun..Sat

export function defaultSettings(env: Env): AppSettings {
  return {
    telegramBotToken: "",
    telegramChatId: "",
    telegramNotifyOwnActions: false,
    whatsappMode: "bridge",
    bridgeHost: "",
    bridgeInstanceId: "",
    bridgeToken: "",
    whatsappToken: env.WHATSAPP_TOKEN ?? "",
    whatsappPhoneId: env.WHATSAPP_PHONE_ID ?? "",
    whatsappTemplate: env.WHATSAPP_TEMPLATE ?? "task_update",
    whatsappLoginTemplate: "login_code",
    whatsappLang: env.WHATSAPP_LANG ?? "he",
    reminderTimes: [...DEFAULT_REMINDERS],
  };
}

export async function getSettings(db: Db, env: Env): Promise<AppSettings> {
  const base = defaultSettings(env);
  const row = await db.select().from(appMeta).where(eq(appMeta.key, KEY)).get();
  if (!row) return base;
  try {
    const stored = JSON.parse(row.value) as Partial<AppSettings>;
    const merged: AppSettings = { ...base, ...stored };
    if (!Array.isArray(merged.reminderTimes) || merged.reminderTimes.length !== 7) merged.reminderTimes = [...DEFAULT_REMINDERS];
    return merged;
  } catch {
    return base;
  }
}

export async function saveSettings(db: Db, settings: AppSettings): Promise<void> {
  const value = JSON.stringify(settings);
  await db
    .insert(appMeta)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` } })
    .run();
}

/** Mask a secret for display: keep the first 4 and last 2 characters. */
export function mask(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 4)}••••${secret.slice(-2)}`;
}
