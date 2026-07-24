-- 0005_pair_codes.sql — short-lived pairing codes + brute-force lockout.
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pair_codes_device ON pair_codes(device_id);

CREATE TABLE IF NOT EXISTS pair_attempts (
  source_ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
