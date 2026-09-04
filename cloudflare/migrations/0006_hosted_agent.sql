ALTER TABLE installations ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'external';
ALTER TABLE installations ADD COLUMN hosted_agent_enabled_at INTEGER;

CREATE INDEX installations_agent_mode ON installations(agent_mode);
