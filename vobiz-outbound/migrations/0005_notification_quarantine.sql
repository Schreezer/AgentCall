ALTER TABLE vobiz_caller_notification_outbox
  ADD COLUMN quarantined_at INTEGER;

ALTER TABLE vobiz_caller_notification_outbox
  ADD COLUMN quarantine_reason TEXT;

DROP INDEX vobiz_caller_notification_due;

CREATE INDEX vobiz_caller_notification_due
  ON vobiz_caller_notification_outbox(status, quarantined_at, next_attempt_at, created_at);
