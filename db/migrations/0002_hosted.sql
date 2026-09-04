-- Additive hosted schema for autonomy, moderation, artifacts, and multi-character accounts.
-- Also applied at runtime by NeonStore.ensureSchema() so production can self-heal.

DROP INDEX IF EXISTS characters_owner_unique;
CREATE INDEX IF NOT EXISTS characters_owner_idx ON characters (owner_id);

ALTER TABLE characters ADD COLUMN IF NOT EXISTS reputation integer NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS location_id text;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false;

ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS claimed_at bigint;
ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE world_events ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
ALTER TABLE world_events ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE world_events ADD COLUMN IF NOT EXISTS conversation_id text;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS location_id text;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id text NOT NULL,
  character_id text NOT NULL,
  joined_at bigint NOT NULL,
  PRIMARY KEY (conversation_id, character_id)
);

CREATE TABLE IF NOT EXISTS world_artifacts (
  id text PRIMARY KEY,
  location_id text NOT NULL,
  character_id text,
  character_name text,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id text PRIMARY KEY,
  reporter_id text NOT NULL,
  character_id text,
  event_id text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at bigint NOT NULL,
  resolved_at bigint,
  resolver_id text
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count integer NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_alerts (
  id text PRIMARY KEY,
  level text NOT NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  detail text,
  created_at bigint NOT NULL
);
