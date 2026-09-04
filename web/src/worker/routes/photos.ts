import { Hono } from "hono";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { tasks, taskAttachments, taskEvents } from "../db/schema";
import { toAttachment, toPublicUser } from "../serialize";
import { canOpenTask } from "@shared/permissions";
import { chunk, int } from "../validate";
import { nowIso } from "../dates";
import { adminFeedFor } from "../notify";

const MAX_BYTES = 2_500_000; // images are resized on the phone before upload; this is a hard cap
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function listAttachments(db: Db, taskId: number) {
  return db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.taskId, taskId), isNull(taskAttachments.deletedAt)))
    .orderBy(asc(taskAttachments.id))
    .all();
}

/** Photo counts for a set of task ids (for the board rows). */
export async function photoCounts(db: Db, taskIds: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  for (const ids of chunk(taskIds)) {
    const rows = await db
      .select({ taskId: taskAttachments.taskId, n: sql<number>`count(*)` })
      .from(taskAttachments)
      .where(and(inArray(taskAttachments.taskId, ids), isNull(taskAttachments.deletedAt)))
      .groupBy(taskAttachments.taskId)
      .all();
    for (const r of rows) m.set(r.taskId, Number(r.n));
  }
  return m;
}

export const photoRoutes = new Hono<AppEnv>();

/** Upload one photo: raw image bytes in the body, content-type header, optional x-file-name. */
photoRoutes.post("/tasks/:id/photos", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const task = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!task) return c.json({ error: "לא נמצא" }, 404);
  if (!canOpenTask(toPublicUser(me, false), task, c.get("teamPublic"))) return c.json({ error: "אין הרשאה" }, 403);

  const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.has(contentType)) return c.json({ error: "אפשר להעלות רק תמונות (JPG, PNG, WebP)" }, 415);
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > MAX_BYTES) return c.json({ error: "התמונה גדולה מדי (עד 2.5MB)" }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "קובץ ריק" }, 400);
  if (bytes.byteLength > MAX_BYTES) return c.json({ error: "התמונה גדולה מדי (עד 2.5MB)" }, 413);

  let rawName = "photo.jpg";
  try {
    rawName = decodeURIComponent(c.req.header("x-file-name") || "photo.jpg").slice(0, 120) || "photo.jpg";
  } catch {
    /* malformed header – keep the default name */
  }
  const width = int(c.req.header("x-image-width") ?? "");
  const height = int(c.req.header("x-image-height") ?? "");
  const kvKey = `task/${id}/${crypto.randomUUID()}`;
  await c.env.FILES.put(kvKey, bytes, { metadata: { contentType, taskId: id } });
  // Optional small preview generated on the device (base64 JPEG in a header-sized body is impractical, so it is sent separately)
  const row = await db
    .insert(taskAttachments)
    .values({ taskId: id, uploadedById: me.id, kvKey, fileName: rawName, contentType, size: bytes.byteLength, width, height })
    .returning()
    .get();
  await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "photo", note: rawName }).run();
  await db.update(tasks).set({ updatedAt: nowIso() }).where(eq(tasks.id, id)).run();
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, id, me, "photo", { extra: rawName }));
  return c.json({ ok: true, attachment: toAttachment(row) }, 201);
});

/** Attach a small preview (JPEG ≤ 150KB) to an existing photo; generated on the device. */
photoRoutes.post("/photos/:id/thumb", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(taskAttachments).where(and(eq(taskAttachments.id, id), isNull(taskAttachments.deletedAt))).get();
  if (!row || row.uploadedById !== me.id) return c.json({ error: "לא נמצא" }, 404);
  if (Number(c.req.header("content-length") || 0) > 150_000) return c.json({ error: "תצוגה מקדימה גדולה מדי" }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 150_000) return c.json({ error: "תצוגה מקדימה גדולה מדי" }, 413);
  const thumbKey = `${row.kvKey}/thumb`;
  await c.env.FILES.put(thumbKey, bytes, { metadata: { contentType: "image/jpeg", taskId: row.taskId } });
  await db.update(taskAttachments).set({ thumbKey }).where(eq(taskAttachments.id, id)).run();
  return c.json({ ok: true });
});

photoRoutes.get("/photos/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(taskAttachments).where(and(eq(taskAttachments.id, id), isNull(taskAttachments.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const task = await db.select().from(tasks).where(eq(tasks.id, row.taskId)).get();
  if (!task || !canOpenTask(toPublicUser(me, false), task, c.get("teamPublic"))) return c.json({ error: "אין הרשאה" }, 403);
  const wantThumb = c.req.query("thumb") === "1" && !!row.thumbKey;
  const body = await c.env.FILES.get(wantThumb ? row.thumbKey! : row.kvKey, "stream");
  if (!body) return c.json({ error: "התמונה עדיין לא זמינה, נסה שוב בעוד רגע" }, 404);
  return new Response(body, {
    headers: {
      "content-type": wantThumb ? "image/jpeg" : row.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
    },
  });
});

photoRoutes.delete("/photos/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(taskAttachments).where(and(eq(taskAttachments.id, id), isNull(taskAttachments.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (row.uploadedById !== me.id && me.role !== "admin") return c.json({ error: "רק מי שהעלה את התמונה (או המנהל הראשי) יכול למחוק אותה" }, 403);
  await db.update(taskAttachments).set({ deletedAt: nowIso(), deletedById: me.id }).where(eq(taskAttachments.id, id)).run();
  await c.env.FILES.delete(row.kvKey);
  if (row.thumbKey) await c.env.FILES.delete(row.thumbKey);
  await db.insert(taskEvents).values({ taskId: row.taskId, actorId: me.id, type: "photo_removed", note: row.fileName }).run();
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, row.taskId, me, "photo_removed", { extra: row.fileName }));
  return c.json({ ok: true });
});
