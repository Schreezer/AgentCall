PRAGMA foreign_keys = ON;

ALTER TABLE installations ADD COLUMN alert_device_token TEXT;

ALTER TABLE calls ADD COLUMN mode TEXT NOT NULL DEFAULT 'message';
ALTER TABLE calls ADD COLUMN call_context_json TEXT;
ALTER TABLE calls ADD COLUMN origin_hermes_session_id TEXT;
ALTER TABLE calls ADD COLUMN request_hash TEXT;
ALTER TABLE calls ADD COLUMN answered_at INTEGER;

CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  mcp_token_hash TEXT NOT NULL UNIQUE,
  origin_hermes_session_id TEXT,
  active_lineage_id TEXT,
  granted_operation_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX voice_sessions_installation
  ON voice_sessions(installation_id, created_at);

CREATE TABLE hermes_operations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  voice_session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  lineage_id TEXT,
  workflow_id TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  hermes_session_id TEXT,
  hermes_run_id TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (voice_session_id, replay_key)
);

CREATE INDEX hermes_operations_installation
  ON hermes_operations(installation_id, created_at);

CREATE TABLE hermes_approvals (
  operation_id TEXT PRIMARY KEY REFERENCES hermes_operations(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL UNIQUE,
  details_json TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER
);

CREATE TABLE approval_outbox (
  notification_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES hermes_operations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX approval_outbox_pending ON approval_outbox(status, created_at);
