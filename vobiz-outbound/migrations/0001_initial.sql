CREATE TABLE vobiz_pstn_calls (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction = 'outbound'),
  from_number TEXT,
  to_number TEXT NOT NULL,
  instructions TEXT NOT NULL,
  opening_speech TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'queued', 'ringing', 'connected', 'completed', 'failed', 'canceled', 'dispatch_unknown')),
  summary TEXT,
  provider_status TEXT,
  vobiz_call_uuid TEXT UNIQUE,
  callback_token_hash TEXT NOT NULL,
  bridge_claimed_at INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX vobiz_pstn_calls_created_at ON vobiz_pstn_calls(created_at DESC);

CREATE TABLE vobiz_callback_nonces (
  nonce TEXT PRIMARY KEY,
  path_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX vobiz_callback_nonces_received_at ON vobiz_callback_nonces(received_at);

CREATE TABLE request_rates (
  name TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
