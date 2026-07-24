-- 0004_command_payload.sql — carry the raw single-key command JSON alongside the numeric value.
ALTER TABLE remote_commands ADD COLUMN command_payload TEXT;
