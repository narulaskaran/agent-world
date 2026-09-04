import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    personality: text("personality").notNull(),
    model: text("model").notNull(),
    dailyBudgetMicros: integer("daily_budget_micros").notNull(),
    spentTodayMicros: integer("spent_today_micros").notNull().default(0),
    budgetDate: text("budget_date").notNull(),
    decisionIntervalSeconds: integer("decision_interval_seconds")
      .notNull()
      .default(60),
    nextDecisionAt: integer("next_decision_at").notNull(),
    lastReactionAt: integer("last_reaction_at").notNull().default(0),
    state: text("state").notNull().default("active"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    targetX: real("target_x").notNull(),
    targetY: real("target_y").notNull(),
    movementStartedAt: integer("movement_started_at").notNull(),
    movementArrivesAt: integer("movement_arrives_at").notNull(),
    intent: text("intent").notNull().default("Taking in the world"),
    speech: text("speech"),
    speechExpiresAt: integer("speech_expires_at"),
    avatarUrl: text("avatar_url"),
    avatarColor: text("avatar_color").notNull(),
    toolActive: integer("tool_active", { mode: "boolean" })
      .notNull()
      .default(false),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    currentConversationId: text("current_conversation_id"),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("characters_name_unique").on(table.name)],
);

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull(),
  kind: text("kind").notNull(),
  bullet: text("bullet").notNull(),
  subject: text("subject"),
  confidence: real("confidence").notNull().default(0.7),
  sourceEventId: text("source_event_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const relationships = sqliteTable(
  "relationships",
  {
    characterId: text("character_id").notNull(),
    otherCharacterId: text("other_character_id").notNull(),
    impression: text("impression").notNull(),
    affinity: integer("affinity").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("relationships_pair_unique").on(
      table.characterId,
      table.otherCharacterId,
    ),
  ],
);

export const worldEvents = sqliteTable("world_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  characterId: text("character_id"),
  characterName: text("character_name"),
  targetCharacterId: text("target_character_id"),
  summary: text("summary").notNull(),
  detail: text("detail"),
  createdAt: integer("created_at").notNull(),
});

export const characterQueue = sqliteTable("character_queue", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  priority: integer("priority").notNull().default(0),
  dedupeKey: text("dedupe_key"),
  notBefore: integer("not_before").notNull(),
  expiresAt: integer("expires_at").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  characterAId: text("character_a_id").notNull(),
  characterBId: text("character_b_id").notNull(),
  status: text("status").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  terminationReason: text("termination_reason"),
});

export const costEntries = sqliteTable("cost_entries", {
  id: text("id").primaryKey(),
  characterId: text("character_id"),
  category: text("category").notNull(),
  provider: text("provider").notNull(),
  amountMicros: integer("amount_micros").notNull(),
  reservedMicros: integer("reserved_micros").notNull(),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms"),
  metadata: text("metadata").notNull().default("{}"),
  budgetDate: text("budget_date").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const worldState = sqliteTable("world_state", {
  id: integer("id").primaryKey(),
  simulationPaused: integer("simulation_paused", { mode: "boolean" })
    .notNull()
    .default(false),
  pausedAt: integer("paused_at").notNull().default(0),
  serverDailyBudgetMicros: integer("server_daily_budget_micros")
    .notNull()
    .default(2_000_000),
  serverSpentTodayMicros: integer("server_spent_today_micros")
    .notNull()
    .default(0),
  budgetDate: text("budget_date").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
