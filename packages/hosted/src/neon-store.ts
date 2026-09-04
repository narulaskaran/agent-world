import { AsyncLocalStorage } from "node:async_hooks";
import type { WorldArtifact, WorldLocationId } from "../../shared/src/index.js";
import { ConflictError } from "./errors.js";
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

const SCHEMA_STATEMENTS = [
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
  speechExpiresAt: row.speech_expires_at == null ? null : Number(row.speech_expires_at),
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
  private readonly context = new AsyncLocalStorage<NeonSql>();
  private schemaReady = false;

  constructor(private readonly root: NeonSql) {}

  private sql(): NeonSql {
    return this.context.getStore() ?? this.root;
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    for (const statement of SCHEMA_STATEMENTS)
      await this.sql().query(statement);
    this.schemaReady = true;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const sql = this.sql();
    const begin = sql.begin ?? sql.transaction;
    if (begin) {
      return begin.call(sql, async (txn: NeonSql) => this.context.run(txn, fn)) as Promise<T>;
    }
    return fn();
  }

  async getWorldState(): Promise<WorldStateRow> {
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
      "characters",
    ])
      await sql.query(`DELETE FROM ${table}`);
    await sql`UPDATE world_state SET simulation_paused = false, paused_at = 0, server_spent_today_micros = 0, budget_date = ${new Date(now).toISOString().slice(0, 10)}, updated_at = ${now} WHERE id = 1`;
  }

  async listCharacters(): Promise<CharacterRow[]> {
    const rows = await this.sql()`SELECT * FROM characters ORDER BY created_at ASC`;
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
    const rows =
      await this.sql()`UPDATE character_queue SET status = 'pending'
      WHERE status = 'processing' AND not_before <= ${now}
      RETURNING id`;
    return rows.length;
  }

  async expireJobs(now: number): Promise<number> {
    const rows =
      await this.sql()`UPDATE character_queue SET status = 'expired'
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
    const rows = await this.sql()`SELECT * FROM character_queue WHERE id = ${id}`;
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
    const rows = await this.sql()`INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (${key}, ${now}, 1)
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE WHEN rate_limit_buckets.window_start + ${windowMs} <= ${now} THEN 1 ELSE rate_limit_buckets.count + 1 END,
        window_start = CASE WHEN rate_limit_buckets.window_start + ${windowMs} <= ${now} THEN ${now} ELSE rate_limit_buckets.window_start END
      RETURNING count`;
    return Number(rows[0]?.count ?? 1) <= max;
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
}
