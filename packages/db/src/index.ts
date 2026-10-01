import Database from "better-sqlite3";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  BUDGET_SLEEP_INTENT,
  hashString,
  locationAtPoint,
  type CharacterInspect,
  type CharacterState,
  type PublicCharacter,
  type PublicMemory,
  type PublicRelationship,
  type WorldArtifact,
  type WorldEvent,
  type WorldLocationId,
  type WorldRecap,
} from "@agent-world/shared/world";
import {
  artifacts,
  characterQueue,
  characters,
  conversationMessages,
  conversations,
  costEntries,
  memories,
  relationships,
  worldEvents,
  worldState,
} from "./schema.js";

export * from "./schema.js";

export const localDate = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const PUBLIC_EVENT_LIMIT = 100;
export const EVENT_RETENTION = 2_000;
export const ARTIFACT_RETENTION = 60;
const QUEUE_LEASE_MS = 120_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type CharacterRow = typeof characters.$inferSelect;

export interface QueueItem {
  id: string;
  characterId: string;
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  notBefore: number;
  expiresAt: number;
}

export interface ConversationRecord {
  id: string;
  characterAId: string;
  characterBId: string;
  status: string;
  messageCount: number;
  startedAt: number;
  endedAt?: number | null;
  terminationReason?: string | null;
}

export interface ConversationMessage {
  speakerId: string | null;
  speakerName: string;
  text: string;
  createdAt: number;
}

export interface RepositoryOptions {
  /** Applied at startup when set; otherwise the stored value is kept. */
  serverDailyBudgetMicros?: number;
  decisionScale?: number;
}

