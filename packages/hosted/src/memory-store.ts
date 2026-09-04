import type { WorldArtifact } from "@agent-world/shared";
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

class Mutex {
  private chain = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements HostedStore {
  private readonly mutex = new Mutex();
  private depth = 0;
  world: WorldStateRow = {
    simulationPaused: false,
    pausedAt: 0,
    serverDailyBudgetMicros: 2_000_000,
    serverSpentTodayMicros: 0,
    budgetDate: new Date().toISOString().slice(0, 10),
    updatedAt: 0,
  };
  characters = new Map<string, CharacterRow>();
  memories: MemoryRow[] = [];
  relationships = new Map<string, RelationshipRow>();
  events: EventRow[] = [];
  jobs = new Map<string, QueueJob>();
  conversations = new Map<string, ConversationRow>();
  conversationMembers = new Map<string, Set<string>>();
  messages: Array<{
    id: string;
    conversationId: string;
    characterId: string;
    characterName: string;
    turn: number;
    text: string;
    createdAt: number;
  }> = [];
  artifacts: WorldArtifact[] = [];
  reports: ReportRow[] = [];
  alerts: AlertRow[] = [];
  costs: CostRow[] = [];
  rateLimits = new Map<string, { windowStart: number; count: number }>();

  async ensureSchema(): Promise<void> {}

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn();
    return this.mutex.run(async () => {
      this.depth += 1;
      try {
        return await fn();
      } finally {
        this.depth -= 1;
      }
    });
  }

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.depth > 0) return Promise.resolve(fn());
    return this.mutex.run(async () => fn());
  }

  async getWorldState(): Promise<WorldStateRow> {
    return clone(this.world);
  }

  async setSimulationPaused(paused: boolean, now: number): Promise<void> {
    await this.locked(() => {
      this.world.simulationPaused = paused;
      this.world.pausedAt = paused ? now : 0;
      this.world.updatedAt = now;
    });
  }

  async setServerBudget(micros: number, now: number): Promise<void> {
    await this.locked(() => {
      this.world.serverDailyBudgetMicros = micros;
      this.world.updatedAt = now;
    });
  }

  async resetWorld(now: number): Promise<void> {
    await this.locked(() => {
      this.characters.clear();
      this.memories = [];
      this.relationships.clear();
      this.events = [];
      this.jobs.clear();
      this.conversations.clear();
      this.conversationMembers.clear();
      this.messages = [];
      this.artifacts = [];
      this.reports = [];
      this.costs = [];
      this.world.simulationPaused = false;
      this.world.pausedAt = 0;
      this.world.serverSpentTodayMicros = 0;
      this.world.budgetDate = new Date(now).toISOString().slice(0, 10);
      this.world.updatedAt = now;
    });
  }

  async listCharacters(): Promise<CharacterRow[]> {
    return [...this.characters.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async getCharacter(idOrName: string): Promise<CharacterRow | null> {
    const direct = this.characters.get(idOrName);
    if (direct) return clone(direct);
    const named = [...this.characters.values()].find(
      (row) => row.name.toLowerCase() === idOrName.toLowerCase(),
    );
    return named ? clone(named) : null;
  }

  async findOwned(key: string, ownerId: string): Promise<CharacterRow | null> {
    const character = await this.getCharacter(key);
    return character?.ownerId === ownerId ? character : null;
  }

  async listOwnedIds(ownerId: string): Promise<string[]> {
    return [...this.characters.values()]
      .filter((row) => row.ownerId === ownerId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => row.id);
  }

  async countOwned(ownerId: string): Promise<number> {
    return [...this.characters.values()].filter((row) => row.ownerId === ownerId)
      .length;
  }

  async insertCharacter(row: CharacterRow): Promise<void> {
    await this.locked(() => {
      if (
        [...this.characters.values()].some(
          (existing) => existing.name.toLowerCase() === row.name.toLowerCase(),
        )
      )
        throw new ConflictError("That name or account already has a character");
      this.characters.set(row.id, clone(row));
    });
  }

  async updateCharacter(
    id: string,
    patch: Partial<CharacterRow>,
  ): Promise<void> {
    await this.locked(() => {
      const current = this.characters.get(id);
      if (!current) return;
      this.characters.set(id, { ...current, ...patch });
    });
  }

  async deleteCharacter(id: string): Promise<void> {
    await this.locked(() => {
      this.characters.delete(id);
      this.memories = this.memories.filter((row) => row.characterId !== id);
      for (const key of [...this.relationships.keys()]) {
        if (key.startsWith(`${id}::`) || key.endsWith(`::${id}`))
          this.relationships.delete(key);
      }
      this.jobs = new Map(
        [...this.jobs.entries()].filter(([, job]) => job.characterId !== id),
      );
      this.messages = this.messages.filter((row) => row.characterId !== id);
      for (const [conversationId, members] of this.conversationMembers) {
        members.delete(id);
        const conversation = this.conversations.get(conversationId);
        if (
          conversation &&
          (conversation.characterAId === id || conversation.characterBId === id)
        )
          this.conversations.delete(conversationId);
      }
    });
  }

  async listMemories(): Promise<MemoryRow[]> {
    return this.memories.filter((row) => row.active).map(clone);
  }

  async addMemory(row: MemoryRow): Promise<void> {
    await this.locked(() => {
      this.memories.unshift(clone(row));
    });
  }

  async replaceMemories(characterId: string, rows: MemoryRow[]): Promise<void> {
    await this.locked(() => {
      this.memories = this.memories.filter(
        (row) => row.characterId !== characterId,
      );
      this.memories.unshift(...rows.map(clone));
    });
  }

  async listRelationships(): Promise<RelationshipRow[]> {
    return [...this.relationships.values()].map(clone);
  }

  async upsertRelationship(row: RelationshipRow): Promise<void> {
    await this.locked(() => {
      this.relationships.set(`${row.characterId}::${row.otherCharacterId}`, clone(row));
    });
  }

  async addEvent(row: EventRow): Promise<void> {
    await this.locked(() => {
      this.events.unshift(clone(row));
    });
  }

  async listEvents(input: {
    limit: number;
    viewerCharacterIds: string[];
    isAdmin: boolean;
  }): Promise<EventRow[]> {
    const owned = new Set(input.viewerCharacterIds);
    return this.events
      .filter((event) => {
        if (event.hidden && !input.isAdmin) return false;
        if (event.visibility === "private" && !input.isAdmin) {
          return (
            (event.characterId && owned.has(event.characterId)) ||
            (event.targetCharacterId && owned.has(event.targetCharacterId))
          );
        }
        return true;
      })
      .slice(0, input.limit)
      .map(clone);
  }

  async hideEvent(id: string): Promise<boolean> {
    return this.locked(() => {
      const event = this.events.find((row) => row.id === id);
      if (!event) return false;
      event.hidden = true;
      return true;
    });
  }

  async pruneEvents(
    now: number,
    keep: number,
    maxAgeMs: number,
  ): Promise<number> {
    return this.locked(() => {
      const before = this.events.length;
      this.events = this.events
        .filter((event) => now - event.createdAt <= maxAgeMs)
        .slice(0, keep);
      return before - this.events.length;
    });
  }

  async enqueueJob(
    row: Omit<QueueJob, "status" | "attemptCount"> & {
      status?: string;
      attemptCount?: number;
    },
  ): Promise<string | null> {
    return this.locked(() => {
      if (row.dedupeKey) {
        const duplicate = [...this.jobs.values()].find(
          (job) =>
            job.characterId === row.characterId &&
            job.dedupeKey === row.dedupeKey &&
            job.status === "pending",
        );
        if (duplicate) return null;
      }
      this.jobs.set(row.id, {
        ...clone(row),
        status: row.status ?? "pending",
        attemptCount: row.attemptCount ?? 0,
      });
      return row.id;
    });
  }

  async claimNextJob(now: number, leaseMs: number): Promise<QueueJob | null> {
    return this.locked(() => {
      const candidate = [...this.jobs.values()]
        .filter(
          (job) =>
            job.status === "pending" &&
            job.notBefore <= now &&
            job.expiresAt > now,
        )
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
      if (!candidate) return null;
      candidate.status = "processing";
      candidate.notBefore = now + leaseMs;
      candidate.attemptCount += 1;
      return clone(candidate);
    });
  }

  async completeJob(id: string): Promise<void> {
    await this.locked(() => {
      const job = this.jobs.get(id);
      if (job) job.status = "completed";
    });
  }

  async failJob(
    id: string,
    error: string,
    now: number,
    maxAttempts: number,
  ): Promise<void> {
    await this.locked(() => {
      const job = this.jobs.get(id);
      if (!job) return;
      if (job.attemptCount >= maxAttempts) {
        job.status = "failed";
      } else {
        job.status = "pending";
        job.notBefore = now + 15_000;
      }
      job.expiresAt = Math.max(job.expiresAt, now + 30 * 60_000);
    });
    void error;
  }

  async recoverStaleJobs(now: number): Promise<number> {
    return this.locked(() => {
      let recovered = 0;
      for (const job of this.jobs.values()) {
        if (job.status === "processing" && job.notBefore <= now) {
          job.status = "pending";
          recovered += 1;
        }
      }
      return recovered;
    });
  }

  async expireJobs(now: number): Promise<number> {
    return this.locked(() => {
      let expired = 0;
      for (const job of this.jobs.values()) {
        if (job.status === "pending" && job.expiresAt <= now) {
          job.status = "expired";
          expired += 1;
        }
      }
      return expired;
    });
  }

  async countDueJobs(now: number): Promise<number> {
    return [...this.jobs.values()].filter(
      (job) =>
        job.status === "pending" && job.notBefore <= now && job.expiresAt > now,
    ).length;
  }

  async dueCharacterIds(now: number): Promise<string[]> {
    return [...this.characters.values()]
      .filter(
        (row) => !row.paused && !row.muted && row.nextDecisionAt <= now,
      )
      .map((row) => row.id);
  }

  async queueDepth(): Promise<number> {
    return [...this.jobs.values()].filter((job) => job.status === "pending")
      .length;
  }

  async getJob(id: string): Promise<QueueJob | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async insertConversation(
    row: ConversationRow,
    memberIds: string[],
  ): Promise<void> {
    await this.locked(() => {
      this.conversations.set(row.id, clone(row));
      this.conversationMembers.set(row.id, new Set(memberIds));
    });
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
    await this.locked(() => this.messages.push(clone(input)));
  }

  async listConversationMembers(conversationId: string): Promise<string[]> {
    return [...(this.conversationMembers.get(conversationId) ?? [])];
  }

  async listArtifacts(): Promise<WorldArtifact[]> {
    return this.artifacts.map(clone);
  }

  async addArtifact(row: WorldArtifact): Promise<void> {
    await this.locked(() => this.artifacts.push(clone(row)));
  }

  async addReport(row: ReportRow): Promise<void> {
    await this.locked(() => this.reports.unshift(clone(row)));
  }

  async listReports(): Promise<ReportRow[]> {
    return this.reports.map(clone);
  }

  async resolveReport(
    id: string,
    resolverId: string,
    now: number,
  ): Promise<void> {
    await this.locked(() => {
      const report = this.reports.find((row) => row.id === id);
      if (!report) return;
      report.status = "resolved";
      report.resolverId = resolverId;
      report.resolvedAt = now;
    });
  }

  async hitRateLimit(
    key: string,
    windowMs: number,
    max: number,
    now: number,
  ): Promise<boolean> {
    return this.locked(() => {
      const current = this.rateLimits.get(key);
      if (!current || now - current.windowStart >= windowMs) {
        this.rateLimits.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (current.count >= max) return false;
      current.count += 1;
      return true;
    });
  }

  async addAlert(row: AlertRow): Promise<void> {
    await this.locked(() => this.alerts.unshift(clone(row)));
  }

  async listAlerts(limit: number): Promise<AlertRow[]> {
    return this.alerts.slice(0, limit).map(clone);
  }

  async listCosts(limit: number): Promise<CostRow[]> {
    return this.costs.slice(0, limit).map(clone);
  }
}
