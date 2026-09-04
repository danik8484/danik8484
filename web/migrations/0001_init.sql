-- Migration number: 0001
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  manager_id INTEGER REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_codes_email_idx ON login_codes(email, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE recurring_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  created_by_id INTEGER NOT NULL REFERENCES users(id),
  weekdays TEXT NOT NULL, -- comma separated 0..6 (0 = Sunday)
  start_date TEXT NOT NULL, -- YYYY-MM-DD
  active INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  deleted_by_id INTEGER REFERENCES users(id),
  delete_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  created_by_id INTEGER NOT NULL REFERENCES users(id),
  due_date TEXT NOT NULL, -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  progress_note TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  completed_date TEXT, -- YYYY-MM-DD in local timezone
  completed_by_id INTEGER REFERENCES users(id),
  recurring_id INTEGER REFERENCES recurring_tasks(id),
  deleted_at TEXT,
  deleted_by_id INTEGER REFERENCES users(id),
  delete_reason TEXT,
  created_date TEXT NOT NULL, -- YYYY-MM-DD in local timezone
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX tasks_recurring_unique ON tasks(recurring_id, due_date) WHERE recurring_id IS NOT NULL;
CREATE INDEX tasks_assignee_due_idx ON tasks(assignee_id, due_date);
CREATE INDEX tasks_status_idx ON tasks(status);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- created | status | note | edited | reassigned | deleted
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX task_events_task_idx ON task_events(task_id);
CREATE INDEX task_events_created_idx ON task_events(created_at);

-- Initial team. Emails are set by the admin from the "users" screen (or via ADMIN_EMAIL for the admin on first login).
INSERT INTO users (id, name, role, manager_id, sort_order) VALUES
  (1, 'דני שקנבסקי', 'admin', NULL, 1),
  (2, 'רון וליצ''קו', 'manager', 1, 2),
  (3, 'אורי שפירא', 'employee', 2, 3),
  (4, 'דני קגנוביץ', 'employee', 1, 4),
  (5, 'אורי חסקל', 'employee', 1, 5);
