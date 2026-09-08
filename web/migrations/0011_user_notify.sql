-- Migration number: 0011
-- Per-person notifications switch (0 = no task notices, reminders or reports; login codes still go out).
ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
