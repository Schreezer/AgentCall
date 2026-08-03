ALTER TABLE installations ADD COLUMN device_identity_hash TEXT;

CREATE UNIQUE INDEX installations_device_identity_hash
  ON installations(device_identity_hash)
  WHERE device_identity_hash IS NOT NULL;
