import { Hono } from "hono";
import type { AppEnv } from "../context";
import { getSettings, saveSettings, mask, DEFAULT_REMINDERS } from "../settings";
import { sendTelegram, telegramConfigured, telegramRecentChats, TELEGRAM_TOKEN_RE, TELEGRAM_CHAT_RE } from "../telegram";
import { sendWhatsApp, whatsappConfigured, WA_PHONE_ID_RE, BRIDGE_HOST_RE, bridgeConfigured, metaConfigured } from "../whatsapp";
import { readJson, str, phone as parsePhone, int } from "../validate";
import { DND_DEFAULT_URL, clearDndAuth, dndConnect, dndStatus, dndTest, syncDndDeals } from "../dnd";
import type { Db } from "../db/client";
import { morningReportPreview } from "../notify";
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
    bridgeToken: mask(s.bridgeToken),
    telegramConfigured: telegramConfigured(s),
    whatsappConfigured: whatsappConfigured(s),
    bridgeConfigured: bridgeConfigured(s),
    metaConfigured: metaConfigured(s),
  };
}

async function clientView(db: Db, s: AppSettings) {
  return { ...forClient(s), dnd: await dndStatus(db) };
}

settingsRoutes.get("/", async (c) => c.json(await clientView(c.get("db"), await getSettings(c.get("db"), c.env))));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

settingsRoutes.put("/", async (c) => {
  const db = c.get("db");
  const body = await readJson(c.req.raw);
  const current = await getSettings(db, c.env);
  const next: AppSettings = { ...current };
  // Secrets: an empty string keeps the stored value; the literal "-" clears it.
  const secret = (v: unknown, cur: string) => (typeof v !== "string" || v === "" ? cur : v.trim() === "-" ? "" : v.trim());
  next.telegramBotToken = secret(body.telegramBotToken, current.telegramBotToken);
  if (next.telegramBotToken && !TELEGRAM_TOKEN_RE.test(next.telegramBotToken)) return c.json({ error: "ה-token של הבוט לא נראה תקין (פורמט 123456789:AA...)" }, 400);
  next.whatsappToken = secret(body.whatsappToken, current.whatsappToken);
  next.bridgeToken = secret(body.bridgeToken, current.bridgeToken);
  if (body.whatsappMode !== undefined) {
    if (body.whatsappMode !== "bridge" && body.whatsappMode !== "meta") return c.json({ error: "מצב וואטסאפ לא תקין" }, 400);
    next.whatsappMode = body.whatsappMode;
  }
  if (body.bridgeHost !== undefined) {
    const host = str(body.bridgeHost, 200, { required: false });
    if (host === null) return c.json({ error: "כתובת הגשר ארוכה מדי" }, 400);
    const trimmed = host.replace(/\/+$/, "");
    if (trimmed && !BRIDGE_HOST_RE.test(trimmed)) return c.json({ error: "כתובת הגשר חייבת להיות https://... בלי נתיב" }, 400);
    next.bridgeHost = trimmed;
  }
  if (body.bridgeInstanceId !== undefined) {
    const id = str(body.bridgeInstanceId, 30, { required: false });
    if (id === null || (id && !/^\d{3,30}$/.test(id))) return c.json({ error: "מספר ה-instance חייב להיות ספרות בלבד" }, 400);
    next.bridgeInstanceId = id;
  }
  if (next.whatsappToken && !/^[A-Za-z0-9_.-]{20,600}$/.test(next.whatsappToken)) return c.json({ error: "ה-Access token של וואטסאפ לא נראה תקין" }, 400);
  for (const k of ["telegramChatId", "whatsappPhoneId", "whatsappTemplate", "whatsappLoginTemplate", "whatsappLang"] as const) {
    if (body[k] !== undefined) {
      const v = str(body[k], 200, { required: false });
      if (v === null) return c.json({ error: "ערך ארוך מדי" }, 400);
      next[k] = v;
    }
  }
  if (next.telegramChatId && !TELEGRAM_CHAT_RE.test(next.telegramChatId)) return c.json({ error: "Chat ID חייב להיות מספר" }, 400);
  if (next.whatsappPhoneId && !WA_PHONE_ID_RE.test(next.whatsappPhoneId)) return c.json({ error: "Phone number ID חייב להיות מספר" }, 400);
  for (const k of ["whatsappTemplate", "whatsappLoginTemplate"] as const) if (next[k] && !/^[a-z0-9_]{1,100}$/.test(next[k])) return c.json({ error: "שם תבנית: אותיות קטנות באנגלית, ספרות וקו תחתון" }, 400);
  if (next.whatsappLang && !/^[a-z]{2}(_[A-Z]{2})?$/.test(next.whatsappLang)) return c.json({ error: "קוד שפה לא תקין (למשל he)" }, 400);
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
  if (body.morningReportTime !== undefined) {
    const v = body.morningReportTime;
    if (v === "" || v === null) next.morningReportTime = "";
    else if (typeof v === "string" && TIME.test(v)) next.morningReportTime = v;
    else return c.json({ error: "שעת דוח הבוקר לא תקינה (פורמט HH:MM)" }, 400);
  }
  if (body.dndBaseUrl !== undefined) {
    const u = str(body.dndBaseUrl, 200, { required: false });
    if (u === null) return c.json({ error: "כתובת DND CASH ארוכה מדי" }, 400);
    const trimmed = (u || DND_DEFAULT_URL).replace(/\/+$/, "");
    const ok = /^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?$/.test(trimmed) || (c.env.APP_ENV === "development" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/.test(trimmed));
    if (!ok) return c.json({ error: "כתובת DND CASH חייבת להיות https://... בלי נתיב" }, 400);
    next.dndBaseUrl = trimmed;
  }
  if (body.dndPlusTrainingUserIds !== undefined) {
    if (!Array.isArray(body.dndPlusTrainingUserIds)) return c.json({ error: "רשימת אנשי צוות לא תקינה" }, 400);
    const ids = body.dndPlusTrainingUserIds.map((v: unknown) => int(v)).filter((v: number | null): v is number => v !== null);
    const team = c.get("team");
    if (ids.some((id: number) => !team.some((u) => u.id === id))) return c.json({ error: "איש צוות לא תקין" }, 400);
    next.dndPlusTrainingUserIds = [...new Set(ids)];
  }
  await saveSettings(db, next);
  return c.json({ ok: true, settings: await clientView(db, next) });
});

