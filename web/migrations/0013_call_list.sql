-- Migration number: 0013
-- Shared call list: anyone adds a person to call; whoever takes a row schedules the call, which becomes a task with a reminder.
CREATE TABLE call_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',
  taken_by_id INTEGER,
  scheduled_at TEXT,
  task_id INTEGER,
  done_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX call_items_status_idx ON call_items(status);
CREATE INDEX call_items_task_idx ON call_items(task_id);