export const schemaSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, personality TEXT NOT NULL,
  model TEXT NOT NULL, daily_budget_micros INTEGER NOT NULL, spent_today_micros INTEGER NOT NULL DEFAULT 0,
  budget_date TEXT NOT NULL, decision_interval_seconds INTEGER NOT NULL DEFAULT 60,
  next_decision_at INTEGER NOT NULL, last_reaction_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active', x REAL NOT NULL, y REAL NOT NULL, target_x REAL NOT NULL, target_y REAL NOT NULL,
  movement_started_at INTEGER NOT NULL DEFAULT 0, movement_arrives_at INTEGER NOT NULL DEFAULT 0,
  intent TEXT NOT NULL DEFAULT 'Taking in the world', speech TEXT, speech_expires_at INTEGER,
  avatar_url TEXT, avatar_color TEXT NOT NULL, tool_active INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, current_conversation_id TEXT, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL, kind TEXT NOT NULL, bullet TEXT NOT NULL,
  subject TEXT, confidence REAL NOT NULL DEFAULT .7, source_event_id TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  character_id TEXT NOT NULL, other_character_id TEXT NOT NULL, impression TEXT NOT NULL,
  affinity INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  UNIQUE(character_id, other_character_id)
);
CREATE TABLE IF NOT EXISTS world_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, character_id TEXT, character_name TEXT,
  target_character_id TEXT, summary TEXT NOT NULL, detail TEXT, conversation_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS character_queue (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT, not_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, character_a_id TEXT NOT NULL, character_b_id TEXT NOT NULL,
  status TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
  ended_at INTEGER, termination_reason TEXT
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, speaker_id TEXT, speaker_name TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY, character_id TEXT, category TEXT NOT NULL, provider TEXT NOT NULL,
  amount_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, status TEXT NOT NULL,
  latency_ms INTEGER, metadata TEXT NOT NULL DEFAULT '{}', budget_date TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL, character_id TEXT, character_name TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_state (
  id INTEGER PRIMARY KEY CHECK(id = 1), simulation_paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER NOT NULL DEFAULT 0,
  server_daily_budget_micros INTEGER NOT NULL DEFAULT 2000000,
  server_spent_today_micros INTEGER NOT NULL DEFAULT 0, decision_scale REAL NOT NULL DEFAULT 1,
  budget_date TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

const indexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS character_queue_dedupe_pending
  ON character_queue(character_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS character_queue_due ON character_queue(character_id, status, not_before);
CREATE INDEX IF NOT EXISTS character_queue_status ON character_queue(status, created_at);
CREATE INDEX IF NOT EXISTS world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS world_events_conversation ON world_events(conversation_id);
CREATE INDEX IF NOT EXISTS memories_character ON memories(character_id, active, created_at);
CREATE INDEX IF NOT EXISTS relationships_other ON relationships(other_character_id);
CREATE INDEX IF NOT EXISTS conversations_status ON conversations(status, ended_at);
CREATE INDEX IF NOT EXISTS conversation_messages_conversation ON conversation_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS cost_entries_created ON cost_entries(created_at);
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at);
`;

/** Avatars can be megabyte data URLs; snapshots carry a short URL instead. */
export const publicAvatarUrl = (
  id: string,
  avatarUrl: string | null,
): string | null => {
  if (!avatarUrl) return null;
  if (!avatarUrl.startsWith("data:")) return avatarUrl;
  return `/api/characters/${encodeURIComponent(id)}/avatar?v=${hashString(avatarUrl.slice(-64))}`;
};

export class WorldRepository {
  readonly sqlite: Database.Database;
  readonly db: ReturnType<typeof drizzle>;

  constructor(path: string, options: RepositoryOptions = {}) {
    this.sqlite = new Database(path);
    this.sqlite.exec(schemaSql);
    this.ensureColumns("characters", [
      ["movement_started_at", "INTEGER NOT NULL DEFAULT 0"],
      ["movement_arrives_at", "INTEGER NOT NULL DEFAULT 0"],
      ["lease_token", "TEXT"],
      ["lease_until", "INTEGER NOT NULL DEFAULT 0"],
    ]);
    this.ensureColumns("world_state", [
      ["paused_at", "INTEGER NOT NULL DEFAULT 0"],
      ["decision_scale", "REAL NOT NULL DEFAULT 1"],
    ]);
    this.ensureColumns("world_events", [["conversation_id", "TEXT"]]);
    this.sqlite
      .prepare(
        "UPDATE characters SET movement_started_at = CASE WHEN movement_started_at = 0 THEN updated_at ELSE movement_started_at END, movement_arrives_at = CASE WHEN movement_arrives_at = 0 THEN updated_at ELSE movement_arrives_at END",
      )
      .run();
    this.sqlite.exec(indexSql);
    this.db = drizzle(this.sqlite);
    const now = Date.now();
    this.db
      .insert(worldState)
      .values({
        id: 1,
        simulationPaused: false,
        pausedAt: 0,
        serverDailyBudgetMicros: options.serverDailyBudgetMicros ?? 2_000_000,
        serverSpentTodayMicros: 0,
        decisionScale: options.decisionScale ?? 1,
        budgetDate: localDate(),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    if (options.serverDailyBudgetMicros !== undefined)
      this.setServerDailyBudgetMicros(options.serverDailyBudgetMicros);
    if (options.decisionScale !== undefined)
      this.setDecisionScale(options.decisionScale);
    this.resetDailyBudgetsIfNeeded();
  }

  private ensureColumns(table: string, additions: Array<[string, string]>) {
    const columns = new Set(
      (
        this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const [name, definition] of additions) {
      if (!columns.has(name))
        this.sqlite.exec(
          `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
        );
    }
  }

  close(): void {
    this.sqlite.close();
  }

  /**
   * After a crash or restart no job is running: drop leases, return claimed
   * queue items, and refund reservations whose calls never settled.
   */
  recoverAfterRestart(now = Date.now()): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("UPDATE characters SET lease_token = NULL, lease_until = 0")
        .run();
      this.sqlite
        .prepare(
          "UPDATE character_queue SET status = 'pending', not_before = ? WHERE status = 'processing'",
        )
        .run(now);
    })();
    const reserved = this.sqlite
      .prepare("SELECT id FROM cost_entries WHERE status = 'reserved'")
      .all() as Array<{ id: string }>;
    for (const entry of reserved)
      this.releaseCost(entry.id, { error: "interrupted by restart" });
  }

  resetDailyBudgetsIfNeeded(): void {
    const today = localDate();
    const state = this.getWorldState();
    if (state.budgetDate === today) return;
    const now = Date.now();
    this.sqlite.transaction(() => {
      this.db
        .update(worldState)
        .set({ budgetDate: today, serverSpentTodayMicros: 0, updatedAt: now })
        .where(eq(worldState.id, 1))
        .run();
      // SET expressions read the old row, so `intent` still sees the old state.
      this.sqlite
        .prepare(
          `UPDATE characters SET spent_today_micros = 0, budget_date = ?,
            state = CASE WHEN state = 'sleeping' AND intent = ? THEN CASE WHEN paused = 1 THEN 'paused' ELSE 'active' END ELSE state END,
            intent = CASE WHEN state = 'sleeping' AND intent = ? THEN 'Waking up to a new day' ELSE intent END,
            updated_at = ?`,
        )
        .run(today, BUDGET_SLEEP_INTENT, BUDGET_SLEEP_INTENT, now);
    })();
  }

  getWorldState() {
    return this.db.select().from(worldState).where(eq(worldState.id, 1)).get()!;
  }

  /** Returns false when the world was already in the requested state. */
  setSimulationPaused(paused: boolean): boolean {
    const state = this.getWorldState();
    if (state.simulationPaused === paused) return false;
    const now = Date.now();
    this.sqlite.transaction(() => {
      if (!paused && state.pausedAt > 0) {
        const pausedDuration = Math.max(0, now - state.pausedAt);
        this.sqlite
          .prepare(
            "UPDATE conversations SET started_at = started_at + ? WHERE status = 'active'",
          )
          .run(pausedDuration);
        this.sqlite
          .prepare(
            "UPDATE character_queue SET not_before = not_before + ?, expires_at = expires_at + ? WHERE status = 'pending'",
          )
          .run(pausedDuration, pausedDuration);
        this.sqlite
          .prepare(
            "UPDATE characters SET next_decision_at = next_decision_at + ?, last_reaction_at = CASE WHEN last_reaction_at > 0 THEN last_reaction_at + ? ELSE 0 END, movement_started_at = movement_started_at + ?, movement_arrives_at = movement_arrives_at + ?, speech_expires_at = CASE WHEN speech_expires_at IS NOT NULL THEN speech_expires_at + ? ELSE NULL END",
          )
          .run(
            pausedDuration,
            pausedDuration,
            pausedDuration,
            pausedDuration,
            pausedDuration,
          );
      }
      this.db
        .update(worldState)
        .set({
          simulationPaused: paused,
          pausedAt: paused ? now : 0,
          updatedAt: now,
        })
        .where(eq(worldState.id, 1))
        .run();
    })();
    return true;
  }

  setServerDailyBudgetMicros(serverDailyBudgetMicros: number): void {
    this.db
      .update(worldState)
      .set({ serverDailyBudgetMicros, updatedAt: Date.now() })
      .where(eq(worldState.id, 1))
      .run();
  }

  setDecisionScale(decisionScale: number): void {
    this.db
      .update(worldState)
      .set({ decisionScale, updatedAt: Date.now() })
      .where(eq(worldState.id, 1))
      .run();
  }

  listCharacterRows(): CharacterRow[] {
    return this.db
      .select()
      .from(characters)
      .orderBy(asc(characters.createdAt))
      .all();
  }

  getCharacter(idOrName: string): CharacterRow | undefined {
    return this.db
      .select()
      .from(characters)
      .where(
        sql`${characters.id} = ${idOrName} OR lower(${characters.name}) = lower(${idOrName})`,
      )
      .get();
  }

  createCharacter(value: typeof characters.$inferInsert): void {
    this.db.insert(characters).values(value).run();
  }

  updateCharacter(
    id: string,
    patch: Partial<typeof characters.$inferInsert>,
  ): void {
    this.db
      .update(characters)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(characters.id, id))
      .run();
  }

  positionAt(
    character: CharacterRow,
    now = Date.now(),
  ): { x: number; y: number } {
    if (
      character.movementArrivesAt <= character.movementStartedAt ||
      now >= character.movementArrivesAt
    ) {
      return { x: character.targetX, y: character.targetY };
    }
    if (now <= character.movementStartedAt)
      return { x: character.x, y: character.y };
    const progress =
      (now - character.movementStartedAt) /
      (character.movementArrivesAt - character.movementStartedAt);
    return {
      x: character.x + (character.targetX - character.x) * progress,
      y: character.y + (character.targetY - character.y) * progress,
    };
  }

  locationOf(
    character: CharacterRow,
    now = Date.now(),
  ): WorldLocationId | null {
    const position = this.positionAt(character, now);
    return locationAtPoint(position.x, position.y)?.id ?? null;
  }

  startMovement(
    id: string,
    targetX: number,
    targetY: number,
    speedPerSecond: number,
    intent: string,
  ): number | null {
    const character = this.getCharacter(id);
    if (!character) return null;
    const now = Date.now();
    const current = this.positionAt(character, now);
    const duration = Math.max(
      250,
      (Math.hypot(targetX - current.x, targetY - current.y) / speedPerSecond) *
        1_000,
    );
    this.updateCharacter(id, {
      x: current.x,
      y: current.y,
      targetX,
      targetY,
      movementStartedAt: now,
      movementArrivesAt: now + duration,
      state: "moving",
      intent,
    });
    return now + duration;
  }

  materializeArrivals(now = Date.now()): number {
    const result = this.sqlite
      .prepare(
        "UPDATE characters SET x = target_x, y = target_y, movement_started_at = ?, movement_arrives_at = ?, state = CASE WHEN paused = 1 THEN 'paused' ELSE 'active' END, updated_at = ? WHERE state = 'moving' AND movement_arrives_at <= ? AND current_conversation_id IS NULL",
      )
      .run(now, now, now, now);
    return result.changes;
  }

  claimCharacter(id: string, leaseMs = 120_000): string | null {
    const now = Date.now();
    const token = crypto.randomUUID();
    const result = this.sqlite
      .prepare(
        "UPDATE characters SET lease_token = ?, lease_until = ? WHERE id = ? AND (lease_until <= ? OR lease_token IS NULL)",
      )
      .run(token, now + leaseMs, id, now);
    return result.changes === 1 ? token : null;
  }

  releaseCharacter(id: string, token: string): void {
    this.sqlite
      .prepare(
        "UPDATE characters SET lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?",
      )
      .run(id, token);
  }

  activeLeases(now = Date.now()): string[] {
    return (
      this.sqlite
        .prepare("SELECT id FROM characters WHERE lease_until > ?")
        .all(now) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  deleteCharacter(id: string): void {
    this.sqlite.transaction(() => {
      this.db
        .delete(characterQueue)
        .where(eq(characterQueue.characterId, id))
        .run();
      this.db.delete(memories).where(eq(memories.characterId, id)).run();
      this.db
        .delete(relationships)
        .where(
          sql`${relationships.characterId} = ${id} OR ${relationships.otherCharacterId} = ${id}`,
        )
        .run();
      this.db.delete(characters).where(eq(characters.id, id)).run();
    })();
  }

  addEvent(event: WorldEvent): void {
    this.db
      .insert(worldEvents)
      .values({ ...event, conversationId: event.conversationId ?? null })
      .run();
  }

  listEvents(limit = PUBLIC_EVENT_LIMIT): WorldEvent[] {
    return this.db
      .select()
      .from(worldEvents)
      .orderBy(desc(worldEvents.createdAt))
      .limit(limit)
      .all() as WorldEvent[];
  }

  /** Recent events that involve one character, newest first. */
  eventsFor(characterId: string, limit: number): WorldEvent[] {
    return this.db
      .select()
      .from(worldEvents)
      .where(
        sql`(${worldEvents.characterId} = ${characterId} OR ${worldEvents.targetCharacterId} = ${characterId}) AND ${worldEvents.kind} NOT IN ('conversation', 'system')`,
      )
      .orderBy(desc(worldEvents.createdAt))
      .limit(limit)
      .all() as WorldEvent[];
  }

  recap(since: number, until = Date.now()): WorldRecap {
    const count = (where: string) =>
      Number(
        (
          this.sqlite
            .prepare(
              `SELECT count(*) AS count FROM world_events WHERE created_at > ? AND created_at <= ? AND ${where}`,
            )
            .get(since, until) as { count: number }
        ).count,
      );
    const highlights = this.sqlite
      .prepare(
        `SELECT id, kind, character_id AS characterId, character_name AS characterName,
          target_character_id AS targetCharacterId, summary, detail,
          conversation_id AS conversationId, created_at AS createdAt
         FROM world_events
         WHERE created_at > ? AND created_at <= ?
           AND (kind IN ('arrival', 'memory', 'artifact', 'tool')
             OR (kind = 'conversation' AND summary LIKE '% started talking.'))
         ORDER BY created_at DESC LIMIT 8`,
      )
      .all(since, until) as WorldEvent[];
    return {
      since,
      until,
      conversations: count(
        "kind = 'conversation' AND summary LIKE '% started talking.'",
      ),
      memories: count("kind = 'memory'"),
      arrivals: count("kind = 'arrival'"),
      artifacts: count("kind = 'artifact'"),
      highlights,
    };
  }

  enqueue(
    input: Omit<QueueItem, "id"> & { id?: string; dedupeKey?: string },
  ): string | null {
    const id = input.id ?? crypto.randomUUID();
    try {
      this.db
        .insert(characterQueue)
        .values({
          id,
          characterId: input.characterId,
          kind: input.kind,
          payload: JSON.stringify(input.payload),
          priority: input.priority,
          dedupeKey: input.dedupeKey,
          notBefore: input.notBefore,
          expiresAt: input.expiresAt,
          status: "pending",
          createdAt: Date.now(),
        })
        .run();
      return id;
    } catch (error) {
      if (String(error).includes("UNIQUE")) return null;
      throw error;
    }
  }

  private dueQueueRow(characterId: string, now: number, kinds?: string[]) {
    const kindFilter = kinds?.length
      ? `AND kind IN (${kinds.map(() => "?").join(", ")})`
      : "";
    return this.sqlite
      .prepare(
        `SELECT * FROM character_queue
         WHERE character_id = ? AND expires_at > ? AND not_before <= ?
           AND status IN ('pending', 'processing') ${kindFilter}
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
      )
      .get(characterId, now, now, ...(kinds ?? [])) as
      | {
          id: string;
          character_id: string;
          kind: string;
          payload: string;
          priority: number;
          not_before: number;
          expires_at: number;
        }
      | undefined;
  }

  /** Read-only check so idle characters cost no writes. */
  hasDueQueueItem(characterId: string, now: number, kinds?: string[]): boolean {
    return this.dueQueueRow(characterId, now, kinds) !== undefined;
  }

  /**
   * Claims the next due item. A `processing` item whose claim expired (its
   * worker died) is claimable again.
   */
  nextQueueItem(
    characterId: string,
    now: number,
    kinds?: string[],
  ): QueueItem | undefined {
    const row = this.dueQueueRow(characterId, now, kinds);
    if (!row) return undefined;
    const claimed = this.sqlite
      .prepare(
        "UPDATE character_queue SET status = 'processing', not_before = ? WHERE id = ? AND (status = 'pending' OR (status = 'processing' AND not_before <= ?))",
      )
      .run(now + QUEUE_LEASE_MS, row.id, now);
    if (claimed.changes !== 1) return undefined;
    return {
      id: row.id,
      characterId: row.character_id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      priority: row.priority,
      notBefore: row.not_before,
      expiresAt: row.expires_at,
    };
  }

  completeQueueItem(id: string): void {
    this.db
      .update(characterQueue)
      .set({ status: "completed" })
      .where(eq(characterQueue.id, id))
      .run();
  }

  /** Put a claimed item back to run later. */
  deferQueueItem(id: string, notBefore: number): void {
    this.db
      .update(characterQueue)
      .set({ status: "pending", notBefore })
      .where(eq(characterQueue.id, id))
      .run();
  }

  /** Consumes a pending item by dedupe key and returns its payload. */
  takeQueueItem(
    characterId: string,
    dedupeKey: string,
  ): Record<string, unknown> | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, payload FROM character_queue WHERE character_id = ? AND dedupe_key = ? AND status = 'pending'",
      )
      .get(characterId, dedupeKey) as
      { id: string; payload: string } | undefined;
    if (!row) return null;
    const result = this.sqlite
      .prepare(
        "UPDATE character_queue SET status = 'completed' WHERE id = ? AND status = 'pending'",
      )
      .run(row.id);
    return result.changes === 1
      ? (JSON.parse(row.payload) as Record<string, unknown>)
      : null;
  }

  cancelQueueItems(dedupeKey: string): void {
    this.sqlite
      .prepare(
        "UPDATE character_queue SET status = 'completed' WHERE dedupe_key = ? AND status = 'pending'",
      )
      .run(dedupeKey);
  }

  queueDepth(characterId?: string, now = Date.now()): number {
    const row = (
      characterId
        ? this.sqlite
            .prepare(
              "SELECT count(*) AS count FROM character_queue WHERE status = 'pending' AND expires_at > ? AND character_id = ?",
            )
            .get(now, characterId)
        : this.sqlite
            .prepare(
              "SELECT count(*) AS count FROM character_queue WHERE status = 'pending' AND expires_at > ?",
            )
            .get(now)
    ) as { count: number };
    return Number(row.count);
  }

  createConversation(aId: string, bId: string): ConversationRecord {
    const record: ConversationRecord = {
      id: crypto.randomUUID(),
      characterAId: aId,
      characterBId: bId,
      status: "active",
      messageCount: 0,
      startedAt: Date.now(),
    };
    this.db.insert(conversations).values(record).run();
    return record;
  }

  getConversation(id: string): ConversationRecord | undefined {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get() as ConversationRecord | undefined;
  }

  lastEndedConversationBetween(
    aId: string,
    bId: string,
  ): ConversationRecord | undefined {
    return this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.status, "ended"),
          sql`((${conversations.characterAId} = ${aId} AND ${conversations.characterBId} = ${bId}) OR (${conversations.characterAId} = ${bId} AND ${conversations.characterBId} = ${aId}))`,
        ),
      )
      .orderBy(desc(conversations.endedAt))
      .limit(1)
      .get() as ConversationRecord | undefined;
  }

  updateConversation(
    id: string,
    patch: Partial<typeof conversations.$inferInsert>,
  ): void {
    this.db
      .update(conversations)
      .set(patch)
      .where(eq(conversations.id, id))
      .run();
  }

  /** Atomic; returns the new count, or null if the conversation is not active. */
  incrementConversationMessages(id: string): number | null {
    const row = this.sqlite
      .prepare(
        "UPDATE conversations SET message_count = message_count + 1 WHERE id = ? AND status = 'active' RETURNING message_count AS messageCount",
      )
      .get(id) as { messageCount: number } | undefined;
    return row?.messageCount ?? null;
  }

  /** Only the first caller wins, so two jobs cannot both end a conversation. */
  markConversationEnded(id: string, reason: string): boolean {
    return (
      this.sqlite
        .prepare(
          "UPDATE conversations SET status = 'ended', ended_at = ?, termination_reason = ? WHERE id = ? AND status = 'active'",
        )
        .run(Date.now(), reason, id).changes === 1
    );
  }

  addConversationMessage(input: {
    conversationId: string;
    speakerId: string | null;
    speakerName: string;
    text: string;
  }): void {
    this.db
      .insert(conversationMessages)
      .values({ id: crypto.randomUUID(), createdAt: Date.now(), ...input })
      .run();
  }

  /** Chronological. With `limit`, the latest `limit` messages. */
  listConversationMessages(
    conversationId: string,
    limit?: number,
  ): ConversationMessage[] {
    const rows = this.db
      .select({
        speakerId: conversationMessages.speakerId,
        speakerName: conversationMessages.speakerName,
        text: conversationMessages.text,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit ?? -1)
      .all();
    return rows.reverse();
  }

  addMemory(input: {
    characterId: string;
    kind: "fact" | "impression";
    bullet: string;
    subject?: string;
    sourceEventId?: string;
  }): void {
    if (input.subject) {
      this.db
        .update(memories)
        .set({ active: false })
        .where(
          and(
            eq(memories.characterId, input.characterId),
            eq(memories.kind, input.kind),
            eq(memories.subject, input.subject),
            eq(memories.active, true),
          ),
        )
        .run();
    }
    this.db
      .insert(memories)
      .values({
        id: crypto.randomUUID(),
        characterId: input.characterId,
        kind: input.kind,
        bullet: input.bullet,
        subject: input.subject,
        confidence: 0.75,
        sourceEventId: input.sourceEventId,
        active: true,
        createdAt: Date.now(),
      })
      .run();
  }

  memoriesFor(characterId: string, limit = 50): PublicMemory[] {
    return this.db
      .select({
        id: memories.id,
        kind: memories.kind,
        bullet: memories.bullet,
        subject: memories.subject,
        confidence: memories.confidence,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(
        and(eq(memories.characterId, characterId), eq(memories.active, true)),
      )
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .all() as PublicMemory[];
  }

  upsertRelationship(
    characterId: string,
    otherCharacterId: string,
    impression: string,
    affinityDelta = 1,
  ): void {
    this.db
      .insert(relationships)
      .values({
        characterId,
        otherCharacterId,
        impression,
        affinity: affinityDelta,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [relationships.characterId, relationships.otherCharacterId],
        set: {
          impression,
          affinity: sql`${relationships.affinity} + ${affinityDelta}`,
          updatedAt: Date.now(),
        },
      })
      .run();
  }

  relationshipsFor(characterId: string): PublicRelationship[] {
    return this.sqlite
      .prepare(
        `SELECT r.other_character_id AS characterId, coalesce(c.name, 'Unknown') AS characterName,
          r.impression AS impression, r.affinity AS affinity
         FROM relationships r LEFT JOIN characters c ON c.id = r.other_character_id
         WHERE r.character_id = ? ORDER BY r.affinity DESC, r.updated_at DESC`,
      )
      .all(characterId) as PublicRelationship[];
  }

  /** How warmly everyone else regards this character. */
  private reputations(): Map<string, number> {
    const rows = this.sqlite
      .prepare(
        "SELECT other_character_id AS id, sum(affinity) AS total FROM relationships GROUP BY other_character_id",
      )
      .all() as Array<{ id: string; total: number }>;
    return new Map(rows.map((row) => [row.id, Number(row.total)]));
  }

  private snapshotTime(): number {
    const state = this.getWorldState();
    return state.simulationPaused && state.pausedAt > 0
      ? state.pausedAt
      : Date.now();
  }

  listPublicCharacters(): PublicCharacter[] {
    const currentTime = this.snapshotTime();
    const reputations = this.reputations();
    return this.listCharacterRows().map((row) =>
      this.toPublicCharacter(row, currentTime, reputations.get(row.id) ?? 0),
    );
  }

  private toPublicCharacter(
    row: CharacterRow,
    currentTime: number,
    reputation: number,
  ): PublicCharacter {
    const position = this.positionAt(row, currentTime);
    return {
      id: row.id,
      name: row.name,
      personality: row.personality,
      model: row.model,
      dailyBudgetMicros: row.dailyBudgetMicros,
      spentTodayMicros: row.spentTodayMicros,
      decisionIntervalSeconds: row.decisionIntervalSeconds,
      state: row.state as CharacterState,
      x: position.x,
      y: position.y,
      targetX: row.targetX,
      targetY: row.targetY,
      movementArrivesAt: Math.max(row.movementArrivesAt, row.movementStartedAt),
      intent: row.intent,
      speech:
        row.speechExpiresAt && row.speechExpiresAt > currentTime
          ? row.speech
          : null,
      avatarUrl: publicAvatarUrl(row.id, row.avatarUrl),
      avatarColor: row.avatarColor,
      toolActive: row.toolActive,
      reputation,
      locationId: locationAtPoint(position.x, position.y)?.id ?? null,
      currentConversationId: row.currentConversationId,
      updatedAt: row.updatedAt,
    };
  }

  inspect(idOrName: string): CharacterInspect | null {
    const row = this.getCharacter(idOrName);
    if (!row) return null;
    const publicCharacter = this.toPublicCharacter(
      row,
      this.snapshotTime(),
      this.reputations().get(row.id) ?? 0,
    );
    return {
      id: row.id,
      name: row.name,
      personality: row.personality,
      model: row.model,
      dailyBudgetMicros: row.dailyBudgetMicros,
      spentTodayMicros: row.spentTodayMicros,
      decisionIntervalSeconds: row.decisionIntervalSeconds,
      reputation: publicCharacter.reputation,
      locationId: publicCharacter.locationId,
      memories: this.memoriesFor(row.id),
      relationships: this.relationshipsFor(row.id),
    };
  }

  avatarFor(idOrName: string): string | null {
    return this.getCharacter(idOrName)?.avatarUrl ?? null;
  }

  addArtifact(input: Omit<WorldArtifact, "id" | "createdAt">): WorldArtifact {
    const artifact: WorldArtifact = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...input,
    };
    this.db.insert(artifacts).values(artifact).run();
    return artifact;
  }

  listArtifacts(limit = 20, locationId?: WorldLocationId): WorldArtifact[] {
    const query = this.db.select().from(artifacts);
    return (
      locationId ? query.where(eq(artifacts.locationId, locationId)) : query
    )
      .orderBy(desc(artifacts.createdAt))
      .limit(limit)
      .all() as WorldArtifact[];
  }

  reserveCost(input: {
    characterId?: string;
    category: string;
    provider: string;
    maxMicros: number;
    countAgainstCharacter: boolean;
  }): string | null {
    this.resetDailyBudgetsIfNeeded();
    return this.sqlite.transaction(() => {
      const state = this.getWorldState();
      if (
        state.serverSpentTodayMicros + input.maxMicros >
        state.serverDailyBudgetMicros
      )
        return null;
      const character = input.characterId
        ? this.getCharacter(input.characterId)
        : undefined;
      if (
        input.countAgainstCharacter &&
        character &&
        character.spentTodayMicros + input.maxMicros >
          character.dailyBudgetMicros
      )
        return null;
      const id = crypto.randomUUID();
      this.db
        .insert(costEntries)
        .values({
          id,
          characterId: input.characterId,
          category: input.category,
          provider: input.provider,
          amountMicros: 0,
          reservedMicros: input.maxMicros,
          status: "reserved",
          metadata: "{}",
          budgetDate: state.budgetDate,
          createdAt: Date.now(),
        })
        .run();
      this.db
        .update(worldState)
        .set({
          serverSpentTodayMicros:
            state.serverSpentTodayMicros + input.maxMicros,
        })
        .where(eq(worldState.id, 1))
        .run();
      if (input.countAgainstCharacter && character) {
        this.db
          .update(characters)
          .set({
            spentTodayMicros: character.spentTodayMicros + input.maxMicros,
          })
          .where(eq(characters.id, character.id))
          .run();
      }
      return id;
    })();
  }

  /**
   * Records what the provider actually charged, even above the reservation:
   * the money is spent either way, so the ledger must not understate it.
   */
  settleCost(
    id: string,
    amountMicros: number,
    metadata: Record<string, unknown> = {},
    latencyMs?: number,
  ): void {
    this.sqlite.transaction(() => {
      const entry = this.db
        .select()
        .from(costEntries)
        .where(eq(costEntries.id, id))
        .get();
      if (!entry || entry.status !== "reserved") return;
      const actual = Math.max(0, Math.round(amountMicros));
      const delta = actual - entry.reservedMicros;
      this.sqlite
        .prepare(
          "UPDATE world_state SET server_spent_today_micros = max(0, server_spent_today_micros + ?) WHERE id = 1",
        )
        .run(delta);
      if (entry.characterId && entry.category !== "avatar")
        this.sqlite
          .prepare(
            "UPDATE characters SET spent_today_micros = max(0, spent_today_micros + ?) WHERE id = ?",
          )
          .run(delta, entry.characterId);
      this.db
        .update(costEntries)
        .set({
          amountMicros: actual,
          status: "settled",
          latencyMs,
          metadata: JSON.stringify(metadata),
        })
        .where(eq(costEntries.id, id))
        .run();
    })();
  }

  releaseCost(id: string, metadata: Record<string, unknown> = {}): void {
    this.settleCost(id, 0, metadata);
    this.db
      .update(costEntries)
      .set({ status: "failed" })
      .where(eq(costEntries.id, id))
      .run();
  }

  listCosts(limit = 200) {
    return this.db
      .select()
      .from(costEntries)
      .orderBy(desc(costEntries.createdAt))
      .limit(limit)
      .all();
  }

  /** Drops history nothing reads any more. Safe to run at any time. */
  prune(now = Date.now()): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "DELETE FROM cost_entries WHERE created_at < ? AND status != 'reserved'",
        )
        .run(now - 7 * DAY_MS);
      this.sqlite
        .prepare(
          "DELETE FROM character_queue WHERE (status = 'completed' AND created_at < ?) OR (status = 'pending' AND expires_at < ?)",
        )
        .run(now - HOUR_MS, now - HOUR_MS);
      this.sqlite
        .prepare(
          "DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE status = 'ended' AND ended_at < ?)",
        )
        .run(now - 30 * DAY_MS);
      this.sqlite
        .prepare(
          "DELETE FROM conversations WHERE status = 'ended' AND ended_at < ?",
        )
        .run(now - 30 * DAY_MS);
      this.sqlite
        .prepare("DELETE FROM memories WHERE active = 0 AND created_at < ?")
        .run(now - DAY_MS);
      this.sqlite
        .prepare(
          "DELETE FROM world_events WHERE created_at < (SELECT created_at FROM world_events ORDER BY created_at DESC LIMIT 1 OFFSET ?)",
        )
        .run(EVENT_RETENTION - 1);
      this.sqlite
        .prepare(
          "DELETE FROM artifacts WHERE created_at < (SELECT created_at FROM artifacts ORDER BY created_at DESC LIMIT 1 OFFSET ?)",
        )
        .run(ARTIFACT_RETENTION - 1);
    })();
  }

  resetWorld(): void {
    this.sqlite.transaction(() => {
      for (const table of [
        characterQueue,
        relationships,
        memories,
        conversationMessages,
        conversations,
        worldEvents,
        costEntries,
        artifacts,
        characters,
      ]) {
        this.db.delete(table).run();
      }
      this.db
        .update(worldState)
        .set({
          simulationPaused: false,
          pausedAt: 0,
          serverSpentTodayMicros: 0,
          budgetDate: localDate(),
          updatedAt: Date.now(),
        })
        .where(eq(worldState.id, 1))
        .run();
    })();
  }
}

/** Persistence port used by the domain engine. */
export type WorldStore = Omit<WorldRepository, "sqlite" | "db" | "close">;
