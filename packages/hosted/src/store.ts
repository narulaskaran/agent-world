import type { WorldArtifact, WorldLocationId } from "@agent-world/shared";

export interface CharacterRow {
  id: string;
  ownerId: string;
  name: string;
  personality: string;
  model: string;
  dailyBudgetMicros: number;
  spentTodayMicros: number;
  budgetDate: string;
  decisionIntervalSeconds: number;
  nextDecisionAt: number;
  lastReactionAt: number;
  state: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  movementStartedAt: number;
  movementArrivesAt: number;
  intent: string;
  speech: string | null;
  speechExpiresAt: number | null;
  avatarUrl: string | null;
  avatarColor: string;
  toolActive: boolean;
  paused: boolean;
  muted: boolean;
  reputation: number;
  locationId: WorldLocationId | null;
  currentConversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRow {
  id: string;
  characterId: string;
  kind: "fact" | "impression";
  bullet: string;
  subject: string | null;
  confidence: number;
  active: boolean;
  createdAt: number;
}

export interface RelationshipRow {
  characterId: string;
  otherCharacterId: string;
  impression: string;
  affinity: number;
  updatedAt: number;
}

export interface EventRow {
  id: string;
  kind: string;
  characterId: string | null;
  characterName: string | null;
  targetCharacterId: string | null;
  summary: string;
  detail: string | null;
  visibility: "public" | "private";
  hidden: boolean;
  conversationId: string | null;
  createdAt: number;
}

export interface QueueJob {
  id: string;
  characterId: string;
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  dedupeKey: string | null;
  notBefore: number;
  expiresAt: number;
  status: string;
  attemptCount: number;
  createdAt: number;
}

export interface ConversationRow {
  id: string;
  characterAId: string;
  characterBId: string;
  status: string;
  messageCount: number;
  visibility: "public" | "private";
  locationId: string | null;
  startedAt: number;
}

export interface ReportRow {
  id: string;
  reporterId: string;
  characterId: string | null;
  eventId: string | null;
  reason: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  resolverId: string | null;
}

export interface AlertRow {
  id: string;
  level: string;
  kind: string;
  summary: string;
  detail: string | null;
  createdAt: number;
}

export interface CostRow {
  id: string;
  characterId: string | null;
  category: string;
  provider: string;
  amountMicros: number;
  reservedMicros: number;
  status: string;
  createdAt: number;
}

export interface WorldStateRow {
  simulationPaused: boolean;
  pausedAt: number;
  serverDailyBudgetMicros: number;
  serverSpentTodayMicros: number;
  budgetDate: string;
  updatedAt: number;
}

export const CLAIM_JOB_SQL = `WITH candidate AS (
  SELECT id FROM character_queue
  WHERE status = 'pending' AND not_before <= $1 AND expires_at > $1
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
) UPDATE character_queue AS queue
  SET status = 'processing', claimed_at = $1, not_before = $2, attempt_count = queue.attempt_count + 1
  FROM candidate
  WHERE queue.id = candidate.id
  RETURNING queue.*`;

export interface HostedStore {
  ensureSchema(): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  getWorldState(): Promise<WorldStateRow>;
  setSimulationPaused(paused: boolean, now: number): Promise<void>;
  setServerBudget(micros: number, now: number): Promise<void>;
  resetWorld(now: number): Promise<void>;

  listCharacters(): Promise<CharacterRow[]>;
  getCharacter(idOrName: string): Promise<CharacterRow | null>;
  findOwned(key: string, ownerId: string): Promise<CharacterRow | null>;
  listOwnedIds(ownerId: string): Promise<string[]>;
  countOwned(ownerId: string): Promise<number>;
  insertCharacter(row: CharacterRow): Promise<void>;
  updateCharacter(id: string, patch: Partial<CharacterRow>): Promise<void>;
  deleteCharacter(id: string): Promise<void>;

  listMemories(): Promise<MemoryRow[]>;
  addMemory(row: MemoryRow): Promise<void>;
  replaceMemories(characterId: string, rows: MemoryRow[]): Promise<void>;
  listRelationships(): Promise<RelationshipRow[]>;
  upsertRelationship(row: RelationshipRow): Promise<void>;

  addEvent(row: EventRow): Promise<void>;
  listEvents(input: {
    limit: number;
    viewerCharacterIds: string[];
    isAdmin: boolean;
  }): Promise<EventRow[]>;
  hideEvent(id: string): Promise<boolean>;
  pruneEvents(now: number, keep: number, maxAgeMs: number): Promise<number>;

  enqueueJob(
    row: Omit<QueueJob, "status" | "attemptCount"> & {
      status?: string;
      attemptCount?: number;
    },
  ): Promise<string | null>;
  claimNextJob(now: number, leaseMs: number): Promise<QueueJob | null>;
  completeJob(id: string): Promise<void>;
  failJob(
    id: string,
    error: string,
    now: number,
    maxAttempts: number,
  ): Promise<void>;
  recoverStaleJobs(now: number): Promise<number>;
  expireJobs(now: number): Promise<number>;
  countDueJobs(now: number): Promise<number>;
  dueCharacterIds(now: number): Promise<string[]>;
  queueDepth(): Promise<number>;
  getJob(id: string): Promise<QueueJob | null>;

  insertConversation(row: ConversationRow, memberIds: string[]): Promise<void>;
  addConversationMessage(input: {
    id: string;
    conversationId: string;
    characterId: string;
    characterName: string;
    turn: number;
    text: string;
    createdAt: number;
  }): Promise<void>;
  listConversationMembers(conversationId: string): Promise<string[]>;

  listArtifacts(): Promise<WorldArtifact[]>;
  addArtifact(row: WorldArtifact): Promise<void>;

  addReport(row: ReportRow): Promise<void>;
  listReports(): Promise<ReportRow[]>;
  resolveReport(id: string, resolverId: string, now: number): Promise<void>;

  hitRateLimit(
    key: string,
    windowMs: number,
    max: number,
    now: number,
  ): Promise<boolean>;
  addAlert(row: AlertRow): Promise<void>;
  listAlerts(limit: number): Promise<AlertRow[]>;
  listCosts(limit: number): Promise<CostRow[]>;
}
