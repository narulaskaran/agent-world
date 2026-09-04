-- Hosted Agent World schema for Neon Postgres.
-- Apply this migration before pointing a Vercel deployment at DATABASE_URL.

CREATE TABLE IF NOT EXISTS world_state (
  id integer PRIMARY KEY CHECK (id = 1),
  simulation_paused boolean NOT NULL DEFAULT false,
  paused_at bigint NOT NULL DEFAULT 0,
  server_daily_budget_micros bigint NOT NULL DEFAULT 2000000,
  server_spent_today_micros bigint NOT NULL DEFAULT 0,
  budget_date text NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  personality text NOT NULL,
  model text NOT NULL,
  daily_budget_micros bigint NOT NULL,
  spent_today_micros bigint NOT NULL DEFAULT 0,
  budget_date text NOT NULL,
  decision_interval_seconds integer NOT NULL DEFAULT 60,
  next_decision_at bigint NOT NULL,
  last_reaction_at bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active',
  x double precision NOT NULL,
  y double precision NOT NULL,
  target_x double precision NOT NULL,
  target_y double precision NOT NULL,
  movement_started_at bigint NOT NULL,
  movement_arrives_at bigint NOT NULL,
  intent text NOT NULL DEFAULT 'Taking in the world',
  speech text,
  speech_expires_at bigint,
  avatar_url text,
  avatar_color text NOT NULL,
  tool_active boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  current_conversation_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_unique
  ON characters (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS characters_owner_unique
  ON characters (owner_id);

CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  character_id text NOT NULL,
  kind text NOT NULL,
  bullet text NOT NULL,
  subject text,
  confidence double precision NOT NULL DEFAULT .7,
  source_event_id text,
  active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  character_id text NOT NULL,
  other_character_id text NOT NULL,
  impression text NOT NULL,
  affinity integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL,
  PRIMARY KEY (character_id, other_character_id)
);
CREATE TABLE IF NOT EXISTS world_events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  character_id text,
  character_name text,
  target_character_id text,
  summary text NOT NULL,
  detail text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS world_events_created_at_idx ON world_events (created_at DESC);

CREATE TABLE IF NOT EXISTS character_queue (
  id text PRIMARY KEY,
  character_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  dedupe_key text,
  not_before bigint NOT NULL,
  expires_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS character_queue_dedupe_pending
  ON character_queue (character_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS character_queue_ready_idx
  ON character_queue (status, not_before, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  character_a_id text NOT NULL,
  character_b_id text NOT NULL,
  status text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  started_at bigint NOT NULL,
  ended_at bigint,
  termination_reason text
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  character_id text NOT NULL,
  character_name text NOT NULL,
  turn integer NOT NULL,
  text text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_entries (
  id text PRIMARY KEY,
  character_id text,
  category text NOT NULL,
  provider text NOT NULL,
  amount_micros bigint NOT NULL,
  reserved_micros bigint NOT NULL,
  status text NOT NULL,
  latency_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_date text NOT NULL,
  created_at bigint NOT NULL
);

INSERT INTO world_state (id, budget_date, updated_at)
VALUES (1, to_char(current_date, 'YYYY-MM-DD'), (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
