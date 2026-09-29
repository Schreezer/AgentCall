-- Existing pending alerts may have been sent with the generic body before acknowledgement.
-- Keep that exact body on retry so the Caller relay's idempotency key remains valid.
ALTER TABLE vobiz_caller_notification_outbox
  ADD COLUMN message TEXT NOT NULL
  DEFAULT 'Hermes answered an incoming call. Ask Hermes for the call result.';
