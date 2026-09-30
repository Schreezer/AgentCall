ALTER TABLE vobiz_pstn_calls
  ADD COLUMN bridge_terminal_event TEXT
    CHECK (bridge_terminal_event IN ('ended', 'failed'));

ALTER TABLE vobiz_pstn_calls
  ADD COLUMN provider_terminal_outcome TEXT
    CHECK (provider_terminal_outcome IN ('completed', 'failed', 'canceled'));
