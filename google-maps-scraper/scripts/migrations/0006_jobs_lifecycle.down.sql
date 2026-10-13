BEGIN;
DROP INDEX IF EXISTS idx_gmaps_jobs_lease;
DROP INDEX IF EXISTS idx_gmaps_jobs_claim;
ALTER TABLE gmaps_jobs DROP COLUMN IF EXISTS last_error;
ALTER TABLE gmaps_jobs DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE gmaps_jobs DROP COLUMN IF EXISTS heartbeat_at;
ALTER TABLE gmaps_jobs DROP COLUMN IF EXISTS max_attempts;
COMMIT;
