-- Migration number: 0008
-- A fourth role, 'coordinator' (רכז): sees every board except the admin's, adds tasks to anyone, manages nobody.
-- SQLite cannot alter a CHECK constraint, so the users table is rebuilt in place.
--
-- Every other table references users(id). Inside this atomic batch the foreign-key checks are deferred:
-- dropping "users" counts one outstanding violation per child row, and re-inserting the very same rows into
-- the new table named "users" settles them again, so the batch commits clean. (Renaming a table does NOT
-- settle the counter – that is why the rows are copied aside, the table is dropped and rebuilt under its
-- own name, and the rows are inserted back afterwards.)
-- The AUTOINCREMENT counter is kept as well, so an id that was ever handed out is never reused.
PRAGMA defer_foreign_keys = on;

CREATE TABLE users_rebuild_copy AS SELECT id, name, email, role, manager_id, sort_order, active, created_at, reminder_sent_date, phone FROM users;
CREATE TABLE users_rebuild_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'users';

DROP TABLE users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee', 'coordinator')),
  manager_id INTEGER REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reminder_sent_date TEXT,
  phone TEXT
);

INSERT INTO users (id, name, email, role, manager_id, sort_order, active, created_at, reminder_sent_date, phone)
  SELECT id, name, email, role, manager_id, sort_order, active, created_at, reminder_sent_date, phone FROM users_rebuild_copy ORDER BY id;

UPDATE sqlite_sequence SET seq = max(seq, (SELECT coalesce(max(seq), 0) FROM users_rebuild_seq)) WHERE name = 'users';

DROP TABLE users_rebuild_copy;
DROP TABLE users_rebuild_seq;
