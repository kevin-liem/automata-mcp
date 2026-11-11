-- A per-session cap on how far back backfill reaches, in days, set by the app
-- when pairing starts (its plan's limit). NULL = the deployment's
-- TELEGRAM_BACKFILL_DAYS. The lower of the two applies, so a session can be
-- held below the deployment's setting but never lifted above it.
ALTER TABLE sessions
  ADD COLUMN backfill_days integer CHECK (backfill_days >= 0);
