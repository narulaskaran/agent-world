-- Agent World hosted wallet/payment schema. No secrets or raw vendor payloads are stored.
CREATE TABLE IF NOT EXISTS user_wallets (
  owner_id text PRIMARY KEY,
  provider_user_id text NOT NULL UNIQUE,
  provider_wallet_id text NOT NULL UNIQUE,
  address text NOT NULL,
  chain text NOT NULL DEFAULT 'tempo',
  asset text NOT NULL DEFAULT 'USDC',
  consent_version text,
  consent_at bigint,
  consent_actor text,
  delegated boolean NOT NULL DEFAULT false,
  revoked boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_provisioning_operations (
  owner_id text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE,
  provider_user_id text,
  provider_wallet_id text,
  address text,
  chain text,
  asset text,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS funding_attempts (
  owner_id text NOT NULL,
  idempotency_key text NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0 AND amount_micros <= 1000000),
  wallet_address text NOT NULL,
  consent_version text NOT NULL,
  policy_snapshot jsonb,
  pause_generations jsonb NOT NULL DEFAULT '{"global":0,"user":0,"tool":0}'::jsonb,
  provider_phase text NOT NULL DEFAULT 'not_started',
  status text NOT NULL,
  session jsonb,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  operation_id text PRIMARY KEY,
  owner_id text NOT NULL,
  tool_id text NOT NULL,
  manifest_version integer NOT NULL,
  max_total_micros bigint NOT NULL CHECK (max_total_micros >= 0),
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  actual_micros bigint CHECK (actual_micros IS NULL OR actual_micros >= 0),
  state text NOT NULL CHECK (state IN ('reserved','challenged','authorized','submitted','unknown','settled','rejected','expired','cancelled','reconciled_failed')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  provider_reference text,
  receipt_reference text,
  transaction_reference text,
  receipt_hash text,
  receipt_evidence jsonb,
  request_digest text,
  manifest_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pause_generation bigint NOT NULL DEFAULT 0,
  pause_generations jsonb NOT NULL DEFAULT '{"global":0,"user":0,"tool":0}'::jsonb,
  authorization_provider_idempotency_key text,
  provider_phase text NOT NULL DEFAULT 'not_started',
  authorization_claim_token text,
  authorization_claimed_at bigint,
  consent_version text,
  payer_address text,
  version bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_provider_reference_idx ON payment_attempts(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_receipt_reference_idx ON payment_attempts(receipt_reference) WHERE receipt_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_transaction_reference_idx ON payment_attempts(transaction_reference) WHERE transaction_reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_quotas (owner_id text PRIMARY KEY, daily_limit_micros bigint NOT NULL, updated_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS user_daily_spend (owner_id text NOT NULL, spend_date date NOT NULL, daily_limit_micros bigint NOT NULL, reserved_micros bigint NOT NULL DEFAULT 0, settled_micros bigint NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL, PRIMARY KEY (owner_id, spend_date));
CREATE TABLE IF NOT EXISTS spend_pauses (scope text PRIMARY KEY, paused boolean NOT NULL DEFAULT false, generation bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS tool_manifests (id text NOT NULL, version integer NOT NULL, active boolean NOT NULL DEFAULT false, reviewed boolean NOT NULL DEFAULT false, manifest jsonb NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS tool_manifest_current (id text PRIMARY KEY, version integer NOT NULL, activated_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS payment_audit (
  id text PRIMARY KEY,
  operation_id text,
  owner_id text NOT NULL,
  actor text NOT NULL,
  event text NOT NULL,
  state text,
  provider_phase text,
  amount_micros bigint,
  receipt_reference text,
  evidence_hash text,
  manifest_snapshot jsonb,
  consent_version text,
  pause_generations jsonb,
  request_digest text,
  transition_version bigint,
  provider_reference text,
  transaction_reference text,
  receipt_evidence jsonb,
  created_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION prevent_payment_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment audit is immutable'; END; $$;
DROP TRIGGER IF EXISTS payment_audit_immutable ON payment_audit;
CREATE TRIGGER payment_audit_immutable BEFORE UPDATE OR DELETE ON payment_audit FOR EACH ROW EXECUTE FUNCTION prevent_payment_audit_mutation();
