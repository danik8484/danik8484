import { Hono } from "hono";
import type { AppEnv } from "./context";
import { getDb } from "./db/client";
import { getSessionUser } from "./auth";
import { loadTeam, publicTeam, visibleIdsFor } from "./team";
import { toPublicUser } from "./serialize";
import { localDate } from "./dates";
import { authRoutes } from "./routes/auth";
import { taskRoutes, logRoutes } from "./routes/tasks";
import { recurringRoutes } from "./routes/recurring";
import { userRoutes } from "./routes/users";
import { photoRoutes } from "./routes/photos";
import { pushRoutes } from "./routes/push";
import { flushDigests, sendDayEndReminders } from "./notify";
import type { MeResponse } from "@shared/types";
import type { Env } from "./env";
import { materializeRecurring } from "./recurring";
import { ensureSchema } from "./migrate";

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  await ensureSchema(c.env);
  c.set("db", getDb(c.env.DB));
  c.header("Cache-Control", "no-store");
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "שגיאה בשרת. נסה שוב." }, 500);
});

app.route("/api/auth", authRoutes);

// Everything below requires a signed-in user.
app.use("/api/*", async (c, next) => {
  const user = await getSessionUser(c, c.get("db"));
  if (!user) return c.json({ error: "נדרשת התחברות" }, 401);
  const team = await loadTeam(c.get("db"));
  c.set("user", user);
  c.set("team", team);
  c.set("teamPublic", publicTeam(team, user));
  await next();
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const res: MeResponse = {
    user: toPublicUser(user, true),
    users: c.get("teamPublic"),
    visibleUserIds: visibleIdsFor(user, team),
    today: localDate(c.env.TIMEZONE),
  };
  return c.json(res);
});

app.route("/api/tasks", taskRoutes);
app.route("/api/log", logRoutes);
app.route("/api/recurring", recurringRoutes);
app.route("/api/users", userRoutes);
app.route("/api", photoRoutes);
app.route("/api/push", pushRoutes);

app.all("/api/*", (c) => c.json({ error: "לא נמצא" }, 404));

export async function runScheduled(env: Env, force = false): Promise<{ created: number; digests: number; reminders: number }> {
  await ensureSchema(env);
  const db = getDb(env.DB);
  const appUrl = env.APP_URL || "";
  const created = await materializeRecurring(db, localDate(env.TIMEZONE));
  const digests = await flushDigests(env, db, appUrl, Date.now(), force);
  const reminders = await sendDayEndReminders(env, db, appUrl);
  return { created, digests, reminders };
}

export default {
  fetch: app.fetch,
  /** Every 5 minutes: today's recurring tasks, batched "new task" notifications, end-of-day reminders. */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, event.cron === "force" && env.APP_ENV === "development"));
  },
};
