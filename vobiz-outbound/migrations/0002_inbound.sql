CREATE TABLE vobiz_inbound_calls (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction = 'inbound'),
  from_number TEXT,
  to_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'completed', 'failed', 'blocked_disabled')),
  summary TEXT,
  inbound_report TEXT,
  provider_status TEXT,
  vobiz_call_uuid TEXT NOT NULL UNIQUE,
  bridge_claimed_at INTEGER,
  bridge_connected_at INTEGER,
  bridge_terminal_event TEXT CHECK (bridge_terminal_event IN ('ended', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX vobiz_inbound_calls_created_at ON vobiz_inbound_calls(created_at DESC);

CREATE TABLE vobiz_inbound_callback_nonces (
  nonce TEXT PRIMARY KEY,
  path_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
