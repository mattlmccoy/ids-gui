CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY,
  system_id TEXT,
  connection TEXT NOT NULL,
  telemetry_json TEXT NOT NULL,
  source_time TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_status_updated_at ON device_status(updated_at DESC);
