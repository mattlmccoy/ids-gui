CREATE TABLE IF NOT EXISTS remote_commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_value REAL,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'executed', 'rejected', 'expired')),
  completed_at TEXT,
  result_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_commands_device_status
  ON remote_commands(device_id, status, created_at DESC);
