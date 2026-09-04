import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { eq } from "drizzle-orm";
import type { Env } from "./env";
import type { Db } from "./db/client";
import { appMeta, pushSubscriptions } from "./db/schema";

/**
 * VAPID keys are generated once and kept in the database (app_meta), so no
 * secret has to be configured anywhere. The public key is handed to browsers.
 */
export interface Vapid {
  publicKey: string; // base64url, uncompressed P-256 point
  privateKey: string; // base64url, 32-byte scalar (JWK "d")
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

let cached: Vapid | null = null;

export async function getVapid(db: Db): Promise<Vapid> {
  if (cached) return cached;
  const pub = await db.select().from(appMeta).where(eq(appMeta.key, "vapid_public")).get();
  const priv = await db.select().from(appMeta).where(eq(appMeta.key, "vapid_private")).get();
  if (pub && priv) {
    cached = { publicKey: pub.value, privateKey: priv.value };
    return cached;
  }
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwkPub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwkPriv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const x = fromB64url(jwkPub.x!);
  const y = fromB64url(jwkPub.y!);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  const keys: Vapid = { publicKey: b64url(raw), privateKey: jwkPriv.d! };
  await db.insert(appMeta).values({ key: "vapid_public", value: keys.publicKey }).onConflictDoNothing().run();
  await db.insert(appMeta).values({ key: "vapid_private", value: keys.privateKey }).onConflictDoNothing().run();
  // Re-read in case another isolate won the race
  const pub2 = await db.select().from(appMeta).where(eq(appMeta.key, "vapid_public")).get();
  const priv2 = await db.select().from(appMeta).where(eq(appMeta.key, "vapid_private")).get();
  cached = { publicKey: pub2!.value, privateKey: priv2!.value };
  return cached;
}

export interface PushContent {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Send to every device of a user. Returns how many deliveries succeeded. */
export async function pushToUser(env: Env, db: Db, userId: number, content: PushContent): Promise<number> {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
  if (subs.length === 0) return 0;
  const vapid = await getVapid(db);
  let ok = 0;
  for (const sub of subs) {
    const subscription: PushSubscription = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      const payload = await buildPushPayload(
        { data: { title: content.title, body: content.body, url: content.url ?? "/", tag: content.tag ?? "general" }, options: { ttl: 6 * 60 * 60, urgency: "normal" } },
        subscription,
        { subject: env.VAPID_SUBJECT || "mailto:admin@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      );
      const res = await fetch(sub.endpoint, payload);
      if (res.ok || res.status === 201) {
        ok++;
        if (sub.failures > 0) await db.update(pushSubscriptions).set({ failures: 0, lastError: null }).where(eq(pushSubscriptions.id, sub.id)).run();
      } else if (res.status === 404 || res.status === 410) {
        // Subscription expired / unsubscribed on the device
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
      } else {
        await bumpFailure(db, sub.id, sub.failures, `HTTP ${res.status}`);
      }
    } catch (e) {
      await bumpFailure(db, sub.id, sub.failures, (e as Error).message);
    }
  }
  return ok;
}

async function bumpFailure(db: Db, id: number, failures: number, err: string) {
  if (failures + 1 >= 20) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
  else await db.update(pushSubscriptions).set({ failures: failures + 1, lastError: err.slice(0, 200) }).where(eq(pushSubscriptions.id, id)).run();
}
