-- Migration number: 0007
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN reminder_at TEXT;
ALTER TABLE tasks ADD COLUMN reminder_last_sent_at TEXT;
ALTER TABLE tasks ADD COLUMN reminder_by_id INTEGER REFERENCES users(id);
CREATE INDEX tasks_reminder_idx ON tasks(reminder_at) WHERE reminder_at IS NOT NULL;
