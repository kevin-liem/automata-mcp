-- Keep the visibility map of messages current, so the per-session counts in
-- GET /sessions/:id/state stay index-only scans on messages_live_by_session
-- (0003, #183). At the default 20% thresholds the table took ~30k inserts an
-- hour and constant tombstone updates between vacuums: a third of its pages
-- were not all-visible, and the busiest session's count read ~1.5M heap rows
-- per call until it timed out (#208).
--
-- Storage parameters only: SHARE UPDATE EXCLUSIVE, which blocks neither reads
-- nor writes. VACUUM itself cannot run inside this transaction and needn't —
-- autovacuum picks the table up at these thresholds within minutes.
ALTER TABLE messages SET (
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_scale_factor = 0.02
);
