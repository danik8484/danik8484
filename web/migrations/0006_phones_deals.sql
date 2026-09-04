-- Migration number: 0006
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE tasks ADD COLUMN deals_json TEXT;
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT;
ALTER TABLE task_attachments ADD COLUMN thumb_key TEXT;
