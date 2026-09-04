import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_meta.sql";
import m0003 from "../../migrations/0003_login_links.sql";
import m0004 from "../../migrations/0004_attachments.sql";
import m0005 from "../../migrations/0005_notifications.sql";
import type { Env } from "./env";

/**
 * Self-applying schema: runs any migration not yet applied, on first use of an isolate.
 * Coexists with `wrangler d1 migrations apply` (its d1_migrations table is honoured).
 */
const MIGRATIONS: [string, string][] = [
  ["0001_init.sql", m0001],
  ["0002_meta.sql", m0002],
  ["0003_login_links.sql", m0003],
  ["0004_attachments.sql", m0004],
  ["0005_notifications.sql", m0005],
];

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = runMigrations(env).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigrations(env: Env): Promise<void> {
  const DB = env.DB;
  await DB.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const applied = new Set<string>();
  for (const r of (await DB.prepare("SELECT name FROM _migrations").all<{ name: string }>()).results) applied.add(r.name);
  try {
    for (const r of (await DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results) applied.add(r.name);
  } catch {
    // wrangler's migrations table does not exist – fine
  }

  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    const stmts = splitStatements(sql).map((s) => DB.prepare(s));
    stmts.push(DB.prepare("INSERT INTO _migrations (name) VALUES (?)").bind(name));
    await DB.batch(stmts);
    console.log(`applied migration ${name}`);
  }

  // First-admin bootstrap: a one-time login link whose hash was passed at deploy time.
  if (env.BOOTSTRAP_ADMIN_LINK_HASH) {
    const now = Date.now();
    await DB.prepare(
      "INSERT OR IGNORE INTO login_links (token_hash, user_id, created_by_id, expires_at, created_at) VALUES (?, 1, NULL, ?, ?)",
    )
      .bind(env.BOOTSTRAP_ADMIN_LINK_HASH, now + 7 * 24 * 60 * 60 * 1000, now)
      .run();
  }
}
