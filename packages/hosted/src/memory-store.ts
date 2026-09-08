import type { WorldArtifact } from "../../shared/src/index.js";
import { ConflictError } from "./errors.js";
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
  readonly supportsFinancialTransactions = true;
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
  wallets = new Map<string, Wallet>();
  payments = new Map<string, Payment>();
  quotas = new Map<string, number>();
  dailySpend = new Map<
    string,
    { reserved: number; settled: number; limit: number }
  >();
  spendPauses = new Map<string, SpendPause>();
  private paymentAudits: AuditEntry[] = [];
  toolManifests = new Map<string, ToolManifest>();
  currentManifest = new Map<string, number>();
  provisioning = new Map<string, WalletProvisioningOperation>();
  funding = new Map<string, FundingAttempt>();
  rateLimits = new Map<string, { windowStart: number; count: number }>();
  presence = new Map<string, number>();

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
      this.wallets.clear();
      this.payments.clear();
      this.quotas.clear();
      this.dailySpend.clear();
      this.spendPauses.clear();
      this.paymentAudits = [];
      this.toolManifests.clear();
      this.currentManifest.clear();
      this.provisioning.clear();
      this.funding.clear();
      this.presence.clear();
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
    return [...this.characters.values()].filter(
      (row) => row.ownerId === ownerId,
    ).length;
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
      this.relationships.set(
        `${row.characterId}::${row.otherCharacterId}`,
        clone(row),
      );
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
        .sort(
          (a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
        )[0];
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
      .filter((row) => !row.paused && !row.muted && row.nextDecisionAt <= now)
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

  async touchPresence(key: string, now: number): Promise<void> {
    await this.locked(() => {
      this.presence.set(key, now);
    });
  }

  async countPresence(since: number): Promise<number> {
    return [...this.presence.values()].filter((seenAt) => seenAt >= since)
      .length;
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

  async getWallet(ownerId: string): Promise<Wallet | null> {
    return clone(this.wallets.get(ownerId) ?? null);
  }
  async saveWallet(wallet: Wallet): Promise<void> {
    await this.locked(() => this.wallets.set(wallet.ownerId, clone(wallet)));
  }
  async getWalletProvisioning(ownerId: string, idempotencyKey: string) {
    return clone(this.provisioning.get(`${ownerId}:${idempotencyKey}`) ?? null);
  }
  async claimWalletProvisioning(
    ownerId: string,
    idempotencyKey: string,
    now: number,
    staleAfterMs: number,
  ) {
    return this.locked(() => {
      const key = `${ownerId}:${idempotencyKey}`;
      const current = this.provisioning.get(key);
      if (current?.status === "completed")
        return { operation: clone(current), claimed: false };
      if (
        current?.status === "in_progress" &&
        now - current.updatedAt < staleAfterMs
      )
        return { operation: clone(current), claimed: false };
      const operation: WalletProvisioningOperation = {
        ownerId,
        idempotencyKey,
        status: "in_progress",
        providerIdempotencyKey:
          current?.providerIdempotencyKey ?? `wallet:${ownerId}`,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      this.provisioning.set(key, clone(operation));
      return { operation: clone(operation), claimed: true };
    });
  }
  async completeWalletProvisioning(
    operation: WalletProvisioningOperation,
    now: number,
  ) {
    await this.locked(() =>
      this.provisioning.set(
        `${operation.ownerId}:${operation.idempotencyKey}`,
        { ...clone(operation), status: "completed", updatedAt: now },
      ),
    );
  }
  async failWalletProvisioning(
    operation: WalletProvisioningOperation,
    error: string,
    now: number,
  ) {
    await this.locked(() =>
      this.provisioning.set(
        `${operation.ownerId}:${operation.idempotencyKey}`,
        { ...clone(operation), status: "failed", error, updatedAt: now },
      ),
    );
  }
  async listWallets(): Promise<Wallet[]> {
    return [...this.wallets.values()].map(clone);
  }
  async getPayment(operationId: string): Promise<Payment | null> {
    return clone(this.payments.get(operationId) ?? null);
  }
  async savePayment(payment: Payment): Promise<void> {
    await this.locked(() => {
      const current = this.payments.get(payment.operationId);
      if (current && payment.version <= current.version)
        throw new Error("stale payment transition");
      this.payments.set(payment.operationId, clone(payment));
    });
  }
  async reserveAndCreatePayment(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }): Promise<Payment | null> {
    return this.transaction(() => this.reserveAndCreatePaymentUnsafe(input));
  }
  private reserveAndCreatePaymentUnsafe(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }): Promise<Payment | null> {
    const existing = this.payments.get(input.payment.operationId);
    if (existing) return Promise.resolve(clone(existing));
    const key = `${input.ownerId}:${input.day}`;
    const current = this.dailySpend.get(key) ?? {
      reserved: 0,
      settled: 0,
      limit: input.limit,
    };
    current.limit = input.limit;
    if (current.reserved + current.settled + input.amount > input.limit)
      return Promise.resolve(null);
    current.reserved += input.amount;
    this.dailySpend.set(key, current);
    this.payments.set(input.payment.operationId, clone(input.payment));
    return Promise.resolve(clone(input.payment));
  }
  async reservePaymentIfUnpaused(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
    generations: PaymentGenerations;
  }): Promise<Payment | null> {
    return this.transaction(async () => {
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
      return this.reserveAndCreatePaymentUnsafe(input);
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
  ): Promise<PaymentTransitionResult> {
    return this.transaction(async () => {
      const current = this.payments.get(input.operationId);
      if (!current) throw new Error("payment not found");
      if (current.state === state)
        return { ...clone(current), transitioned: false };
      if (
        current.state !== input.expectedState ||
        current.version !== input.expectedVersion
      )
        throw new Error("stale payment transition");
      const next = {
        ...clone(input.payment),
        state,
        reservedMicros: 0,
        version: current.version + 1,
        updatedAt: input.now,
      };
      if (state === "settled") next.actualMicros = input.actualMicros;
      if (state === "cancelled")
        await this.releaseDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
          input.now,
        );
      else
        await this.settleDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
          input.actualMicros ?? 0,
          input.now,
        );
      this.payments.set(next.operationId, clone(next));
      return { ...clone(next), transitioned: true };
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
      const current = this.payments.get(operationId);
      if (!current || current.ownerId !== ownerId)
        throw new Error("owner mismatch");
      if (current.state === outcome)
        return { ...clone(current), transitioned: false };
      if (current.state !== "unknown")
        throw new Error("stale payment transition");
      const next = {
        ...clone(current),
        state: outcome,
        providerPhase:
          outcome === "authorized"
            ? ("succeeded" as const)
            : ("failed" as const),
        providerReference: authorizationReference ?? current.providerReference,
        authorizationClaimToken: undefined,
        updatedAt: now,
        version: current.version + 1,
      };
      this.payments.set(operationId, next);
      return { ...clone(next), transitioned: true };
    });
  }
  async claimPaymentAuthorization(
    operationId: string,
    ownerId: string,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.locked(() => {
      const payment = this.payments.get(operationId);
      if (!payment || payment.ownerId !== ownerId)
        throw new Error("owner mismatch");
      if (payment.state === "authorized")
        return { payment: clone(payment), claimed: false };
      if (payment.authorizationClaimToken)
        return { payment: clone(payment), claimed: false };
      const pauses = [
        this.spendPauses.get("global"),
        this.spendPauses.get(`user:${ownerId}`),
        this.spendPauses.get(`tool:${payment.toolId}`),
      ].map((pause) => pause ?? { paused: false, generation: 0 });
      if (
        pauses.some(
          (pause, index) =>
            pause.paused ||
            pause.generation !==
              [generations.global, generations.user, generations.tool][index],
        )
      )
        throw new Error(
          pauses.some((pause) => pause.paused)
            ? "payments paused before authorization claim"
            : "pause changed before authorization claim",
        );
      const next = {
        ...payment,
        authorizationClaimToken: crypto.randomUUID(),
        authorizationClaimedAt: now,
        pauseGenerations: generations,
        pauseGeneration: Math.max(
          generations.global,
          generations.user,
          generations.tool,
        ),
        version: payment.version + 1,
      };
      this.payments.set(operationId, clone(next));
      return { payment: clone(next), claimed: true };
    });
  }
  async getFundingAttempt(ownerId: string, idempotencyKey: string) {
    return clone(this.funding.get(`${ownerId}:${idempotencyKey}`) ?? null);
  }
  async claimFundingAttempt(
    attempt: FundingAttempt,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.locked(() => {
      const key = `${attempt.ownerId}:${attempt.idempotencyKey}`;
      const current = this.funding.get(key);
      if (
        current &&
        (current.amountMicros !== attempt.amountMicros ||
          current.walletAddress !== attempt.walletAddress ||
          current.consentVersion !== attempt.consentVersion)
      )
        throw new Error("funding idempotency conflict");
      if (current?.status === "completed" || current?.status === "in_progress")
        return { attempt: clone(current), claimed: false };
      if (current?.status === "failed")
        return { attempt: clone(current), claimed: false };
      const pauses = [
        this.spendPauses.get("global"),
        this.spendPauses.get(`user:${attempt.ownerId}`),
      ].map((pause) => pause ?? { paused: false, generation: 0 });
      if (
        pauses.some(
          (pause, index) =>
            pause.paused ||
            pause.generation !== [generations.global, generations.user][index],
        )
      )
        throw new Error("pause changed before funding claim");
      const next = {
        ...attempt,
        pauseGenerations: generations,
        status: "in_progress" as const,
        providerPhase: "in_flight" as const,
        updatedAt: now,
      };
      this.funding.set(key, clone(next));
      return { attempt: clone(next), claimed: true };
    });
  }
  async completeFundingAttempt(attempt: FundingAttempt, now: number) {
    await this.locked(() =>
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...clone(attempt),
        status: "completed",
        providerPhase: "succeeded",
        updatedAt: now,
      }),
    );
  }
  async markFundingUnknown(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.locked(() =>
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...clone(attempt),
        status: "unknown",
        providerPhase: "unknown",
        error,
        updatedAt: now,
      }),
    );
  }
  async failFundingAttempt(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.locked(() =>
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...clone(attempt),
        status: "failed",
        error,
        updatedAt: now,
      }),
    );
  }
  async listPayments(ownerId: string, day: string): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter(
        (payment) =>
          payment.ownerId === ownerId &&
          new Date(payment.createdAt).toISOString().slice(0, 10) === day,
      )
      .map(clone);
  }
  async getQuota(ownerId: string): Promise<number | null> {
    return this.quotas.get(ownerId) ?? null;
  }
  async setQuota(ownerId: string, dailyLimitMicros: number): Promise<void> {
    await this.locked(() => this.quotas.set(ownerId, dailyLimitMicros));
  }
  async getPause(scope: string): Promise<SpendPause> {
    return clone(
      this.spendPauses.get(scope) ?? {
        scope,
        paused: false,
        generation: 0,
        updatedAt: 0,
      },
    );
  }
  async setPause(
    scope: string,
    paused: boolean,
    now: number,
  ): Promise<SpendPause> {
    return this.locked(() => {
      const next = {
        scope,
        paused,
        generation: (this.spendPauses.get(scope)?.generation ?? 0) + 1,
        updatedAt: now,
      };
      this.spendPauses.set(scope, next);
      return clone(next);
    });
  }
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.locked(() => this.paymentAudits.push(clone(entry)));
  }
  async listAudit(ownerId?: string): Promise<AuditEntry[]> {
    return this.paymentAudits
      .filter((entry) => !ownerId || entry.ownerId === ownerId)
      .map(clone);
  }
  async listToolManifests(): Promise<ToolManifest[]> {
    const latest = new Map<string, ToolManifest>();
    for (const manifest of this.toolManifests.values()) {
      const current = this.currentManifest.get(manifest.id);
      if (
        (current === undefined &&
          (!latest.has(manifest.id) ||
            manifest.version > latest.get(manifest.id)!.version)) ||
        current === manifest.version
      )
        latest.set(manifest.id, manifest);
    }
    return [...latest.values()].map(clone);
  }
  async reserveDailySpend(
    ownerId: string,
    day: string,
    amount: number,
    limit: number,
    now: number,
  ): Promise<boolean> {
    return this.locked(() => {
      const key = `${ownerId}:${day}`;
      const current = this.dailySpend.get(key) ?? {
        reserved: 0,
        settled: 0,
        limit,
      };
      current.limit = limit;
      if (current.reserved + current.settled + amount > limit) return false;
      current.reserved += amount;
      this.dailySpend.set(key, current);
      void now;
      return true;
    });
  }
  async releaseDailySpend(
    ownerId: string,
    day: string,
    amount: number,
    _now: number,
  ): Promise<void> {
    await this.locked(() => {
      const v = this.dailySpend.get(`${ownerId}:${day}`);
      if (!v || v.reserved < amount)
        throw new Error("daily spend reservation invariant violated");
      v.reserved -= amount;
    });
  }
  async settleDailySpend(
    ownerId: string,
    day: string,
    reserved: number,
    settled: number,
    _now: number,
  ): Promise<void> {
    await this.locked(() => {
      const v = this.dailySpend.get(`${ownerId}:${day}`);
      if (
        !v ||
        v.reserved < reserved ||
        v.reserved - reserved + v.settled + settled > v.limit
      )
        throw new Error("daily spend settlement invariant violated");
      v.reserved -= reserved;
      v.settled += settled;
    });
  }

  async saveToolManifest(manifest: ToolManifest): Promise<void> {
    await this.locked(() => {
      const key = `${manifest.id}:${manifest.version}`;
      const current = this.toolManifests.get(key);
      if (current && JSON.stringify(current) !== JSON.stringify(manifest))
        throw new Error("tool manifest version is immutable");
      this.toolManifests.set(key, clone(manifest));
    });
  }
  async activateToolManifest(
    id: string,
    version: number,
    _now: number,
  ): Promise<void> {
    const manifest = this.toolManifests.get(`${id}:${version}`);
    if (!manifest || !manifest.reviewed || !manifest.active)
      throw new Error("only reviewed active manifests can be activated");
    this.currentManifest.set(id, version);
  }
}
