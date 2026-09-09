-- Migration number: 0012
-- Two-step 'training program' tasks: build the program for a trainee, then send it.
ALTER TABLE tasks ADD COLUMN program_for TEXT;
ALTER TABLE tasks ADD COLUMN program_stage TEXT;
