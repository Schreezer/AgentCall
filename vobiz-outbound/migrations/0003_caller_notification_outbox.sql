CREATE TABLE vobiz_caller_notification_outbox (
  call_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (call_id) REFERENCES vobiz_inbound_calls(id)
);

CREATE INDEX vobiz_caller_notification_due
  ON vobiz_caller_notification_outbox(status, next_attempt_at, created_at);
