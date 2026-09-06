-- Migration number: 0010
-- Reminder loops with a chosen interval (minutes between repeats; NULL = 30, the old fixed spacing),
-- and the once-a-day bookkeeping for the morning task report.
ALTER TABLE tasks ADD COLUMN reminder_every_min INTEGER;
ALTER TABLE users ADD COLUMN morning_sent_date TEXT;
