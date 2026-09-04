import { Hono } from "hono";
import type { AppEnv } from "../context";
import { getSettings, saveSettings, mask, DEFAULT_REMINDERS } from "../settings";
import { sendTelegram, telegramConfigured, telegramRecentChats } from "../telegram";
import { sendWhatsApp, whatsappConfigured } from "../whatsapp";
import { readJson, str, phone as parsePhone } from "../validate";
import type { AppSettings } from "@shared/types";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "רק מנהל ראשי יכול לשנות הגדרות" }, 403);
  await next();
});

function forClient(s: AppSettings) {
  return {
    ...s,
    telegramBotToken: mask(s.telegramBotToken),
    whatsappToken: mask(s.whatsappToken),
    telegramConfigured: telegramConfigured(s),
    whatsappConfigured: whatsappConfigured(s),
  };
}

settingsRoutes.get("/", async (c) => c.json(forClient(await getSettings(c.get("db"), c.env))));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

settingsRoutes.put("/", async (c) => {
  const db = c.get("db");
  const body = await readJson(c.req.raw);
  const current = await getSettings(db, c.env);
  const next: AppSettings = { ...current };
  // Secrets: an empty string keeps the stored value; the literal "-" clears it.
  const secret = (v: unknown, cur: string) => (typeof v !== "string" || v === "" ? cur : v.trim() === "-" ? "" : v.trim());
  next.telegramBotToken = secret(body.telegramBotToken, current.telegramBotToken);
  next.whatsappToken = secret(body.whatsappToken, current.whatsappToken);
  for (const k of ["telegramChatId", "whatsappPhoneId", "whatsappTemplate", "whatsappLoginTemplate", "whatsappLang"] as const) {
    if (body[k] !== undefined) {
      const v = str(body[k], 200, { required: false });
      if (v === null) return c.json({ error: "ערך ארוך מדי" }, 400);
      next[k] = v;
    }
  }
  if (body.telegramNotifyOwnActions !== undefined) next.telegramNotifyOwnActions = body.telegramNotifyOwnActions === true;
  if (body.reminderTimes !== undefined) {
    const arr = body.reminderTimes;
    if (!Array.isArray(arr) || arr.length !== 7) return c.json({ error: "שעות תזכורת לא תקינות" }, 400);
    const times: string[] = [];
    for (const v of arr) {
      if (v === "" || v === null) times.push("");
      else if (typeof v === "string" && TIME.test(v)) times.push(v);
      else return c.json({ error: "שעה לא תקינה (פורמט HH:MM)" }, 400);
    }
    next.reminderTimes = times;
  }
  await saveSettings(db, next);
  return c.json({ ok: true, settings: forClient(next) });
});

settingsRoutes.post("/reset-reminders", async (c) => {
  const db = c.get("db");
  const s = await getSettings(db, c.env);
  s.reminderTimes = [...DEFAULT_REMINDERS];
  await saveSettings(db, s);
  return c.json({ ok: true, settings: forClient(s) });
});

/** Chats that wrote to the bot recently, to pick the admin chat id. */
settingsRoutes.get("/telegram/chats", async (c) => {
  const s = await getSettings(c.get("db"), c.env);
  if (!s.telegramBotToken) return c.json({ error: "קודם שמור את ה-token של הבוט" }, 400);
  try {
    return c.json({ chats: await telegramRecentChats(s.telegramBotToken) });
  } catch (e) {
    return c.json({ error: `טלגרם החזיר שגיאה: ${(e as Error).message}` }, 502);
  }
});

settingsRoutes.post("/telegram/test", async (c) => {
  const s = await getSettings(c.get("db"), c.env);
  if (!telegramConfigured(s)) return c.json({ error: "חסר token או chat id" }, 400);
  try {
    await sendTelegram(s, `✅ <b>לו"ז יומי</b> מחובר לטלגרם. כאן יגיעו כל העדכונים על משימות.`);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: `שליחה נכשלה: ${(e as Error).message}` }, 502);
  }
});

settingsRoutes.post("/whatsapp/test", async (c) => {
  const s = await getSettings(c.get("db"), c.env);
  const body = await readJson(c.req.raw);
  const to = parsePhone(body.phone) ?? c.get("user").phone;
  if (!whatsappConfigured(s)) return c.json({ error: "חסר token או Phone number ID" }, 400);
  if (!to) return c.json({ error: "אין מספר טלפון לבדיקה" }, 400);
  try {
    await sendWhatsApp(s, to, "בדיקת חיבור: ההודעות מלו\"ז יומי יגיעו לכאן ✓");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: `שליחה נכשלה: ${(e as Error).message}` }, 502);
  }
});
