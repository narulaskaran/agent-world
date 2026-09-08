-- Persist last successful /api/jobs/run world tick so AGENT_WORLD_TICK_INTERVAL_MIN
-- can skip autonomy drain even when QStash still fires every 10 minutes.
-- Also applied at runtime by NeonStore.ensureSchema() on mutations and /jobs/run.

ALTER TABLE world_state ADD COLUMN IF NOT EXISTS last_tick_at bigint NOT NULL DEFAULT 0;
