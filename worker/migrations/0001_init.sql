CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  system_id TEXT,
  event_type TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('active', 'recovered', 'test')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source_time TEXT,
  created_at TEXT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_device_alert ON events(device_id, alert_key, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_states (
  device_id TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  latest_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, alert_key)
);
