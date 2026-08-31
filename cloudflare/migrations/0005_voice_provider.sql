ALTER TABLE voice_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'xai';

CREATE INDEX voice_sessions_provider
  ON voice_sessions(provider, expires_at);