/** What the morning report would say to each person today, and who already got it. */
settingsRoutes.get("/morning-report/preview", async (c) => c.json({ ok: true, ...(await morningReportPreview(c.env, c.get("db"))) }));

/* ---------------- DND CASH (payroll): connection is stored apart from the settings blob ---------------- */

settingsRoutes.post("/dnd/connect", async (c) => {
  const body = await readJson(c.req.raw);
  const token = str(body.refreshToken, 4000);
  if (!token) return c.json({ error: "חסר טוקן רענון של DND CASH" }, 400);
  try {
    return c.json({ ok: true, dnd: await dndConnect(c.env, c.get("db"), token) });
  } catch (e) {
    return c.json({ error: `החיבור ל-DND CASH נכשל: ${(e as Error).message}` }, 502);
  }
});

settingsRoutes.post("/dnd/test", async (c) => {
  try {
    return c.json({ ok: true, dnd: await dndTest(c.env, c.get("db")) });
  } catch (e) {
    return c.json({ error: `בדיקת DND CASH נכשלה: ${(e as Error).message}` }, 502);
  }
});

settingsRoutes.post("/dnd/disconnect", async (c) => {
  await clearDndAuth(c.get("db"));
  return c.json({ ok: true, dnd: await dndStatus(c.get("db")) });
});

settingsRoutes.post("/dnd/sync", async (c) => {
  const result = await syncDndDeals(c.env, c.get("db"), { retryErrors: true });
  return c.json({ ok: true, result, dnd: await dndStatus(c.get("db")) });
});

settingsRoutes.post("/reset-reminders", async (c) => {
  const db = c.get("db");
  const s = await getSettings(db, c.env);
  s.reminderTimes = [...DEFAULT_REMINDERS];
  await saveSettings(db, s);
  return c.json({ ok: true, settings: await clientView(db, s) });
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
