PRAGMA foreign_keys = ON;

CREATE TABLE hermes_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES hermes_operations(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  voice_session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX hermes_operation_events_voice_session
  ON hermes_operation_events(installation_id, voice_session_id, id);
