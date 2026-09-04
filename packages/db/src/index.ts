import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type {
  CharacterState,
  PublicCharacter,
  PublicMemory,
  PublicRelationship,
  WorldEvent,
} from "@agent-world/shared";
import {
  characterQueue,
  characters,
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

const schemaSql = `
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
  target_character_id TEXT, summary TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS character_queue (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT, not_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS character_queue_dedupe_pending
  ON character_queue(character_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, character_a_id TEXT NOT NULL, character_b_id TEXT NOT NULL,
  status TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
  ended_at INTEGER, termination_reason TEXT
);
CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY, character_id TEXT, category TEXT NOT NULL, provider TEXT NOT NULL,
  amount_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, status TEXT NOT NULL,
  latency_ms INTEGER, metadata TEXT NOT NULL DEFAULT '{}', budget_date TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_state (
  id INTEGER PRIMARY KEY CHECK(id = 1), simulation_paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER NOT NULL DEFAULT 0,
  server_daily_budget_micros INTEGER NOT NULL DEFAULT 2000000,
  server_spent_today_micros INTEGER NOT NULL DEFAULT 0, budget_date TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

export class WorldRepository {
  readonly sqlite: Database.Database;
  readonly db: ReturnType<typeof drizzle>;

  constructor(path: string) {
    this.sqlite = new Database(path);
    this.sqlite.exec(schemaSql);
    this.ensureCharacterColumns();
    this.ensureWorldStateColumns();
    this.db = drizzle(this.sqlite);
    const now = Date.now();
    this.db
      .insert(worldState)
      .values({
        id: 1,
        simulationPaused: false,
        pausedAt: 0,
        serverDailyBudgetMicros: Number(
          process.env.AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS ?? 2_000_000,
        ),
        serverSpentTodayMicros: 0,
        budgetDate: localDate(),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    this.resetDailyBudgetsIfNeeded();
  }

  private ensureCharacterColumns(): void {
    const columns = new Set(
      (
        this.sqlite.prepare("PRAGMA table_info(characters)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ["movement_started_at", "INTEGER NOT NULL DEFAULT 0"],
      ["movement_arrives_at", "INTEGER NOT NULL DEFAULT 0"],
      ["lease_token", "TEXT"],
      ["lease_until", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name))
        this.sqlite.exec(
          `ALTER TABLE characters ADD COLUMN ${name} ${definition}`,
        );
    }
    this.sqlite
      .prepare(
        "UPDATE characters SET movement_started_at = CASE WHEN movement_started_at = 0 THEN updated_at ELSE movement_started_at END, movement_arrives_at = CASE WHEN movement_arrives_at = 0 THEN updated_at ELSE movement_arrives_at END",
      )
      .run();
  }

  private ensureWorldStateColumns(): void {
    const columns = new Set(
      (
        this.sqlite.prepare("PRAGMA table_info(world_state)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("paused_at"))
      this.sqlite.exec(
        "ALTER TABLE world_state ADD COLUMN paused_at INTEGER NOT NULL DEFAULT 0",
      );
  }

  close(): void {
    this.sqlite.close();
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
      this.sqlite
        .prepare(
          "UPDATE characters SET spent_today_micros = 0, budget_date = ?, state = CASE WHEN paused = 1 THEN 'paused' ELSE 'active' END, updated_at = ?",
        )
        .run(today, now);
    })();
  }

  getWorldState() {
    return this.db.select().from(worldState).where(eq(worldState.id, 1)).get()!;
  }

  setSimulationPaused(paused: boolean): void {
    const state = this.getWorldState();
    if (state.simulationPaused === paused) return;
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
  }

  setServerDailyBudgetMicros(serverDailyBudgetMicros: number): void {
    this.db
      .update(worldState)
      .set({ serverDailyBudgetMicros, updatedAt: Date.now() })
      .where(eq(worldState.id, 1))
      .run();
  }

  listCharacterRows() {
    this.resetDailyBudgetsIfNeeded();
    return this.db
      .select()
      .from(characters)
      .orderBy(asc(characters.createdAt))
      .all();
  }

  getCharacter(idOrName: string) {
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
    character: typeof characters.$inferSelect,
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

  startMovement(
    id: string,
    targetX: number,
    targetY: number,
    speedPerSecond: number,
    intent: string,
  ): void {
    const character = this.getCharacter(id);
    if (!character) return;
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
    this.db.insert(worldEvents).values(event).run();
    this.sqlite
      .prepare(
        "DELETE FROM world_events WHERE id IN (SELECT id FROM world_events ORDER BY created_at DESC LIMIT -1 OFFSET 100)",
      )
      .run();
  }

  listEvents(): WorldEvent[] {
    return this.db
      .select()
      .from(worldEvents)
      .orderBy(desc(worldEvents.createdAt))
      .limit(100)
      .all() as WorldEvent[];
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

  nextQueueItem(characterId: string, now: number): QueueItem | undefined {
    this.db
      .update(characterQueue)
      .set({ status: "pending" })
      .where(
        and(
          eq(characterQueue.characterId, characterId),
          eq(characterQueue.status, "processing"),
          lte(characterQueue.notBefore, now),
        ),
      )
      .run();
    this.db
      .update(characterQueue)
      .set({ status: "expired" })
      .where(
        and(
          eq(characterQueue.characterId, characterId),
          eq(characterQueue.status, "pending"),
          lte(characterQueue.expiresAt, now),
        ),
      )
      .run();
    const row = this.db
      .select()
      .from(characterQueue)
      .where(
        and(
          eq(characterQueue.characterId, characterId),
          eq(characterQueue.status, "pending"),
          lte(characterQueue.notBefore, now),
        ),
      )
      .orderBy(desc(characterQueue.priority), asc(characterQueue.createdAt))
      .get();
    if (!row) return undefined;
    const claimed = this.db
      .update(characterQueue)
      .set({ status: "processing", notBefore: now + 120_000 })
      .where(
        and(
          eq(characterQueue.id, row.id),
          eq(characterQueue.status, "pending"),
        ),
      )
      .run();
    if (claimed.changes !== 1) return undefined;
    return { ...row, payload: JSON.parse(row.payload) };
  }

  completeQueueItem(id: string): void {
    this.db
      .update(characterQueue)
      .set({ status: "completed" })
      .where(eq(characterQueue.id, id))
      .run();
  }

  queueDepth(characterId?: string): number {
    const row = characterId
      ? this.db
          .select({ count: sql<number>`count(*)` })
          .from(characterQueue)
          .where(
            and(
              eq(characterQueue.status, "pending"),
              eq(characterQueue.characterId, characterId),
            ),
          )
          .get()
      : this.db
          .select({ count: sql<number>`count(*)` })
          .from(characterQueue)
          .where(eq(characterQueue.status, "pending"))
          .get();
    return Number(row?.count ?? 0);
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

  listPublicCharacters(): PublicCharacter[] {
    const rows = this.listCharacterRows();
    const memoryRows = this.db
      .select()
      .from(memories)
      .where(eq(memories.active, true))
      .orderBy(desc(memories.createdAt))
      .all();
    const relationshipRows = this.db.select().from(relationships).all();
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const state = this.getWorldState();
    const currentTime =
      state.simulationPaused && state.pausedAt > 0
        ? state.pausedAt
        : Date.now();
    return rows.map((row) => {
      const publicMemories: PublicMemory[] = memoryRows
        .filter((memory) => memory.characterId === row.id)
        .map((memory) => ({
          id: memory.id,
          kind: memory.kind as "fact" | "impression",
          bullet: memory.bullet,
          subject: memory.subject,
          confidence: memory.confidence,
          createdAt: memory.createdAt,
        }));
      const publicRelationships: PublicRelationship[] = relationshipRows
        .filter((relationship) => relationship.characterId === row.id)
        .map((relationship) => ({
          characterId: relationship.otherCharacterId,
          characterName: names.get(relationship.otherCharacterId) ?? "Unknown",
          impression: relationship.impression,
          affinity: relationship.affinity,
        }));
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
        intent: row.intent,
        speech:
          row.speechExpiresAt && row.speechExpiresAt > currentTime
            ? row.speech
            : null,
        avatarUrl: row.avatarUrl,
        avatarColor: row.avatarColor,
        toolActive: row.toolActive,
        reputation: publicRelationships.reduce(
          (sum, relationship) => sum + relationship.affinity,
          0,
        ),
        locationId: null,
        memories: publicMemories,
        relationships: publicRelationships,
        updatedAt: row.updatedAt,
      };
    });
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
      const actual = Math.max(0, Math.min(amountMicros, entry.reservedMicros));
      const release = entry.reservedMicros - actual;
      const state = this.getWorldState();
      this.db
        .update(worldState)
        .set({
          serverSpentTodayMicros: Math.max(
            0,
            state.serverSpentTodayMicros - release,
          ),
        })
        .where(eq(worldState.id, 1))
        .run();
      if (entry.characterId && entry.category !== "avatar") {
        const character = this.getCharacter(entry.characterId);
        if (character)
          this.db
            .update(characters)
            .set({
              spentTodayMicros: Math.max(
                0,
                character.spentTodayMicros - release,
              ),
            })
            .where(eq(characters.id, character.id))
            .run();
      }
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

  listCosts() {
    return this.db
      .select()
      .from(costEntries)
      .orderBy(desc(costEntries.createdAt))
      .limit(200)
      .all();
  }

  resetWorld(): void {
    this.sqlite.transaction(() => {
      for (const table of [
        characterQueue,
        relationships,
        memories,
        conversations,
        worldEvents,
        costEntries,
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

/** Persistence port used by the domain engine. A Neon adapter implements this contract without SQLite. */
export type WorldStore = Omit<WorldRepository, "sqlite" | "db" | "close">;
