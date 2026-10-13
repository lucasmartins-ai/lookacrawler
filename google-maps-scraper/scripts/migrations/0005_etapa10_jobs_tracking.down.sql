BEGIN;
ALTER TABLE gmaps_jobs DROP COLUMN updated_at;
ALTER TABLE gmaps_jobs DROP COLUMN worker_id;
ALTER TABLE gmaps_jobs DROP COLUMN attempts;
COMMIT;
