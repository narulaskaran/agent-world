import { AsyncLocalStorage } from "node:async_hooks";
import type { WorldArtifact, WorldLocationId } from "../../shared/src/index.js";
import { ConflictError, isDatabaseUnavailable } from "./errors.js";
import { logEvent } from "./logging.js";
import { PaymentError } from "./wallet-payment.js";
import type {
  AuditEntry,
  FundingAttempt,
  Payment,
  PaymentGenerations,
  PaymentTransitionResult,
  PaymentTransition,
  SpendPause,
  ToolManifest,
  Wallet,
  WalletProvisioningOperation,
} from "./wallet-payment.js";
import type {
  AlertRow,
  CharacterRow,
  ConversationRow,
  CostRow,
  EventRow,
  HostedStore,
  MemoryRow,
  QueueJob,
  RelationshipRow,
  ReportRow,
  WorldStateRow,
} from "./store.js";

export type NeonSql = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, any>[]>) & {
  query: (text: string, params?: unknown[]) => Promise<Record<string, any>[]>;
  begin?: <T>(fn: (sql: NeonSql) => Promise<T>) => Promise<T>;
  transaction?: <T>(fn: (sql: NeonSql) => Promise<T>) => Promise<T>;
};

const WORLD_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS world_state (
    id integer PRIMARY KEY CHECK (id = 1),
    simulation_paused boolean NOT NULL DEFAULT false,
    paused_at bigint NOT NULL DEFAULT 0,
    server_daily_budget_micros bigint NOT NULL DEFAULT 2000000,
    server_spent_today_micros bigint NOT NULL DEFAULT 0,
    budget_date text NOT NULL DEFAULT '',
    updated_at bigint NOT NULL DEFAULT 0
  )`,
  `INSERT INTO world_state (id, budget_date, updated_at)
    VALUES (1, to_char(current_date, 'YYYY-MM-DD'), (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS characters (
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
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS characters_name_unique ON characters (lower(name))",
  `CREATE TABLE IF NOT EXISTS memories (
    id text PRIMARY KEY,
    character_id text NOT NULL,
    kind text NOT NULL,
    bullet text NOT NULL,
    subject text,
    confidence double precision NOT NULL DEFAULT .7,
    source_event_id text,
    active boolean NOT NULL DEFAULT true,
    created_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS relationships (
    character_id text NOT NULL,
    other_character_id text NOT NULL,
    impression text NOT NULL,
    affinity integer NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    PRIMARY KEY (character_id, other_character_id)
  )`,
  `CREATE TABLE IF NOT EXISTS world_events (
    id text PRIMARY KEY,
    kind text NOT NULL,
    character_id text,
    character_name text,
    target_character_id text,
    summary text NOT NULL,
    detail text,
    created_at bigint NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS world_events_created_at_idx ON world_events (created_at DESC)",
  `CREATE TABLE IF NOT EXISTS character_queue (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS character_queue_dedupe_pending
    ON character_queue (character_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS character_queue_ready_idx
    ON character_queue (status, not_before, priority DESC, created_at)`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id text PRIMARY KEY,
    character_a_id text NOT NULL,
    character_b_id text NOT NULL,
    status text NOT NULL,
    message_count integer NOT NULL DEFAULT 0,
    started_at bigint NOT NULL,
    ended_at bigint,
    termination_reason text
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
    id text PRIMARY KEY,
    conversation_id text NOT NULL,
    character_id text NOT NULL,
    character_name text NOT NULL,
    turn integer NOT NULL,
    text text NOT NULL,
    created_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cost_entries (
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
  )`,
  "DROP INDEX IF EXISTS characters_owner_unique",
  "CREATE INDEX IF NOT EXISTS characters_owner_idx ON characters (owner_id)",
  "ALTER TABLE characters ADD COLUMN IF NOT EXISTS reputation integer NOT NULL DEFAULT 0",
  "ALTER TABLE characters ADD COLUMN IF NOT EXISTS location_id text",
  "ALTER TABLE characters ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false",
  "ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0",
  "ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS claimed_at bigint",
  "ALTER TABLE character_queue ADD COLUMN IF NOT EXISTS last_error text",
  "ALTER TABLE world_events ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'",
  "ALTER TABLE world_events ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false",
  "ALTER TABLE world_events ADD COLUMN IF NOT EXISTS conversation_id text",
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'",
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS location_id text",
  `CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id text NOT NULL,
    character_id text NOT NULL,
    joined_at bigint NOT NULL,
    PRIMARY KEY (conversation_id, character_id)
  )`,
  `CREATE TABLE IF NOT EXISTS world_artifacts (
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
  )`,
  `CREATE TABLE IF NOT EXISTS moderation_reports (
    id text PRIMARY KEY,
    reporter_id text NOT NULL,
    character_id text,
    event_id text,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    created_at bigint NOT NULL,
    resolved_at bigint,
    resolver_id text
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key text PRIMARY KEY,
    window_start bigint NOT NULL,
    count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operator_alerts (
    id text PRIMARY KEY,
    level text NOT NULL,
    kind text NOT NULL,
    summary text NOT NULL,
    detail text,
    created_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS viewer_presence (
    viewer_key text PRIMARY KEY,
    seen_at bigint NOT NULL
  )`,
];

const WALLET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_wallets (owner_id text PRIMARY KEY, provider_user_id text NOT NULL UNIQUE, provider_wallet_id text NOT NULL UNIQUE, address text NOT NULL, chain text NOT NULL DEFAULT 'tempo', asset text NOT NULL DEFAULT 'USDC', consent_version text, consent_at bigint, consent_actor text, delegated boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false, created_at bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS wallet_provisioning_operations (owner_id text NOT NULL, idempotency_key text NOT NULL, status text NOT NULL, provider_idempotency_key text NOT NULL UNIQUE, provider_user_id text, provider_wallet_id text, address text, chain text, asset text, error text, created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (owner_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS funding_attempts (owner_id text NOT NULL, idempotency_key text NOT NULL, provider_idempotency_key text NOT NULL UNIQUE, amount_micros bigint NOT NULL CHECK (amount_micros > 0 AND amount_micros <= 1000000), wallet_address text NOT NULL, consent_version text NOT NULL, policy_snapshot jsonb, pause_generations jsonb NOT NULL DEFAULT '{"global":0,"user":0,"tool":0}'::jsonb, provider_phase text NOT NULL DEFAULT 'not_started', status text NOT NULL, session jsonb, error text, created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (owner_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS payment_attempts (operation_id text PRIMARY KEY, owner_id text NOT NULL, tool_id text NOT NULL, manifest_version integer NOT NULL, max_total_micros bigint NOT NULL CHECK (max_total_micros >= 0), reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0), actual_micros bigint CHECK (actual_micros IS NULL OR actual_micros >= 0), state text NOT NULL CHECK (state IN ('reserved','challenged','authorized','submitted','unknown','settled','rejected','expired','cancelled','reconciled_failed')), created_at bigint NOT NULL, updated_at bigint NOT NULL, provider_reference text UNIQUE, receipt_reference text UNIQUE, receipt_hash text, request_digest text NOT NULL, manifest_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, pause_generation bigint NOT NULL DEFAULT 0, pause_generations jsonb NOT NULL DEFAULT '{"global":0,"user":0,"tool":0}'::jsonb, authorization_provider_idempotency_key text, provider_phase text NOT NULL DEFAULT 'not_started', version bigint NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS spend_pauses (scope text PRIMARY KEY, paused boolean NOT NULL DEFAULT false, generation bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS payment_quotas (owner_id text PRIMARY KEY, daily_limit_micros bigint NOT NULL, updated_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user_daily_spend (owner_id text NOT NULL, spend_date date NOT NULL, daily_limit_micros bigint NOT NULL, reserved_micros bigint NOT NULL DEFAULT 0, settled_micros bigint NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, spend_date))`,
  `CREATE TABLE IF NOT EXISTS tool_manifests (id text NOT NULL, version integer NOT NULL, active boolean NOT NULL DEFAULT false, reviewed boolean NOT NULL DEFAULT false, manifest jsonb NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (id, version))`,
  `CREATE TABLE IF NOT EXISTS tool_manifest_current (id text PRIMARY KEY, version integer NOT NULL, activated_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS payment_audit (id text PRIMARY KEY, operation_id text, owner_id text NOT NULL, actor text NOT NULL, event text NOT NULL, state text, provider_phase text, amount_micros bigint, receipt_reference text, evidence_hash text, created_at bigint NOT NULL)`,
  "ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS chain text NOT NULL DEFAULT 'tempo'",
  "ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'USDC'",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS actual_micros bigint",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_reference text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS request_digest text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS manifest_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS pause_generation bigint NOT NULL DEFAULT 0",
  'ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS pause_generations jsonb NOT NULL DEFAULT \'{"global":0,"user":0,"tool":0}\'::jsonb',
  'ALTER TABLE funding_attempts ADD COLUMN IF NOT EXISTS pause_generations jsonb NOT NULL DEFAULT \'{"global":0,"user":0,"tool":0}\'::jsonb',
  "ALTER TABLE funding_attempts ADD COLUMN IF NOT EXISTS provider_phase text NOT NULL DEFAULT 'not_started'",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS authorization_provider_idempotency_key text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_phase text NOT NULL DEFAULT 'not_started'",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS authorization_claim_token text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS authorization_claimed_at bigint",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS consent_version text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS payer_address text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS receipt_evidence jsonb",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS receipt_reference text",
  "ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS transaction_reference text",
  "ALTER TABLE user_daily_spend ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0",
  "CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_transaction_reference_idx ON payment_attempts(transaction_reference) WHERE transaction_reference IS NOT NULL",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS actor text NOT NULL DEFAULT 'system'",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS provider_phase text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS evidence_hash text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS manifest_snapshot jsonb",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS consent_version text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS pause_generations jsonb",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS request_digest text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS transition_version bigint",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS provider_reference text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS transaction_reference text",
  "ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS receipt_evidence jsonb",
  "CREATE OR REPLACE FUNCTION prevent_payment_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''payment audit is immutable''; END;'",
  "DROP TRIGGER IF EXISTS payment_audit_immutable ON payment_audit",
  "CREATE TRIGGER payment_audit_immutable BEFORE UPDATE OR DELETE ON payment_audit FOR EACH ROW EXECUTE PROCEDURE prevent_payment_audit_mutation()",
];

const parsePayload = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return {};
};

const mapCharacter = (row: Record<string, any>): CharacterRow => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  personality: row.personality,
  model: row.model,
  dailyBudgetMicros: Number(row.daily_budget_micros),
  spentTodayMicros: Number(row.spent_today_micros),
  budgetDate: row.budget_date,
  decisionIntervalSeconds: Number(row.decision_interval_seconds),
  nextDecisionAt: Number(row.next_decision_at),
  lastReactionAt: Number(row.last_reaction_at),
  state: row.state,
  x: Number(row.x),
  y: Number(row.y),
  targetX: Number(row.target_x),
  targetY: Number(row.target_y),
  movementStartedAt: Number(row.movement_started_at),
  movementArrivesAt: Number(row.movement_arrives_at),
  intent: row.intent,
  speech: row.speech ?? null,
  speechExpiresAt:
    row.speech_expires_at == null ? null : Number(row.speech_expires_at),
  avatarUrl: row.avatar_url ?? null,
  avatarColor: row.avatar_color,
  toolActive: Boolean(row.tool_active),
  paused: Boolean(row.paused),
  muted: Boolean(row.muted),
  reputation: Number(row.reputation ?? 0),
  locationId: (row.location_id ?? null) as WorldLocationId | null,
  currentConversationId: row.current_conversation_id ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const mapJob = (row: Record<string, any>): QueueJob => ({
  id: row.id,
  characterId: row.character_id,
  kind: row.kind,
  payload: parsePayload(row.payload),
  priority: Number(row.priority),
  dedupeKey: row.dedupe_key ?? null,
  notBefore: Number(row.not_before),
  expiresAt: Number(row.expires_at),
  status: row.status,
  attemptCount: Number(row.attempt_count ?? 0),
  createdAt: Number(row.created_at),
});

export class NeonStore implements HostedStore {
  readonly supportsFinancialTransactions: boolean;
  private readonly context = new AsyncLocalStorage<NeonSql>();
  private schemaReady = false;
  private walletSchemaReady = false;
  private dbBlockedUntil = 0;

  constructor(private readonly root: NeonSql) {
    this.supportsFinancialTransactions = typeof root.begin === "function";
  }

  private sql(): NeonSql {
    return this.context.getStore() ?? this.root;
  }

  private rememberDbError(error: unknown): void {
    if (isDatabaseUnavailable(error)) this.dbBlockedUntil = Date.now() + 60_000;
  }

  private throwIfDbBlocked(): void {
    if (Date.now() < this.dbBlockedUntil)
      throw new Error(
        "Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.",
      );
  }

  async ensureSchema(): Promise<void> {
    this.throwIfDbBlocked();
    try {
      if (!this.schemaReady) {
        for (const statement of WORLD_SCHEMA_STATEMENTS)
          await this.sql().query(statement);
        this.schemaReady = true;
      }
      await this.ensureWalletSchema();
    } catch (error) {
      this.rememberDbError(error);
      throw error;
    }
  }

  private async ensureWalletSchema(): Promise<void> {
    if (this.walletSchemaReady) return;
    let failed: string | undefined;
    for (const statement of WALLET_SCHEMA_STATEMENTS) {
      try {
        await this.sql().query(statement);
      } catch (error) {
        this.rememberDbError(error);
        failed ??=
          error instanceof Error ? error.message.slice(0, 180) : "unknown";
        if (isDatabaseUnavailable(error)) break;
      }
    }
    this.walletSchemaReady = true;
    if (failed)
      logEvent({
        level: "error",
        msg: `wallet schema ensure failed: ${failed}`,
        kind: "WALLET_SCHEMA_UNAVAILABLE",
      });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const sql = this.sql();
    // neon()'s HTTP `transaction()` is a batch of queries (array, or a function
    // that returns an array). It is not an interactive BEGIN callback. Only
    // `begin` supports running arbitrary store methods inside a txn.
    if (typeof sql.begin === "function") {
      return sql.begin(async (txn: NeonSql) => this.context.run(txn, fn));
    }
    throw new Error("durable financial transaction support is unavailable");
  }

  async getWorldState(): Promise<WorldStateRow> {
    this.throwIfDbBlocked();
    try {
      const rows = await this.sql()`SELECT * FROM world_state WHERE id = 1`;
      const row = rows[0] ?? {};
      return {
        simulationPaused: Boolean(row.simulation_paused),
        pausedAt: Number(row.paused_at ?? 0),
        serverDailyBudgetMicros: Number(row.server_daily_budget_micros ?? 0),
        serverSpentTodayMicros: Number(row.server_spent_today_micros ?? 0),
        budgetDate: String(row.budget_date ?? ""),
        updatedAt: Number(row.updated_at ?? 0),
      };
    } catch (error) {
      this.rememberDbError(error);
      throw error;
    }
  }

  async setSimulationPaused(paused: boolean, now: number): Promise<void> {
    await this.sql()`UPDATE world_state SET simulation_paused = ${paused}, paused_at = ${paused ? now : 0}, updated_at = ${now} WHERE id = 1`;
  }

  async setServerBudget(micros: number, now: number): Promise<void> {
    await this.sql()`UPDATE world_state SET server_daily_budget_micros = ${micros}, updated_at = ${now} WHERE id = 1`;
  }

  async resetWorld(now: number): Promise<void> {
    const sql = this.sql();
    for (const table of [
      "conversation_messages",
      "conversation_members",
      "character_queue",
      "memories",
      "relationships",
      "conversations",
      "world_events",
      "world_artifacts",
      "moderation_reports",
      "cost_entries",
      "viewer_presence",
      "characters",
    ])
      await sql.query(`DELETE FROM ${table}`);
    await sql`UPDATE world_state SET simulation_paused = false, paused_at = 0, server_spent_today_micros = 0, budget_date = ${new Date(now).toISOString().slice(0, 10)}, updated_at = ${now} WHERE id = 1`;
  }

  async listCharacters(): Promise<CharacterRow[]> {
    const rows =
      await this.sql()`SELECT * FROM characters ORDER BY created_at ASC`;
    return rows.map(mapCharacter);
  }

  async getCharacter(idOrName: string): Promise<CharacterRow | null> {
    const rows =
      await this.sql()`SELECT * FROM characters WHERE id = ${idOrName} OR lower(name) = lower(${idOrName}) LIMIT 1`;
    return rows[0] ? mapCharacter(rows[0]) : null;
  }

  async findOwned(key: string, ownerId: string): Promise<CharacterRow | null> {
    const rows =
      await this.sql()`SELECT * FROM characters WHERE owner_id = ${ownerId} AND (id = ${key} OR lower(name) = lower(${key})) LIMIT 1`;
    return rows[0] ? mapCharacter(rows[0]) : null;
  }

  async listOwnedIds(ownerId: string): Promise<string[]> {
    const rows =
      await this.sql()`SELECT id FROM characters WHERE owner_id = ${ownerId} ORDER BY created_at ASC`;
    return rows.map((row) => String(row.id));
  }

  async countOwned(ownerId: string): Promise<number> {
    const rows =
      await this.sql()`SELECT count(*)::int AS count FROM characters WHERE owner_id = ${ownerId}`;
    return Number(rows[0]?.count ?? 0);
  }

  async insertCharacter(row: CharacterRow): Promise<void> {
    try {
      await this.sql()`INSERT INTO characters (
        id, owner_id, name, personality, model, daily_budget_micros, spent_today_micros,
        budget_date, decision_interval_seconds, next_decision_at, last_reaction_at, state,
        x, y, target_x, target_y, movement_started_at, movement_arrives_at, intent,
        speech, speech_expires_at, avatar_url, avatar_color, tool_active, paused, muted,
        reputation, location_id, current_conversation_id, created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.ownerId}, ${row.name}, ${row.personality}, ${row.model},
        ${row.dailyBudgetMicros}, ${row.spentTodayMicros}, ${row.budgetDate},
        ${row.decisionIntervalSeconds}, ${row.nextDecisionAt}, ${row.lastReactionAt},
        ${row.state}, ${row.x}, ${row.y}, ${row.targetX}, ${row.targetY},
        ${row.movementStartedAt}, ${row.movementArrivesAt}, ${row.intent},
        ${row.speech}, ${row.speechExpiresAt}, ${row.avatarUrl}, ${row.avatarColor},
        ${row.toolActive}, ${row.paused}, ${row.muted}, ${row.reputation},
        ${row.locationId}, ${row.currentConversationId}, ${row.createdAt}, ${row.updatedAt}
      )`;
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw new ConflictError("That name or account already has a character");
      throw error;
    }
  }

  async updateCharacter(
    id: string,
    patch: Partial<CharacterRow>,
  ): Promise<void> {
    const current = await this.getCharacter(id);
    if (!current) return;
    const next = { ...current, ...patch };
    await this.sql()`UPDATE characters SET
      personality = ${next.personality},
      model = ${next.model},
      daily_budget_micros = ${next.dailyBudgetMicros},
      spent_today_micros = ${next.spentTodayMicros},
      decision_interval_seconds = ${next.decisionIntervalSeconds},
      next_decision_at = ${next.nextDecisionAt},
      last_reaction_at = ${next.lastReactionAt},
      state = ${next.state},
      x = ${next.x}, y = ${next.y}, target_x = ${next.targetX}, target_y = ${next.targetY},
      movement_started_at = ${next.movementStartedAt}, movement_arrives_at = ${next.movementArrivesAt},
      intent = ${next.intent}, speech = ${next.speech}, speech_expires_at = ${next.speechExpiresAt},
      avatar_url = ${next.avatarUrl}, avatar_color = ${next.avatarColor},
      tool_active = ${next.toolActive}, paused = ${next.paused}, muted = ${next.muted},
      reputation = ${next.reputation}, location_id = ${next.locationId},
      current_conversation_id = ${next.currentConversationId}, updated_at = ${next.updatedAt}
      WHERE id = ${id}`;
  }

  async deleteCharacter(id: string): Promise<void> {
    const sql = this.sql();
    await sql`DELETE FROM conversation_messages WHERE character_id = ${id}`;
    await sql`DELETE FROM conversation_members WHERE character_id = ${id}`;
    await sql`DELETE FROM character_queue WHERE character_id = ${id}`;
    await sql`DELETE FROM memories WHERE character_id = ${id}`;
    await sql`DELETE FROM relationships WHERE character_id = ${id} OR other_character_id = ${id}`;
    await sql`DELETE FROM conversations WHERE character_a_id = ${id} OR character_b_id = ${id}`;
    await sql`DELETE FROM characters WHERE id = ${id}`;
  }

  async listMemories(): Promise<MemoryRow[]> {
    const rows =
      await this.sql()`SELECT * FROM memories WHERE active = true ORDER BY created_at DESC`;
    return rows.map((row) => ({
      id: row.id,
      characterId: row.character_id,
      kind: row.kind,
      bullet: row.bullet,
      subject: row.subject ?? null,
      confidence: Number(row.confidence),
      active: Boolean(row.active),
      createdAt: Number(row.created_at),
    }));
  }

  async addMemory(row: MemoryRow): Promise<void> {
    await this.sql()`INSERT INTO memories (id, character_id, kind, bullet, subject, confidence, active, created_at)
      VALUES (${row.id}, ${row.characterId}, ${row.kind}, ${row.bullet}, ${row.subject}, ${row.confidence}, ${row.active}, ${row.createdAt})`;
  }

  async replaceMemories(characterId: string, rows: MemoryRow[]): Promise<void> {
    await this.sql()`DELETE FROM memories WHERE character_id = ${characterId}`;
    for (const row of rows) await this.addMemory(row);
  }

  async listRelationships(): Promise<RelationshipRow[]> {
    const rows = await this.sql()`SELECT * FROM relationships`;
    return rows.map((row) => ({
      characterId: row.character_id,
      otherCharacterId: row.other_character_id,
      impression: row.impression,
      affinity: Number(row.affinity),
      updatedAt: Number(row.updated_at),
    }));
  }

  async upsertRelationship(row: RelationshipRow): Promise<void> {
    await this.sql()`INSERT INTO relationships (character_id, other_character_id, impression, affinity, updated_at)
      VALUES (${row.characterId}, ${row.otherCharacterId}, ${row.impression}, ${row.affinity}, ${row.updatedAt})
      ON CONFLICT (character_id, other_character_id)
      DO UPDATE SET impression = EXCLUDED.impression, affinity = EXCLUDED.affinity, updated_at = EXCLUDED.updated_at`;
  }

  async addEvent(row: EventRow): Promise<void> {
    await this.sql()`INSERT INTO world_events (id, kind, character_id, character_name, target_character_id, summary, detail, visibility, hidden, conversation_id, created_at)
      VALUES (${row.id}, ${row.kind}, ${row.characterId}, ${row.characterName}, ${row.targetCharacterId}, ${row.summary}, ${row.detail}, ${row.visibility}, ${row.hidden}, ${row.conversationId}, ${row.createdAt})`;
  }

  async listEvents(input: {
    limit: number;
    viewerCharacterIds: string[];
    isAdmin: boolean;
  }): Promise<EventRow[]> {
    const ids = input.viewerCharacterIds;
    const rows = await this.sql()`SELECT * FROM world_events
      WHERE (${input.isAdmin} OR hidden = false)
        AND (
          visibility = 'public'
          OR ${input.isAdmin}
          OR character_id = ANY(${ids})
          OR target_character_id = ANY(${ids})
        )
      ORDER BY created_at DESC
      LIMIT ${input.limit}`;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      characterId: row.character_id ?? null,
      characterName: row.character_name ?? null,
      targetCharacterId: row.target_character_id ?? null,
      summary: row.summary,
      detail: row.detail ?? null,
      visibility: row.visibility === "private" ? "private" : "public",
      hidden: Boolean(row.hidden),
      conversationId: row.conversation_id ?? null,
      createdAt: Number(row.created_at),
    }));
  }

  async hideEvent(id: string): Promise<boolean> {
    const rows =
      await this.sql()`UPDATE world_events SET hidden = true WHERE id = ${id} RETURNING id`;
    return Boolean(rows[0]);
  }

  async pruneEvents(
    now: number,
    keep: number,
    maxAgeMs: number,
  ): Promise<number> {
    const cutoff = now - maxAgeMs;
    const deleted =
      await this.sql()`DELETE FROM world_events WHERE created_at < ${cutoff} OR id IN (
        SELECT id FROM world_events ORDER BY created_at DESC OFFSET ${keep}
      ) RETURNING id`;
    return deleted.length;
  }

  async enqueueJob(
    row: Omit<QueueJob, "status" | "attemptCount"> & {
      status?: string;
      attemptCount?: number;
    },
  ): Promise<string | null> {
    try {
      await this.sql()`INSERT INTO character_queue (
        id, character_id, kind, payload, priority, dedupe_key, not_before, expires_at, status, attempt_count, created_at
      ) VALUES (
        ${row.id}, ${row.characterId}, ${row.kind}, ${JSON.stringify(row.payload)}::jsonb,
        ${row.priority}, ${row.dedupeKey}, ${row.notBefore}, ${row.expiresAt},
        ${row.status ?? "pending"}, ${row.attemptCount ?? 0}, ${row.createdAt}
      )`;
      return row.id;
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return null;
      throw error;
    }
  }

  async claimNextJob(now: number, leaseMs: number): Promise<QueueJob | null> {
    const claimed = await this.sql()`WITH candidate AS (
      SELECT id FROM character_queue
      WHERE status = 'pending' AND not_before <= ${now} AND expires_at > ${now}
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ) UPDATE character_queue AS queue
      SET status = 'processing', claimed_at = ${now}, not_before = ${now + leaseMs},
          attempt_count = COALESCE(queue.attempt_count, 0) + 1
      FROM candidate WHERE queue.id = candidate.id
      RETURNING queue.*`;
    return claimed[0] ? mapJob(claimed[0]) : null;
  }

  async completeJob(id: string): Promise<void> {
    await this.sql()`UPDATE character_queue SET status = 'completed' WHERE id = ${id}`;
  }

  async failJob(
    id: string,
    error: string,
    now: number,
    maxAttempts: number,
  ): Promise<void> {
    await this.sql()`UPDATE character_queue SET
      last_error = ${error},
      status = CASE WHEN attempt_count >= ${maxAttempts} THEN 'failed' ELSE 'pending' END,
      not_before = CASE WHEN attempt_count >= ${maxAttempts} THEN not_before ELSE ${now + 15_000} END,
      expires_at = GREATEST(expires_at, ${now + 1_800_000})
      WHERE id = ${id}`;
  }

  async recoverStaleJobs(now: number): Promise<number> {
    const rows = await this.sql()`UPDATE character_queue SET status = 'pending'
      WHERE status = 'processing' AND not_before <= ${now}
      RETURNING id`;
    return rows.length;
  }

  async expireJobs(now: number): Promise<number> {
    const rows = await this.sql()`UPDATE character_queue SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= ${now}
      RETURNING id`;
    return rows.length;
  }

  async countDueJobs(now: number): Promise<number> {
    const rows =
      await this.sql()`SELECT count(*)::int AS count FROM character_queue
      WHERE status = 'pending' AND not_before <= ${now} AND expires_at > ${now}`;
    return Number(rows[0]?.count ?? 0);
  }

  async dueCharacterIds(now: number): Promise<string[]> {
    const rows =
      await this.sql()`SELECT id FROM characters WHERE paused = false AND muted = false AND next_decision_at <= ${now}`;
    return rows.map((row) => String(row.id));
  }

  async queueDepth(): Promise<number> {
    const rows =
      await this.sql()`SELECT count(*)::int AS count FROM character_queue WHERE status = 'pending'`;
    return Number(rows[0]?.count ?? 0);
  }

  async getJob(id: string): Promise<QueueJob | null> {
    const rows =
      await this.sql()`SELECT * FROM character_queue WHERE id = ${id}`;
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async insertConversation(
    row: ConversationRow,
    memberIds: string[],
  ): Promise<void> {
    const sql = this.sql();
    await sql`INSERT INTO conversations (id, character_a_id, character_b_id, status, message_count, visibility, location_id, started_at)
      VALUES (${row.id}, ${row.characterAId}, ${row.characterBId}, ${row.status}, ${row.messageCount}, ${row.visibility}, ${row.locationId}, ${row.startedAt})`;
    for (const characterId of memberIds)
      await sql`INSERT INTO conversation_members (conversation_id, character_id, joined_at)
        VALUES (${row.id}, ${characterId}, ${row.startedAt})
        ON CONFLICT DO NOTHING`;
  }

  async addConversationMessage(input: {
    id: string;
    conversationId: string;
    characterId: string;
    characterName: string;
    turn: number;
    text: string;
    createdAt: number;
  }): Promise<void> {
    await this.sql()`INSERT INTO conversation_messages (id, conversation_id, character_id, character_name, turn, text, created_at)
      VALUES (${input.id}, ${input.conversationId}, ${input.characterId}, ${input.characterName}, ${input.turn}, ${input.text}, ${input.createdAt})`;
  }

  async listConversationMembers(conversationId: string): Promise<string[]> {
    const rows =
      await this.sql()`SELECT character_id FROM conversation_members WHERE conversation_id = ${conversationId}`;
    return rows.map((row) => String(row.character_id));
  }

  async listArtifacts(): Promise<WorldArtifact[]> {
    const rows =
      await this.sql()`SELECT * FROM world_artifacts ORDER BY created_at DESC LIMIT 80`;
    return rows.map((row) => ({
      id: row.id,
      locationId: row.location_id,
      characterId: row.character_id ?? null,
      characterName: row.character_name ?? null,
      kind: row.kind === "object" ? "object" : "note",
      title: row.title,
      body: row.body,
      x: Number(row.x),
      y: Number(row.y),
      createdAt: Number(row.created_at),
    }));
  }

  async addArtifact(row: WorldArtifact): Promise<void> {
    await this.sql()`INSERT INTO world_artifacts (id, location_id, character_id, character_name, kind, title, body, x, y, created_at)
      VALUES (${row.id}, ${row.locationId}, ${row.characterId}, ${row.characterName}, ${row.kind}, ${row.title}, ${row.body}, ${row.x}, ${row.y}, ${row.createdAt})`;
  }

  async addReport(row: ReportRow): Promise<void> {
    await this.sql()`INSERT INTO moderation_reports (id, reporter_id, character_id, event_id, reason, status, created_at, resolved_at, resolver_id)
      VALUES (${row.id}, ${row.reporterId}, ${row.characterId}, ${row.eventId}, ${row.reason}, ${row.status}, ${row.createdAt}, ${row.resolvedAt}, ${row.resolverId})`;
  }

  async listReports(): Promise<ReportRow[]> {
    const rows =
      await this.sql()`SELECT * FROM moderation_reports ORDER BY created_at DESC LIMIT 200`;
    return rows.map((row) => ({
      id: row.id,
      reporterId: row.reporter_id,
      characterId: row.character_id ?? null,
      eventId: row.event_id ?? null,
      reason: row.reason,
      status: row.status,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
      resolverId: row.resolver_id ?? null,
    }));
  }

  async resolveReport(
    id: string,
    resolverId: string,
    now: number,
  ): Promise<void> {
    await this.sql()`UPDATE moderation_reports SET status = 'resolved', resolver_id = ${resolverId}, resolved_at = ${now} WHERE id = ${id}`;
  }

  async hitRateLimit(
    key: string,
    windowMs: number,
    max: number,
    now: number,
  ): Promise<boolean> {
    const rows =
      await this.sql()`INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (${key}, ${now}, 1)
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE WHEN rate_limit_buckets.window_start + ${windowMs} <= ${now} THEN 1 ELSE rate_limit_buckets.count + 1 END,
        window_start = CASE WHEN rate_limit_buckets.window_start + ${windowMs} <= ${now} THEN ${now} ELSE rate_limit_buckets.window_start END
      RETURNING count`;
    return Number(rows[0]?.count ?? 1) <= max;
  }

  async touchPresence(key: string, now: number): Promise<void> {
    await this.sql()`INSERT INTO viewer_presence (viewer_key, seen_at)
      VALUES (${key}, ${now})
      ON CONFLICT (viewer_key) DO UPDATE SET seen_at = ${now}`;
  }

  async countPresence(since: number): Promise<number> {
    const rows =
      await this.sql()`SELECT count(*)::int AS count FROM viewer_presence WHERE seen_at >= ${since}`;
    return Number(rows[0]?.count ?? 0);
  }

  async addAlert(row: AlertRow): Promise<void> {
    await this.sql()`INSERT INTO operator_alerts (id, level, kind, summary, detail, created_at)
      VALUES (${row.id}, ${row.level}, ${row.kind}, ${row.summary}, ${row.detail}, ${row.createdAt})`;
  }

  async listAlerts(limit: number): Promise<AlertRow[]> {
    const rows =
      await this.sql()`SELECT * FROM operator_alerts ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      kind: row.kind,
      summary: row.summary,
      detail: row.detail ?? null,
      createdAt: Number(row.created_at),
    }));
  }

  async listCosts(limit: number): Promise<CostRow[]> {
    const rows =
      await this.sql()`SELECT * FROM cost_entries ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      characterId: row.character_id ?? null,
      category: row.category,
      provider: row.provider,
      amountMicros: Number(row.amount_micros),
      reservedMicros: Number(row.reserved_micros),
      status: row.status,
      createdAt: Number(row.created_at),
    }));
  }

  async getWallet(ownerId: string): Promise<Wallet | null> {
    const rows =
      await this.sql()`SELECT * FROM user_wallets WHERE owner_id = ${ownerId}`;
    const row = rows[0];
    return row
      ? {
          ownerId: row.owner_id,
          providerUserId: row.provider_user_id,
          providerWalletId: row.provider_wallet_id,
          address: row.address,
          chain: "tempo",
          asset: "USDC",
          consentVersion: row.consent_version ?? undefined,
          consentAt:
            row.consent_at == null ? undefined : Number(row.consent_at),
          consentActor: row.consent_actor ?? undefined,
          delegated: Boolean(row.delegated),
          revoked: Boolean(row.revoked),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        }
      : null;
  }
  async saveWallet(wallet: Wallet): Promise<void> {
    await this.sql()`INSERT INTO user_wallets (owner_id, provider_user_id, provider_wallet_id, address, chain, asset, consent_version, consent_at, consent_actor, delegated, revoked, created_at, updated_at) VALUES (${wallet.ownerId}, ${wallet.providerUserId}, ${wallet.providerWalletId}, ${wallet.address}, ${wallet.chain}, ${wallet.asset}, ${wallet.consentVersion ?? null}, ${wallet.consentAt ?? null}, ${wallet.consentActor ?? null}, ${wallet.delegated}, ${wallet.revoked}, ${wallet.createdAt}, ${wallet.updatedAt}) ON CONFLICT (owner_id) DO UPDATE SET consent_version = EXCLUDED.consent_version, consent_at = EXCLUDED.consent_at, consent_actor = EXCLUDED.consent_actor, delegated = EXCLUDED.delegated, revoked = EXCLUDED.revoked, updated_at = EXCLUDED.updated_at`;
  }
  async getWalletProvisioning(ownerId: string, idempotencyKey: string) {
    const rows =
      await this.sql()`SELECT * FROM wallet_provisioning_operations WHERE owner_id=${ownerId} AND idempotency_key=${idempotencyKey}`;
    return rows[0] ? this.mapProvisioning(rows[0]) : null;
  }
  async claimWalletProvisioning(
    ownerId: string,
    idempotencyKey: string,
    now: number,
    staleAfterMs: number,
  ) {
    const rows =
      await this.sql()`INSERT INTO wallet_provisioning_operations (owner_id,idempotency_key,status,provider_idempotency_key,created_at,updated_at) VALUES (${ownerId},${idempotencyKey},'in_progress',${`wallet:${ownerId}`},${now},${now}) ON CONFLICT (owner_id,idempotency_key) DO UPDATE SET status='in_progress', updated_at=${now} WHERE wallet_provisioning_operations.status='failed' RETURNING *`;
    if (rows[0])
      return { operation: this.mapProvisioning(rows[0]), claimed: true };
    const existing =
      await this.sql()`SELECT * FROM wallet_provisioning_operations WHERE owner_id=${ownerId} AND idempotency_key=${idempotencyKey}`;
    return {
      operation: this.mapProvisioning(
        existing[0] ?? {
          owner_id: ownerId,
          idempotency_key: idempotencyKey,
          status: "in_progress",
          provider_idempotency_key: `wallet:${ownerId}`,
          created_at: now,
          updated_at: now,
        },
      ),
      claimed: false,
    };
  }
  private mapProvisioning(
    row: Record<string, any>,
  ): WalletProvisioningOperation {
    return {
      ownerId: row.owner_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      providerIdempotencyKey: row.provider_idempotency_key,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      providerUserId: row.provider_user_id ?? undefined,
      providerWalletId: row.provider_wallet_id ?? undefined,
      address: row.address ?? undefined,
      chain: row.chain ?? undefined,
      asset: row.asset ?? undefined,
      error: row.error ?? undefined,
    };
  }
  async completeWalletProvisioning(
    operation: WalletProvisioningOperation,
    now: number,
  ) {
    const rows =
      await this.sql()`UPDATE wallet_provisioning_operations SET status='completed', provider_user_id=${operation.providerUserId ?? null}, provider_wallet_id=${operation.providerWalletId ?? null}, address=${operation.address ?? null}, chain=${operation.chain ?? null}, asset=${operation.asset ?? null}, error=NULL, updated_at=${now} WHERE owner_id=${operation.ownerId} AND idempotency_key=${operation.idempotencyKey} AND status='in_progress' RETURNING owner_id`;
    if (!rows.length)
      throw new PaymentError("stale wallet provisioning transition");
  }
  async failWalletProvisioning(
    operation: WalletProvisioningOperation,
    error: string,
    now: number,
  ) {
    await this.sql()`UPDATE wallet_provisioning_operations SET status='failed', error=${error}, updated_at=${now} WHERE owner_id=${operation.ownerId} AND idempotency_key=${operation.idempotencyKey}`;
  }
  async listWallets(): Promise<Wallet[]> {
    const rows =
      await this.sql()`SELECT * FROM user_wallets ORDER BY created_at`;
    return rows.map((row) => ({
      ownerId: row.owner_id,
      providerUserId: row.provider_user_id,
      providerWalletId: row.provider_wallet_id,
      address: row.address,
      chain: "tempo",
      asset: "USDC",
      consentVersion: row.consent_version ?? undefined,
      consentAt: row.consent_at == null ? undefined : Number(row.consent_at),
      consentActor: row.consent_actor ?? undefined,
      delegated: Boolean(row.delegated),
      revoked: Boolean(row.revoked),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }
  async getPayment(operationId: string): Promise<Payment | null> {
    const rows =
      await this.sql()`SELECT * FROM payment_attempts WHERE operation_id = ${operationId}`;
    return rows[0] ? this.mapPayment(rows[0]) : null;
  }
  private mapPayment(row: Record<string, any>): Payment {
    return {
      operationId: row.operation_id,
      ownerId: row.owner_id,
      toolId: row.tool_id,
      toolVersion: Number(row.manifest_version),
      maxTotalMicros: Number(row.max_total_micros),
      reservedMicros: Number(row.reserved_micros),
      actualMicros:
        row.actual_micros == null ? undefined : Number(row.actual_micros),
      state: row.state,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      providerReference: row.provider_reference ?? undefined,
      receiptReference: row.receipt_reference ?? undefined,
      transactionReference: row.transaction_reference ?? undefined,
      receiptHash: row.receipt_hash ?? undefined,
      receiptEvidence:
        typeof row.receipt_evidence === "string"
          ? JSON.parse(row.receipt_evidence)
          : (row.receipt_evidence ?? undefined),
      requestDigest: row.request_digest ?? undefined,
      authorizationClaimToken: row.authorization_claim_token ?? undefined,
      authorizationProviderIdempotencyKey:
        row.authorization_provider_idempotency_key ?? undefined,
      providerPhase: row.provider_phase ?? undefined,
      authorizationClaimedAt:
        row.authorization_claimed_at == null
          ? undefined
          : Number(row.authorization_claimed_at),
      consentVersion: row.consent_version ?? undefined,
      payerAddress: row.payer_address ?? undefined,
      version: Number(row.version ?? 0),
      manifestSnapshot:
        typeof row.manifest_snapshot === "string"
          ? JSON.parse(row.manifest_snapshot)
          : row.manifest_snapshot,
      pauseGeneration: Number(row.pause_generation ?? 0),
      pauseGenerations: row.pause_generations
        ? typeof row.pause_generations === "string"
          ? JSON.parse(row.pause_generations)
          : row.pause_generations
        : {
            global: Number(row.pause_generation ?? 0),
            user: 0,
            tool: 0,
          },
    };
  }
  async savePayment(payment: Payment): Promise<void> {
    const rows =
      await this.sql()`INSERT INTO payment_attempts (operation_id, owner_id, tool_id, manifest_version, max_total_micros, reserved_micros, actual_micros, state, created_at, updated_at, provider_reference, receipt_reference, transaction_reference, receipt_hash, receipt_evidence, request_digest, manifest_snapshot, pause_generation, authorization_claim_token, authorization_claimed_at, consent_version, payer_address, pause_generations, authorization_provider_idempotency_key, provider_phase, version) VALUES (${payment.operationId}, ${payment.ownerId}, ${payment.toolId}, ${payment.toolVersion}, ${payment.maxTotalMicros}, ${payment.reservedMicros}, ${payment.actualMicros ?? null}, ${payment.state}, ${payment.createdAt}, ${payment.updatedAt}, ${payment.providerReference ?? null}, ${payment.receiptReference ?? null}, ${payment.transactionReference ?? null}, ${payment.receiptHash ?? null}, ${JSON.stringify(payment.receiptEvidence ?? null)}::jsonb, ${payment.requestDigest ?? null}, ${JSON.stringify(payment.manifestSnapshot)}::jsonb, ${payment.pauseGeneration}, ${payment.authorizationClaimToken ?? null}, ${payment.authorizationClaimedAt ?? null}, ${payment.consentVersion ?? null}, ${payment.payerAddress ?? null}, ${JSON.stringify(payment.pauseGenerations)}::jsonb, ${payment.authorizationProviderIdempotencyKey ?? null}, ${payment.providerPhase ?? null}, ${payment.version}) ON CONFLICT (operation_id) DO UPDATE SET reserved_micros = EXCLUDED.reserved_micros, actual_micros = EXCLUDED.actual_micros, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, provider_reference = EXCLUDED.provider_reference, receipt_reference = EXCLUDED.receipt_reference, transaction_reference = EXCLUDED.transaction_reference, receipt_hash = EXCLUDED.receipt_hash, receipt_evidence = EXCLUDED.receipt_evidence, request_digest = EXCLUDED.request_digest, manifest_snapshot = EXCLUDED.manifest_snapshot, pause_generation = EXCLUDED.pause_generation, authorization_claim_token = EXCLUDED.authorization_claim_token, authorization_claimed_at = EXCLUDED.authorization_claimed_at, consent_version = EXCLUDED.consent_version, payer_address = EXCLUDED.payer_address, pause_generations = EXCLUDED.pause_generations, authorization_provider_idempotency_key = EXCLUDED.authorization_provider_idempotency_key, provider_phase = EXCLUDED.provider_phase, version = EXCLUDED.version WHERE payment_attempts.version < EXCLUDED.version RETURNING operation_id`;
    if (!rows.length) throw new PaymentError("stale payment transition");
  }
  async reserveAndCreatePayment(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }): Promise<Payment | null> {
    const rows = await this.sql()`WITH quota AS (
      INSERT INTO user_daily_spend (owner_id, spend_date, daily_limit_micros, reserved_micros, updated_at)
      VALUES (${input.ownerId}, ${input.day}::date, ${input.limit}, ${input.amount}, ${input.now})
      ON CONFLICT (owner_id, spend_date) DO UPDATE SET
        daily_limit_micros = EXCLUDED.daily_limit_micros,
        reserved_micros = user_daily_spend.reserved_micros + EXCLUDED.reserved_micros,
        version = user_daily_spend.version + 1,
        updated_at = EXCLUDED.updated_at
      WHERE user_daily_spend.reserved_micros + user_daily_spend.settled_micros + EXCLUDED.reserved_micros <= EXCLUDED.daily_limit_micros
      RETURNING owner_id
    )
    INSERT INTO payment_attempts (operation_id, owner_id, tool_id, manifest_version, max_total_micros, reserved_micros, state, created_at, updated_at, request_digest, manifest_snapshot, pause_generation, pause_generations, consent_version, payer_address, version)
    SELECT ${input.payment.operationId}, ${input.payment.ownerId}, ${input.payment.toolId}, ${input.payment.toolVersion}, ${input.payment.maxTotalMicros}, ${input.payment.reservedMicros}, ${input.payment.state}, ${input.payment.createdAt}, ${input.payment.updatedAt}, ${input.payment.requestDigest}, ${JSON.stringify(input.payment.manifestSnapshot)}::jsonb, ${input.payment.pauseGeneration}, ${JSON.stringify(input.payment.pauseGenerations)}::jsonb, ${input.payment.consentVersion ?? null}, ${input.payment.payerAddress ?? null}, ${input.payment.version}
    FROM quota RETURNING *`;
    return rows[0] ? this.mapPayment(rows[0]) : null;
  }
  async reservePaymentIfUnpaused(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
    generations: PaymentGenerations;
  }) {
    return this.transaction(async () => {
      for (const scope of [
        "global",
        `user:${input.ownerId}`,
        `tool:${input.payment.toolId}`,
      ])
        await this.sql()`SELECT pg_advisory_xact_lock(hashtext(${`wallet-pause:${scope}`}))`;
      const pauses = await Promise.all(
        ["global", `user:${input.ownerId}`, `tool:${input.payment.toolId}`].map(
          (s) => this.getPause(s),
        ),
      );
      if (
        pauses.some(
          (p, i) =>
            p.paused || p.generation !== Object.values(input.generations)[i],
        )
      )
        return null;
      return this.reserveAndCreatePayment(input);
    });
  }
  async transitionAndRelease(
    input: PaymentTransition,
  ): Promise<PaymentTransitionResult> {
    return this.transitionFinancially(input, "cancelled");
  }
  async transitionAndSettle(
    input: PaymentTransition,
  ): Promise<PaymentTransitionResult> {
    return this.transitionFinancially(input, "settled");
  }
  private async transitionFinancially(
    input: PaymentTransition,
    state: "cancelled" | "settled",
  ) {
    return this.transaction(async () => {
      const current = await this.getPayment(input.operationId);
      if (!current) throw new PaymentError("payment not found");
      if (current.state === state) return { ...current, transitioned: false };
      if (
        current.state !== input.expectedState ||
        current.version !== input.expectedVersion
      )
        throw new PaymentError("stale payment transition");
      const next = {
        ...input.payment,
        state,
        version: current.version + 1,
        updatedAt: input.now,
        ...(state === "settled"
          ? { actualMicros: input.actualMicros, reservedMicros: 0 }
          : { reservedMicros: 0 }),
      };
      if (state === "settled") {
        await this.settleDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
          input.actualMicros ?? 0,
          input.now,
        );
      } else {
        await this.releaseDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
          input.now,
        );
      }
      await this.savePayment(next);
      return { ...next, transitioned: true };
    });
  }
  async reconcilePaymentAuthorization(
    operationId: string,
    ownerId: string,
    outcome: "authorized" | "reconciled_failed",
    now: number,
    authorizationReference?: string,
  ): Promise<PaymentTransitionResult> {
    return this.transaction(async () => {
      const current = await this.getPayment(operationId);
      if (!current || current.ownerId !== ownerId)
        throw new PaymentError("owner mismatch");
      if (current.state === outcome) return { ...current, transitioned: false };
      if (current.state !== "unknown")
        throw new PaymentError(
          "payment is not awaiting authorization reconciliation",
        );
      const next = {
        ...current,
        state: outcome,
        providerPhase:
          outcome === "authorized"
            ? ("succeeded" as const)
            : ("failed" as const),
        providerReference: authorizationReference ?? current.providerReference,
        authorizationClaimToken: undefined,
        authorizationClaimedAt: undefined,
        version: current.version + 1,
        updatedAt: now,
      };
      if (outcome === "reconciled_failed") {
        await this.releaseDailySpend(
          ownerId,
          new Date(current.createdAt).toISOString().slice(0, 10),
          current.reservedMicros,
          now,
        );
        next.reservedMicros = 0;
      }
      await this.savePayment(next);
      return { ...next, transitioned: true };
    });
  }

  async claimPaymentAuthorization(
    operationId: string,
    ownerId: string,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.transaction(async () => {
      const current = await this.getPayment(operationId);
      if (!current || current.ownerId !== ownerId)
        throw new PaymentError("owner mismatch");
      const toolScope = `tool:${current.toolId}`;
      for (const scope of ["global", `user:${ownerId}`, toolScope])
        await this.sql()`SELECT pg_advisory_xact_lock(hashtext(${`wallet-pause:${scope}`}))`;
      const token = crypto.randomUUID();
      const rows =
        await this.sql()`UPDATE payment_attempts SET authorization_claim_token=${token}, authorization_provider_idempotency_key=${`authorize:${ownerId}:${operationId}`}, provider_phase='in_flight', authorization_claimed_at=${now}, pause_generation=${Math.max(generations.global, generations.user, generations.tool)}, pause_generations=${JSON.stringify(generations)}::jsonb, version=version+1 WHERE operation_id=${operationId} AND owner_id=${ownerId} AND state IN ('reserved','challenged') AND authorization_claim_token IS NULL AND COALESCE((SELECT paused FROM spend_pauses WHERE scope='global'), false)=false AND COALESCE((SELECT generation FROM spend_pauses WHERE scope='global'), 0)=${generations.global} AND COALESCE((SELECT paused FROM spend_pauses WHERE scope=${`user:${ownerId}`}), false)=false AND COALESCE((SELECT generation FROM spend_pauses WHERE scope=${`user:${ownerId}`}), 0)=${generations.user} AND COALESCE((SELECT paused FROM spend_pauses WHERE scope=${toolScope}), false)=false AND COALESCE((SELECT generation FROM spend_pauses WHERE scope=${toolScope}), 0)=${generations.tool} RETURNING *`;
      if (rows[0]) return { payment: this.mapPayment(rows[0]), claimed: true };
      const pauses = await Promise.all([
        this.getPause("global"),
        this.getPause(`user:${ownerId}`),
        this.getPause(toolScope),
      ]);
      if (
        pauses.some(
          (pause, index) =>
            pause.paused ||
            pause.generation !==
              [generations.global, generations.user, generations.tool][index],
        )
      )
        throw new PaymentError("pause changed before authorization claim");
      const existing = await this.getPayment(operationId);
      if (!existing || existing.ownerId !== ownerId)
        throw new PaymentError("owner mismatch");
      return { payment: existing, claimed: false };
    });
  }
  async getFundingAttempt(ownerId: string, idempotencyKey: string) {
    const rows =
      await this.sql()`SELECT * FROM funding_attempts WHERE owner_id=${ownerId} AND idempotency_key=${idempotencyKey}`;
    const row = rows[0];
    if (!row) return null;
    return {
      ownerId: row.owner_id,
      idempotencyKey: row.idempotency_key,
      providerIdempotencyKey: row.provider_idempotency_key,
      amountMicros: Number(row.amount_micros),
      walletAddress: row.wallet_address,
      consentVersion: row.consent_version,
      policySnapshot: row.policy_snapshot ?? null,
      pauseGenerations: row.pause_generations
        ? typeof row.pause_generations === "string"
          ? JSON.parse(row.pause_generations)
          : row.pause_generations
        : { global: 0, user: 0, tool: 0 },
      status: row.status,
      providerPhase: row.provider_phase ?? undefined,
      session: row.session ?? undefined,
      error: row.error ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    } as FundingAttempt;
  }
  async claimFundingAttempt(
    attempt: FundingAttempt,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.transaction(async () => {
      for (const scope of ["global", `user:${attempt.ownerId}`])
        await this.sql()`SELECT pg_advisory_xact_lock(hashtext(${`wallet-pause:${scope}`}))`;
      const rows =
        await this.sql()`WITH guard AS (SELECT 1 WHERE COALESCE((SELECT paused FROM spend_pauses WHERE scope='global'), false)=false AND COALESCE((SELECT generation FROM spend_pauses WHERE scope='global'), 0)=${generations.global} AND COALESCE((SELECT paused FROM spend_pauses WHERE scope=${`user:${attempt.ownerId}`}), false)=false AND COALESCE((SELECT generation FROM spend_pauses WHERE scope=${`user:${attempt.ownerId}`}), 0)=${generations.user}) INSERT INTO funding_attempts (owner_id,idempotency_key,provider_idempotency_key,amount_micros,wallet_address,consent_version,policy_snapshot,pause_generations,provider_phase,status,created_at,updated_at) SELECT ${attempt.ownerId},${attempt.idempotencyKey},${attempt.providerIdempotencyKey},${attempt.amountMicros},${attempt.walletAddress},${attempt.consentVersion},${JSON.stringify(attempt.policySnapshot)}::jsonb,${JSON.stringify(generations)}::jsonb,'in_progress',${attempt.createdAt},${now} FROM guard ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING *`;
      if (rows[0])
        return {
          attempt: {
            ...attempt,
            pauseGenerations: generations,
            status: "in_progress" as const,
            updatedAt: now,
          },
          claimed: true,
        };
      const pauses = await Promise.all([
        this.getPause("global"),
        this.getPause(`user:${attempt.ownerId}`),
      ]);
      if (
        pauses.some(
          (pause, index) =>
            pause.paused ||
            pause.generation !== [generations.global, generations.user][index],
        )
      )
        throw new PaymentError("pause changed before funding claim");
      const existing = await this.getFundingAttempt(
        attempt.ownerId,
        attempt.idempotencyKey,
      );
      if (
        existing &&
        (existing.amountMicros !== attempt.amountMicros ||
          existing.walletAddress !== attempt.walletAddress ||
          existing.consentVersion !== attempt.consentVersion)
      )
        throw new PaymentError("funding idempotency conflict");
      return { attempt: existing!, claimed: false };
    });
  }
  async completeFundingAttempt(attempt: FundingAttempt, now: number) {
    await this.sql()`UPDATE funding_attempts SET status='completed', provider_phase='succeeded', session=${JSON.stringify(attempt.session)}::jsonb, error=NULL, updated_at=${now} WHERE owner_id=${attempt.ownerId} AND idempotency_key=${attempt.idempotencyKey} AND status IN ('in_progress','unknown')`;
  }
  async failFundingAttempt(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.sql()`UPDATE funding_attempts SET status='failed', provider_phase='failed', error=${error}, updated_at=${now} WHERE owner_id=${attempt.ownerId} AND idempotency_key=${attempt.idempotencyKey} AND status IN ('in_progress','unknown')`;
  }
  async markFundingUnknown(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.sql()`UPDATE funding_attempts SET status='unknown', provider_phase='unknown', error=${error}, updated_at=${now} WHERE owner_id=${attempt.ownerId} AND idempotency_key=${attempt.idempotencyKey} AND status='in_progress'`;
  }
  async listPayments(ownerId: string, day: string): Promise<Payment[]> {
    const rows =
      await this.sql()`SELECT * FROM payment_attempts WHERE owner_id = ${ownerId} AND to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${day} ORDER BY created_at`;
    return rows.map((row) => this.mapPayment(row));
  }
  async getQuota(ownerId: string): Promise<number | null> {
    const rows =
      await this.sql()`SELECT daily_limit_micros FROM payment_quotas WHERE owner_id = ${ownerId}`;
    return rows[0] ? Number(rows[0].daily_limit_micros) : null;
  }
  async setQuota(
    ownerId: string,
    dailyLimitMicros: number,
    now: number,
  ): Promise<void> {
    await this.sql()`INSERT INTO payment_quotas (owner_id, daily_limit_micros, updated_at) VALUES (${ownerId}, ${dailyLimitMicros}, ${now}) ON CONFLICT (owner_id) DO UPDATE SET daily_limit_micros = EXCLUDED.daily_limit_micros, updated_at = EXCLUDED.updated_at`;
  }
  async getPause(scope: string): Promise<SpendPause> {
    const rows =
      await this.sql()`SELECT * FROM spend_pauses WHERE scope = ${scope}`;
    const row = rows[0];
    return row
      ? {
          scope,
          paused: Boolean(row.paused),
          generation: Number(row.generation),
          updatedAt: Number(row.updated_at),
        }
      : { scope, paused: false, generation: 0, updatedAt: 0 };
  }
  async setPause(
    scope: string,
    paused: boolean,
    now: number,
  ): Promise<SpendPause> {
    return this.transaction(async () => {
      await this.sql()`SELECT pg_advisory_xact_lock(hashtext(${`wallet-pause:${scope}`}))`;
      const rows =
        await this.sql()`INSERT INTO spend_pauses (scope, paused, generation, updated_at) VALUES (${scope}, ${paused}, 1, ${now}) ON CONFLICT (scope) DO UPDATE SET paused = EXCLUDED.paused, generation = spend_pauses.generation + 1, updated_at = EXCLUDED.updated_at RETURNING *`;
      const row = rows[0]!;
      return {
        scope,
        paused: Boolean(row.paused),
        generation: Number(row.generation),
        updatedAt: Number(row.updated_at),
      };
    });
  }
  async reserveDailySpend(
    ownerId: string,
    day: string,
    amount: number,
    limit: number,
    now: number,
  ): Promise<boolean> {
    const rows =
      await this.sql()`INSERT INTO user_daily_spend (owner_id, spend_date, daily_limit_micros, reserved_micros, updated_at) VALUES (${ownerId}, ${day}::date, ${limit}, ${amount}, ${now}) ON CONFLICT (owner_id, spend_date) DO UPDATE SET daily_limit_micros = EXCLUDED.daily_limit_micros, reserved_micros = user_daily_spend.reserved_micros + EXCLUDED.reserved_micros, updated_at = EXCLUDED.updated_at, version = user_daily_spend.version + 1 WHERE user_daily_spend.reserved_micros + user_daily_spend.settled_micros + EXCLUDED.reserved_micros <= EXCLUDED.daily_limit_micros RETURNING owner_id`;
    return rows.length > 0;
  }
  async releaseDailySpend(
    ownerId: string,
    day: string,
    amount: number,
    now: number,
  ): Promise<void> {
    const rows =
      await this.sql()`UPDATE user_daily_spend SET reserved_micros = reserved_micros - ${amount}, version = version + 1, updated_at = ${now} WHERE owner_id = ${ownerId} AND spend_date = ${day}::date AND reserved_micros >= ${amount} RETURNING owner_id`;
    if (!rows.length)
      throw new PaymentError("daily spend reservation invariant violated");
  }
  async settleDailySpend(
    ownerId: string,
    day: string,
    reserved: number,
    settled: number,
    now: number,
  ): Promise<void> {
    const rows =
      await this.sql()`UPDATE user_daily_spend SET reserved_micros = reserved_micros - ${reserved}, settled_micros = settled_micros + ${settled}, version = version + 1, updated_at = ${now} WHERE owner_id = ${ownerId} AND spend_date = ${day}::date AND reserved_micros >= ${reserved} RETURNING owner_id`;
    if (!rows.length)
      throw new PaymentError("daily spend settlement invariant violated");
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.sql()`INSERT INTO payment_audit (id, operation_id, owner_id, actor, event, state, provider_phase, amount_micros, receipt_reference, evidence_hash, manifest_snapshot, consent_version, pause_generations, request_digest, transition_version, provider_reference, transaction_reference, receipt_evidence, created_at) VALUES (${entry.id}, ${entry.operationId ?? null}, ${entry.ownerId}, ${entry.actor}, ${entry.event}, ${entry.state ?? null}, ${entry.providerPhase ?? null}, ${entry.amountMicros ?? null}, ${entry.receiptReference ?? null}, ${entry.evidenceHash ?? null}, ${JSON.stringify(entry.manifestSnapshot ?? null)}::jsonb, ${entry.consentVersion ?? null}, ${JSON.stringify(entry.pauseGenerations ?? null)}::jsonb, ${entry.requestDigest ?? null}, ${entry.transitionVersion ?? null}, ${entry.providerReference ?? null}, ${entry.transactionReference ?? null}, ${JSON.stringify(entry.receiptEvidence ?? null)}::jsonb, ${entry.createdAt})`;
  }
  async listAudit(ownerId?: string): Promise<AuditEntry[]> {
    const rows = ownerId
      ? await this.sql()`SELECT * FROM payment_audit WHERE owner_id = ${ownerId} ORDER BY created_at`
      : await this.sql()`SELECT * FROM payment_audit ORDER BY created_at`;
    return rows.map((row) => ({
      id: row.id,
      operationId: row.operation_id ?? undefined,
      ownerId: row.owner_id,
      actor: row.actor,
      event: row.event,
      state: row.state ?? undefined,
      providerPhase: row.provider_phase ?? undefined,
      amountMicros:
        row.amount_micros == null ? undefined : Number(row.amount_micros),
      receiptReference: row.receipt_reference ?? undefined,
      evidenceHash: row.evidence_hash ?? undefined,
      manifestSnapshot: row.manifest_snapshot ?? undefined,
      consentVersion: row.consent_version ?? undefined,
      pauseGenerations: row.pause_generations ?? undefined,
      requestDigest: row.request_digest ?? undefined,
      transitionVersion:
        row.transition_version == null
          ? undefined
          : Number(row.transition_version),
      providerReference: row.provider_reference ?? undefined,
      transactionReference: row.transaction_reference ?? undefined,
      receiptEvidence: row.receipt_evidence ?? undefined,
      createdAt: Number(row.created_at),
    }));
  }
  async listToolManifests(): Promise<ToolManifest[]> {
    const rows =
      await this.sql()`SELECT DISTINCT ON (tm.id) tm.manifest FROM tool_manifests tm LEFT JOIN tool_manifest_current current ON current.id = tm.id WHERE tm.reviewed = true AND tm.active = true AND (current.id IS NULL OR current.version = tm.version) ORDER BY tm.id, tm.version DESC`;
    return rows.map((row) =>
      typeof row.manifest === "string"
        ? JSON.parse(row.manifest)
        : row.manifest,
    );
  }
  async saveToolManifest(manifest: ToolManifest, now = 0): Promise<void> {
    await this.sql()`INSERT INTO tool_manifests (id, version, active, reviewed, manifest, updated_at) VALUES (${manifest.id}, ${manifest.version}, ${manifest.active}, ${manifest.reviewed}, ${JSON.stringify(manifest)}::jsonb, ${now}) ON CONFLICT (id, version) DO NOTHING`;
  }
  async activateToolManifest(
    id: string,
    version: number,
    now: number,
  ): Promise<void> {
    const rows =
      await this.sql()`SELECT 1 FROM tool_manifests WHERE id=${id} AND version=${version} AND active=true AND reviewed=true`;
    if (!rows.length)
      throw new PaymentError("only reviewed active manifests can be activated");
    await this.sql()`INSERT INTO tool_manifest_current (id, version, activated_at) VALUES (${id}, ${version}, ${now}) ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version, activated_at=EXCLUDED.activated_at`;
  }
}
