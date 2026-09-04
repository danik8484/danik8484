-- Migration number: 0005
ALTER TABLE recurring_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN metric_deals INTEGER;
ALTER TABLE tasks ADD COLUMN metric_calls INTEGER;
ALTER TABLE users ADD COLUMN reminder_sent_date TEXT;

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);

CREATE TABLE notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX notification_queue_pending_idx ON notification_queue(sent_at, user_id);

-- Daily lead-followup task for the sales people (Ron, Uri Shapira), Sunday to Friday
INSERT INTO recurring_tasks (title, details, assignee_id, created_by_id, weekdays, start_date, kind)
  SELECT 'ביצוע לידים', 'מעקב ושיחות עם לידים. בסיום אפשר לרשום כמות נסלקים וכמות שיחות.', 2, 1, '0,1,2,3,4,5', date('now'), 'leads'
  WHERE EXISTS (SELECT 1 FROM users WHERE id = 2);
INSERT INTO recurring_tasks (title, details, assignee_id, created_by_id, weekdays, start_date, kind)
  SELECT 'ביצוע לידים', 'מעקב ושיחות עם לידים. בסיום אפשר לרשום כמות נסלקים וכמות שיחות.', 3, 1, '0,1,2,3,4,5', date('now'), 'leads'
  WHERE EXISTS (SELECT 1 FROM users WHERE id = 3);
