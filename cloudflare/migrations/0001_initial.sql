PRAGMA foreign_keys = ON;

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  installation_secret_hash TEXT NOT NULL,
  agent_token_hash TEXT,
  pairing_code TEXT,
  pairing_expires_at INTEGER,
  paired_at INTEGER,
  device_token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  device_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX installations_agent_token_hash
  ON installations(agent_token_hash)
  WHERE agent_token_hash IS NOT NULL;

CREATE UNIQUE INDEX installations_pairing_code
  ON installations(pairing_code)
  WHERE pairing_code IS NOT NULL;

CREATE TABLE audio (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (installation_id, idempotency_key)
);

CREATE INDEX audio_expiry ON audio(expires_at);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  caller_name TEXT NOT NULL,
  message TEXT NOT NULL,
  audio_id TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'delivering', 'delivered', 'failed')),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivery_errors TEXT NOT NULL DEFAULT '[]',
  UNIQUE (installation_id, idempotency_key)
);

CREATE INDEX calls_due ON calls(status, scheduled_at);
CREATE INDEX calls_installation ON calls(installation_id, created_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
