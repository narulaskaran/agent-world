import { createHash } from "node:crypto";

export const DEFAULT_DAILY_LIMIT_MICROS = 200_000;
export const DEFAULT_MAX_FUNDING_MICROS = 1_000_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SUPPORTED_CONSENT_VERSIONS = ["wallet-spend-v1"] as const;
export type ConsentVersion = (typeof SUPPORTED_CONSENT_VERSIONS)[number];

export type Wallet = {
  ownerId: string;
  providerUserId: string;
  providerWalletId: string;
  address: string;
  chain: "tempo";
  asset: "USDC";
  consentVersion?: ConsentVersion;
  consentAt?: number;
  consentActor?: string;
  delegated: boolean;
  revoked: boolean;
  createdAt: number;
  updatedAt: number;
};

export type WalletProvisioningOperation = {
  ownerId: string;
  idempotencyKey: string;
  status: "in_progress" | "completed" | "failed";
  providerIdempotencyKey: string;
  providerUserId?: string;
  providerWalletId?: string;
  address?: string;
  chain?: "tempo";
  asset?: "USDC";
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type FundingAttempt = {
  ownerId: string;
  idempotencyKey: string;
  providerIdempotencyKey: string;
  amountMicros: number;
  walletAddress: string;
  consentVersion: ConsentVersion;
  policySnapshot: ToolManifest | Record<string, unknown> | null;
  pauseGenerations: PaymentGenerations;
  status: "in_progress" | "completed" | "failed" | "unknown";
  providerPhase?:
    "not_started" | "in_flight" | "succeeded" | "failed" | "unknown";
  session?: OnrampSession;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProviderPhase =
  "not_started" | "in_flight" | "succeeded" | "failed" | "unknown";

export type PaymentState =
  | "reserved"
  | "challenged"
  | "authorized"
  | "submitted"
  | "unknown"
  | "settled"
  | "rejected"
  | "expired"
  | "cancelled"
  | "reconciled_failed";

export type ToolManifest = {
  id: string;
  version: number;
  active: boolean;
  reviewed: boolean;
  maxTotalMicros: number;
  fixedTotalMicros?: number;
  origin: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  route: string;
  recipient: string;
  chain: "tempo";
  asset: "USDC";
  mppMethod: "tempo";
  intent: "charge";
  inputSchema: Record<string, unknown>;
};

export type Payment = {
  operationId: string;
  ownerId: string;
  toolId: string;
  toolVersion: number;
  maxTotalMicros: number;
  reservedMicros: number;
  actualMicros?: number;
  state: PaymentState;
  createdAt: number;
  updatedAt: number;
  providerReference?: string;
  receiptReference?: string;
  transactionReference?: string;
  receiptHash?: string;
  receiptEvidence?: VerifiedReceipt;
  requestDigest?: string;
  authorizationClaimToken?: string;
  authorizationClaimedAt?: number;
  authorizationProviderIdempotencyKey?: string;
  providerPhase?: ProviderPhase;
  consentVersion?: ConsentVersion;
  payerAddress?: string;
  version: number;
  manifestSnapshot: ToolManifest;
  pauseGeneration: number;
  pauseGenerations: PaymentGenerations;
};

export type SpendPause = {
  scope: string;
  paused: boolean;
  generation: number;
  updatedAt: number;
};
export type PaymentGenerations = { global: number; user: number; tool: number };
export type PaymentTransitionResult = Payment & { transitioned: boolean };
export type PaymentTransition = {
  payment: Payment;
  operationId: string;
  expectedState: PaymentState;
  expectedVersion: number;
  kind: "release" | "settle";
  actualMicros?: number;
  receiptEvidence?: VerifiedReceipt;
  now: number;
};
export type AuditEntry = {
  id: string;
  operationId?: string;
  ownerId: string;
  actor: string;
  event: string;
  state?: PaymentState;
  providerPhase?: ProviderPhase;
  amountMicros?: number;
  receiptReference?: string;
  evidenceHash?: string;
  manifestSnapshot?: ToolManifest | Record<string, unknown>;
  consentVersion?: ConsentVersion;
  pauseGenerations?: Record<string, number>;
  requestDigest?: string;
  transitionVersion?: number;
  providerReference?: string;
  transactionReference?: string;
  receiptEvidence?: VerifiedReceipt;
  createdAt: number;
};

export type VerifiedReceipt = {
  reference: string;
  transactionReference?: string;
  payerAddress?: string;
  amountMicros: number;
  currency: "USDC";
  network: "tempo";
  merchant: string;
  status: "settled" | "failed";
};

export type SignedPaymentRequest = {
  operationId: string;
  ownerId: string;
  walletAddress: string;
  tool: ToolManifest;
  amountMicros: number;
  requestDigest: string;
};

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code = "PAYMENT_ERROR",
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export const assertIdempotencyKey = (key: string): string => {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new PaymentError(
      "invalid idempotency key",
      "INVALID_IDEMPOTENCY_KEY",
    );
  return key;
};

export interface WalletPaymentStore {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  getWallet(ownerId: string): Promise<Wallet | null>;
  getWalletProvisioning(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<WalletProvisioningOperation | null>;
  saveWallet(wallet: Wallet): Promise<void>;
  claimWalletProvisioning(
    ownerId: string,
    idempotencyKey: string,
    now: number,
    staleAfterMs: number,
  ): Promise<{ operation: WalletProvisioningOperation; claimed: boolean }>;
  completeWalletProvisioning(
    operation: WalletProvisioningOperation,
    now: number,
  ): Promise<void>;
  failWalletProvisioning(
    operation: WalletProvisioningOperation,
    error: string,
    now: number,
  ): Promise<void>;
  listWallets(): Promise<Wallet[]>;
  getPayment(operationId: string): Promise<Payment | null>;
  savePayment(payment: Payment): Promise<void>;
  reserveAndCreatePayment(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }): Promise<Payment | null>;
  reservePaymentIfUnpaused(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
    generations: PaymentGenerations;
  }): Promise<Payment | null>;
  transitionAndRelease(
    input: PaymentTransition,
  ): Promise<PaymentTransitionResult>;
  transitionAndSettle(
    input: PaymentTransition,
  ): Promise<PaymentTransitionResult>;
  reconcilePaymentAuthorization(
    operationId: string,
    ownerId: string,
    outcome: "authorized" | "reconciled_failed",
    now: number,
    authorizationReference?: string,
  ): Promise<PaymentTransitionResult>;
  claimPaymentAuthorization(
    operationId: string,
    ownerId: string,
    now: number,
    generations: PaymentGenerations,
  ): Promise<{ payment: Payment; claimed: boolean }>;
  getFundingAttempt(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<FundingAttempt | null>;
  claimFundingAttempt(
    attempt: FundingAttempt,
    now: number,
    generations: PaymentGenerations,
  ): Promise<{ attempt: FundingAttempt; claimed: boolean }>;
  completeFundingAttempt(attempt: FundingAttempt, now: number): Promise<void>;
  failFundingAttempt(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ): Promise<void>;
  markFundingUnknown(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ): Promise<void>;
  listPayments(ownerId: string, day: string): Promise<Payment[]>;
  getQuota(ownerId: string): Promise<number | null>;
  setQuota(
    ownerId: string,
    dailyLimitMicros: number,
    now: number,
  ): Promise<void>;
  getPause(scope: string): Promise<SpendPause>;
  setPause(scope: string, paused: boolean, now: number): Promise<SpendPause>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(ownerId?: string): Promise<AuditEntry[]>;
  listToolManifests(): Promise<ToolManifest[]>;
  saveToolManifest(manifest: ToolManifest, now?: number): Promise<void>;
  activateToolManifest(id: string, version: number, now: number): Promise<void>;
  reserveDailySpend?(
    ownerId: string,
    day: string,
    amount: number,
    limit: number,
    now: number,
  ): Promise<boolean>;
  releaseDailySpend?(
    ownerId: string,
    day: string,
    amount: number,
    now: number,
  ): Promise<void>;
  settleDailySpend?(
    ownerId: string,
    day: string,
    reserved: number,
    settled: number,
    now: number,
  ): Promise<void>;
  readonly supportsFinancialTransactions: boolean;
}

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryWalletStore implements WalletPaymentStore {
  readonly supportsFinancialTransactions = true;
  private wallets = new Map<string, Wallet>();
  private payments = new Map<string, Payment>();
  private quotas = new Map<string, number>();
  private pauses = new Map<string, SpendPause>();
  private audits: AuditEntry[] = [];
  private manifests = new Map<string, ToolManifest>();
  private currentManifest = new Map<string, number>();
  private provisioning = new Map<string, WalletProvisioningOperation>();
  private funding = new Map<string, FundingAttempt>();
  private dailySpend = new Map<
    string,
    { reserved: number; settled: number; limit: number }
  >();
  private lock = Promise.resolve();
  private depth = 0;

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth) return fn();
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
      release();
    }
  }
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.depth) return Promise.resolve(fn());
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    return prior.then(fn).finally(release);
  }
  async getWallet(ownerId: string) {
    return copy(this.wallets.get(ownerId) ?? null);
  }
  async saveWallet(wallet: Wallet) {
    const current = this.wallets.get(wallet.ownerId);
    if (current && current.providerWalletId !== wallet.providerWalletId)
      throw new PaymentError("wallet already exists");
    this.wallets.set(wallet.ownerId, copy(wallet));
  }
  async listWallets() {
    return copy([...this.wallets.values()]);
  }
  async getWalletProvisioning(ownerId: string, idempotencyKey: string) {
    return copy(this.provisioning.get(`${ownerId}:${idempotencyKey}`) ?? null);
  }
  async claimWalletProvisioning(
    ownerId: string,
    idempotencyKey: string,
    now: number,
    staleAfterMs: number,
  ) {
    return this.transaction(async () => {
      const key = `${ownerId}:${idempotencyKey}`;
      const current = this.provisioning.get(key);
      if (current && current.status === "completed")
        return { operation: copy(current), claimed: false };
      // An external create may have succeeded while this process was down.
      // Never reclaim an ambiguous in-flight request.
      if (current && current.status === "in_progress")
        return { operation: copy(current), claimed: false };
      const operation: WalletProvisioningOperation = {
        ownerId,
        idempotencyKey,
        status: "in_progress",
        providerIdempotencyKey: `wallet:${ownerId}`,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      this.provisioning.set(key, operation);
      return { operation: copy(operation), claimed: true };
    });
  }
  async completeWalletProvisioning(
    operation: WalletProvisioningOperation,
    now: number,
  ) {
    await this.transaction(async () =>
      this.provisioning.set(
        `${operation.ownerId}:${operation.idempotencyKey}`,
        { ...copy(operation), status: "completed", updatedAt: now },
      ),
    );
  }
  async failWalletProvisioning(
    operation: WalletProvisioningOperation,
    error: string,
    now: number,
  ) {
    await this.transaction(async () =>
      this.provisioning.set(
        `${operation.ownerId}:${operation.idempotencyKey}`,
        { ...copy(operation), status: "failed", error, updatedAt: now },
      ),
    );
  }
  async getPayment(id: string) {
    return copy(this.payments.get(id) ?? null);
  }
  async savePayment(payment: Payment) {
    const current = this.payments.get(payment.operationId);
    if (current && payment.version <= current.version)
      throw new PaymentError("stale payment transition");
    this.payments.set(payment.operationId, copy(payment));
  }
  async reserveAndCreatePayment(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }) {
    return this.transaction(() => this.reserveAndCreatePaymentUnsafe(input));
  }
  private reserveAndCreatePaymentUnsafe(input: {
    ownerId: string;
    day: string;
    amount: number;
    limit: number;
    now: number;
    payment: Payment;
  }) {
    const existing = this.payments.get(input.payment.operationId);
    if (existing) return Promise.resolve(copy(existing));
    const key = `${input.ownerId}:${input.day}`;
    const currentSpend = this.dailySpend.get(key) ?? {
      reserved: 0,
      settled: 0,
      limit: input.limit,
    };
    currentSpend.limit = input.limit;
    if (
      currentSpend.reserved + currentSpend.settled + input.amount >
      input.limit
    )
      return Promise.resolve(null);
    currentSpend.reserved += input.amount;
    this.dailySpend.set(key, currentSpend);
    this.payments.set(input.payment.operationId, copy(input.payment));
    return Promise.resolve(copy(input.payment));
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
      const scopes = [
        "global",
        `user:${input.ownerId}`,
        `tool:${input.payment.toolId}`,
      ];
      const current = await Promise.all(scopes.map((s) => this.getPause(s)));
      if (
        current.some(
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
    return this.transitionFinancially(input, "release");
  }
  async transitionAndSettle(
    input: PaymentTransition,
  ): Promise<PaymentTransitionResult> {
    return this.transitionFinancially(input, "settle");
  }
  private async transitionFinancially(
    input: PaymentTransition,
    kind: "release" | "settle",
  ) {
    return this.transaction(async () => {
      const current = this.payments.get(input.operationId);
      if (!current) throw new PaymentError("payment not found");
      if (current.state === (kind === "release" ? "cancelled" : "settled"))
        return { ...copy(current), transitioned: false };
      if (
        current.state !== input.expectedState ||
        current.version !== input.expectedVersion
      )
        throw new PaymentError("stale payment transition");
      const next = copy(input.payment);
      next.version = current.version + 1;
      next.updatedAt = input.now;
      if (kind === "release") next.state = "cancelled";
      else {
        next.state = "settled";
        next.actualMicros = input.actualMicros;
      }
      if (kind === "release")
        await this.releaseDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
        );
      else
        await this.settleDailySpend(
          next.ownerId,
          new Date(next.createdAt).toISOString().slice(0, 10),
          input.payment.reservedMicros,
          input.actualMicros ?? 0,
        );
      this.payments.set(next.operationId, copy(next));
      return { ...copy(next), transitioned: true };
    });
  }
  async reserveDailySpend(
    ownerId: string,
    day: string,
    amount: number,
    limit: number,
  ) {
    return this.locked(() => {
      const key = `${ownerId}:${day}`;
      const value = this.dailySpend.get(key) ?? {
        reserved: 0,
        settled: 0,
        limit,
      };
      value.limit = limit;
      if (value.reserved + value.settled + amount > limit) return false;
      value.reserved += amount;
      this.dailySpend.set(key, value);
      return true;
    });
  }
  async releaseDailySpend(ownerId: string, day: string, amount: number) {
    await this.locked(() => {
      const value = this.dailySpend.get(`${ownerId}:${day}`);
      if (!value || value.reserved < amount)
        throw new PaymentError("daily spend reservation invariant violated");
      value.reserved -= amount;
    });
  }
  async settleDailySpend(
    ownerId: string,
    day: string,
    reserved: number,
    settled: number,
  ) {
    await this.locked(() => {
      const value = this.dailySpend.get(`${ownerId}:${day}`);
      if (
        !value ||
        value.reserved < reserved ||
        value.reserved - reserved + value.settled + settled > value.limit
      )
        throw new PaymentError("daily spend settlement invariant violated");
      value.reserved -= reserved;
      value.settled += settled;
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
        throw new PaymentError("owner mismatch");
      if (current.state === outcome)
        return { ...copy(current), transitioned: false };
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
        );
        next.reservedMicros = 0;
      }
      this.payments.set(operationId, copy(next));
      return { ...copy(next), transitioned: true };
    });
  }

  async claimPaymentAuthorization(
    operationId: string,
    ownerId: string,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.transaction(async () => {
      const payment = this.payments.get(operationId);
      if (!payment || payment.ownerId !== ownerId)
        throw new PaymentError("owner mismatch");
      if (payment.state === "authorized")
        return { payment: copy(payment), claimed: false };
      if (payment.authorizationClaimToken)
        return { payment: copy(payment), claimed: false };
      const pauses = await Promise.all([
        this.getPause("global"),
        this.getPause(`user:${ownerId}`),
        this.getPause(`tool:${payment.toolId}`),
      ]);
      if (
        pauses.some(
          (pause, index) =>
            pause.paused ||
            pause.generation !==
              [generations.global, generations.user, generations.tool][index],
        )
      )
        throw new PaymentError(
          pauses.some((pause) => pause.paused)
            ? "payments paused before authorization claim"
            : "pause changed before authorization claim",
        );
      const next = {
        ...payment,
        authorizationClaimToken: crypto.randomUUID(),
        authorizationProviderIdempotencyKey: `authorize:${payment.ownerId}:${payment.operationId}`,
        authorizationClaimedAt: now,
        providerPhase: "in_flight" as const,
        pauseGenerations: generations,
        pauseGeneration: Math.max(
          generations.global,
          generations.user,
          generations.tool,
        ),
        version: payment.version + 1,
      };
      this.payments.set(operationId, copy(next));
      return { payment: copy(next), claimed: true };
    });
  }
  async getFundingAttempt(ownerId: string, idempotencyKey: string) {
    return copy(this.funding.get(`${ownerId}:${idempotencyKey}`) ?? null);
  }
  async claimFundingAttempt(
    attempt: FundingAttempt,
    now: number,
    generations: PaymentGenerations,
  ) {
    return this.transaction(async () => {
      const key = `${attempt.ownerId}:${attempt.idempotencyKey}`;
      const current = this.funding.get(key);
      if (
        current &&
        (current.amountMicros !== attempt.amountMicros ||
          current.walletAddress !== attempt.walletAddress ||
          current.consentVersion !== attempt.consentVersion)
      )
        throw new PaymentError("funding idempotency conflict");
      if (current?.status === "completed" || current?.status === "in_progress")
        return { attempt: copy(current), claimed: false };
      if (current?.status === "failed")
        return { attempt: copy(current), claimed: false };
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
      const next = {
        ...attempt,
        pauseGenerations: generations,
        status: "in_progress" as const,
        providerPhase: "in_flight" as const,
        updatedAt: now,
      };
      this.funding.set(key, copy(next));
      return { attempt: copy(next), claimed: true };
    });
  }
  async completeFundingAttempt(attempt: FundingAttempt, now: number) {
    await this.transaction(async () => {
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...copy(attempt),
        status: "completed",
        providerPhase: "succeeded",
        updatedAt: now,
      });
    });
  }
  async failFundingAttempt(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.transaction(async () => {
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...copy(attempt),
        status: "failed",
        providerPhase: "failed",
        error,
        updatedAt: now,
      });
    });
  }
  async markFundingUnknown(
    attempt: FundingAttempt,
    error: string,
    now: number,
  ) {
    await this.transaction(async () => {
      this.funding.set(`${attempt.ownerId}:${attempt.idempotencyKey}`, {
        ...copy(attempt),
        status: "unknown",
        providerPhase: "unknown",
        error,
        updatedAt: now,
      });
    });
  }
  async listPayments(ownerId: string, day: string) {
    return copy(
      [...this.payments.values()].filter(
        (p) =>
          p.ownerId === ownerId &&
          new Date(p.createdAt).toISOString().slice(0, 10) === day,
      ),
    );
  }
  async getQuota(ownerId: string) {
    return this.quotas.get(ownerId) ?? null;
  }
  async setQuota(ownerId: string, value: number) {
    this.quotas.set(ownerId, value);
  }
  async getPause(scope: string) {
    return copy(
      this.pauses.get(scope) ?? {
        scope,
        paused: false,
        generation: 0,
        updatedAt: 0,
      },
    );
  }
  async setPause(scope: string, paused: boolean, now: number) {
    return this.transaction(async () => {
      const next = {
        scope,
        paused,
        generation: (this.pauses.get(scope)?.generation ?? 0) + 1,
        updatedAt: now,
      };
      this.pauses.set(scope, next);
      return copy(next);
    });
  }
  async appendAudit(entry: AuditEntry) {
    this.audits.push(copy(entry));
  }
  async listAudit(ownerId?: string) {
    return copy(
      this.audits.filter((entry) => !ownerId || entry.ownerId === ownerId),
    );
  }
  async listToolManifests() {
    const all = [...this.manifests.values()];
    const latest = new Map<string, ToolManifest>();
    for (const manifest of all) {
      const selectedVersion = this.currentManifest.get(manifest.id);
      if (
        (selectedVersion === undefined &&
          (!latest.has(manifest.id) ||
            manifest.version > latest.get(manifest.id)!.version)) ||
        selectedVersion === manifest.version
      )
        latest.set(manifest.id, manifest);
    }
    return copy([...latest.values()]);
  }
  async saveToolManifest(manifest: ToolManifest, _now?: number) {
    const key = `${manifest.id}:${manifest.version}`;
    const current = this.manifests.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(manifest))
      throw new PaymentError("tool manifest version is immutable");
    this.manifests.set(key, copy(manifest));
  }
  async activateToolManifest(id: string, version: number, _now: number) {
    const manifest = this.manifests.get(`${id}:${version}`);
    if (!manifest || !manifest.reviewed || !manifest.active)
      throw new PaymentError("only reviewed active manifests can be activated");
    this.currentManifest.set(id, version);
  }
}

export interface WalletProvider {
  create(
    ownerId: string,
    idempotencyKey?: string,
  ): Promise<
    Omit<
      Wallet,
      "ownerId" | "delegated" | "revoked" | "createdAt" | "updatedAt"
    >
  >;
}
export class MockWalletProvider implements WalletProvider {
  calls = 0;
  private readonly results = new Map<
    string,
    Awaited<ReturnType<WalletProvider["create"]>>
  >();
  async create(ownerId: string, idempotencyKey = `wallet:${ownerId}`) {
    const prior = this.results.get(idempotencyKey);
    if (prior) return prior;
    this.calls++;
    const result = {
      providerUserId: `mock-user-${ownerId}`,
      providerWalletId: `mock-wallet-${ownerId}`,
      address: `0x${ownerId
        .replace(/[^a-f0-9]/gi, "")
        .padEnd(40, "0")
        .slice(0, 40)}`,
      chain: "tempo" as const,
      asset: "USDC" as const,
    };
    this.results.set(idempotencyKey, result);
    return result;
  }
}
export class GatedWalletProvider implements WalletProvider {
  constructor(
    private readonly live: boolean,
    private readonly provider?: WalletProvider,
  ) {}
  async create(ownerId: string, _idempotencyKey?: string) {
    if (!this.live || !this.provider)
      throw new PaymentError(
        "live wallet provider is disabled or unconfigured",
      );
    return this.provider.create(ownerId, _idempotencyKey);
  }
}

export class WalletService {
  private inflight = new Map<string, Promise<Wallet>>();
  constructor(
    private readonly store: WalletPaymentStore,
    private readonly provider: WalletProvider,
    private readonly live: () => boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async provision(ownerId: string) {
    const existing = await this.store.getWallet(ownerId);
    if (existing) return existing;
    const pending = this.inflight.get(ownerId);
    if (pending) return pending;
    const operation = (async () => {
      if (this.store.supportsFinancialTransactions === false)
        throw new PaymentError(
          "durable financial transaction support is unavailable",
        );
      if (this.live() && this.provider instanceof MockWalletProvider)
        throw new PaymentError(
          "live wallet provisioning requires a configured provider",
        );
      const now = this.now();
      const claim = await this.store.claimWalletProvisioning(
        ownerId,
        `wallet:${ownerId}`,
        now,
        60_000,
      );
      if (!claim.claimed) {
        const deadline = this.now() + 1_000;
        for (;;) {
          const winner = await this.store.getWallet(ownerId);
          if (winner) return winner;
          const current = await this.store.getWalletProvisioning(
            ownerId,
            `wallet:${ownerId}`,
          );
          if (current?.status === "failed")
            throw new PaymentError(
              current.error ?? "wallet provisioning failed",
            );
          if (this.now() >= deadline)
            throw new PaymentError(
              "wallet provisioning requires reconciliation",
              "RECONCILIATION_REQUIRED",
            );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        const pauseSnapshot = await Promise.all([
          this.store.getPause("global"),
          this.store.getPause(`user:${ownerId}`),
        ]);
        if (pauseSnapshot.some((pause) => pause.paused))
          throw new PaymentError("wallet provisioning paused");
        const beforeProvider = await Promise.all([
          this.store.getPause("global"),
          this.store.getPause(`user:${ownerId}`),
        ]);
        if (
          beforeProvider.some(
            (pause, index) =>
              pause.paused ||
              pause.generation > pauseSnapshot[index]!.generation,
          )
        )
          throw new PaymentError("wallet provisioning pause changed");
        const created = await this.provider.create(
          ownerId,
          claim.operation.providerIdempotencyKey,
        );
        const wallet: Wallet = {
          ownerId,
          ...created,
          delegated: false,
          revoked: false,
          createdAt: now,
          updatedAt: now,
        };
        const completedOperation: WalletProvisioningOperation = {
          ...claim.operation,
          providerUserId: created.providerUserId,
          providerWalletId: created.providerWalletId,
          address: created.address,
          chain: created.chain,
          asset: created.asset,
        };
        await this.store.transaction(async () => {
          const winner = await this.store.getWallet(ownerId);
          if (!winner) {
            await this.store.saveWallet(wallet);
            await this.store.appendAudit({
              id: crypto.randomUUID(),
              ownerId,
              actor: ownerId,
              event: "wallet_provisioned",
              providerReference: created.providerWalletId,
              createdAt: now,
            });
          }
          await this.store.completeWalletProvisioning(
            completedOperation,
            this.now(),
          );
        });
        return (await this.store.getWallet(ownerId))!;
      } catch (error) {
        await this.store.failWalletProvisioning(
          claim.operation,
          String(error),
          this.now(),
        );
        throw error;
      }
    })();
    this.inflight.set(ownerId, operation);
    try {
      return await operation;
    } finally {
      this.inflight.delete(ownerId);
    }
  }
  async consent(
    ownerId: string,
    version: string,
    actor = ownerId,
    now = this.now(),
  ) {
    if (!(SUPPORTED_CONSENT_VERSIONS as readonly string[]).includes(version))
      throw new PaymentError("unsupported consent version");
    const wallet = await this.provision(ownerId);
    return this.store.transaction(async () => {
      const current = await this.store.getWallet(ownerId);
      if (!current || current.providerWalletId !== wallet.providerWalletId)
        throw new PaymentError("wallet changed during consent");
      const next: Wallet = {
        ...current,
        consentVersion: version as ConsentVersion,
        consentAt: now,
        consentActor: actor,
        delegated: true,
        revoked: false,
        updatedAt: now,
      };
      await this.store.saveWallet(next);
      await this.store.appendAudit({
        id: crypto.randomUUID(),
        ownerId,
        actor,
        event: "consent_granted",
        createdAt: now,
      });
      return next;
    });
  }
  async revoke(ownerId: string, actor = ownerId, now = this.now()) {
    const wallet = await this.store.getWallet(ownerId);
    if (!wallet) return null;
    const next = { ...wallet, delegated: false, revoked: true, updatedAt: now };
    await this.store.transaction(async () => {
      await this.store.saveWallet(next);
      await this.store.appendAudit({
        id: crypto.randomUUID(),
        ownerId,
        actor,
        event: "consent_revoked",
        createdAt: now,
      });
    });
    return next;
  }
  async delegate(ownerId: string) {
    const wallet = await this.store.getWallet(ownerId);
    if (!wallet?.consentVersion || !wallet.delegated)
      throw new PaymentError(
        wallet?.revoked ? "revoked" : "versioned consent required",
      );
    return wallet;
  }
}

export type ToolManifestInput = Partial<ToolManifest> &
  Pick<ToolManifest, "id" | "version" | "active" | "maxTotalMicros">;

const DEFAULT_MANIFESTS: ToolManifest[] = [
  {
    id: "weather",
    version: 1,
    active: true,
    reviewed: true,
    maxTotalMicros: 150_000,
    fixedTotalMicros: 10_000,
    origin: "https://weather.example",
    method: "GET",
    route: "/v1/weather",
    recipient: "https://weather.example",
    chain: "tempo",
    asset: "USDC",
    mppMethod: "tempo",
    intent: "charge",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export class ToolRegistry {
  private tools = new Map<string, ToolManifest>();
  constructor(manifests: ToolManifestInput[] = DEFAULT_MANIFESTS) {
    for (const input of manifests) {
      const tool: ToolManifest = {
        origin: `https://${input.id}.example`,
        method: "POST",
        route: "/v1/charge",
        recipient: `https://${input.id}.example`,
        chain: "tempo",
        asset: "USDC",
        mppMethod: "tempo",
        intent: "charge",
        reviewed: true,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        ...input,
      };
      this.validate(tool);
      this.tools.set(tool.id, copy(tool));
    }
  }
  load(manifests: ToolManifest[]) {
    this.tools.clear();
    for (const manifest of manifests) {
      const current = this.tools.get(manifest.id);
      if (!current || manifest.version > current.version)
        this.tools.set(manifest.id, copy(manifest));
    }
    for (const manifest of this.tools.values()) this.validate(manifest);
  }
  validate(tool: ToolManifest) {
    if (
      !/^[-a-z0-9]+$/.test(tool.id) ||
      !Number.isInteger(tool.version) ||
      tool.version < 1 ||
      !Number.isInteger(tool.maxTotalMicros) ||
      tool.maxTotalMicros < 0 ||
      (tool.fixedTotalMicros !== undefined &&
        (tool.fixedTotalMicros < 0 ||
          tool.fixedTotalMicros > tool.maxTotalMicros)) ||
      !tool.reviewed ||
      !tool.active ||
      !/^https:\/\//.test(tool.origin) ||
      tool.recipient !== tool.origin ||
      !tool.route.startsWith("/") ||
      tool.chain !== "tempo" ||
      tool.asset !== "USDC" ||
      tool.mppMethod !== "tempo" ||
      tool.intent !== "charge"
    )
      throw new PaymentError("invalid or unreviewed tool manifest");
    const schema = tool.inputSchema;
    if (schema.type !== "object" || schema.additionalProperties !== false)
      throw new PaymentError("tool input schema must be closed");
  }
  get(id: string) {
    const value = this.tools.get(id);
    return value ? copy(value) : undefined;
  }
  list() {
    return copy([...this.tools.values()]);
  }
  setActive(id: string, active: boolean) {
    const tool = this.tools.get(id);
    if (tool) tool.active = active;
  }
  validateInput(id: string, input: unknown) {
    const tool = this.tools.get(id);
    if (!tool) throw new PaymentError("tool is not registered");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new PaymentError("invalid tool input");
    const schema = tool.inputSchema as {
      required?: unknown;
      properties?: Record<string, unknown>;
    };
    const value = input as Record<string, unknown>;
    const properties = new Set(Object.keys(schema.properties ?? {}));
    if (Object.keys(value).some((key) => !properties.has(key)))
      throw new PaymentError("invalid tool input");
    for (const required of Array.isArray(schema.required)
      ? schema.required
      : [])
      if (!((required as string) in value))
        throw new PaymentError("invalid tool input");
  }
}

export type AuthorizationLookupResult = {
  authorizationReference?: string;
  status?: "succeeded" | "failed" | "pending";
  operationId?: string;
  ownerId?: string;
  amountMicros?: number;
  walletAddress?: string;
  requestDigest?: string;
};
export interface PaymentSigner {
  authorize(
    request: SignedPaymentRequest,
    idempotencyKey: string,
  ): Promise<{ authorizationReference: string }>;
  lookupAuthorizationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AuthorizationLookupResult | null>;
}
export class DenyPaymentSigner implements PaymentSigner {
  async authorize(): Promise<never> {
    throw new PaymentError("payment signer is disabled");
  }
  async lookupAuthorizationByIdempotencyKey(): Promise<null> {
    return null;
  }
}
export class MockPaymentSigner implements PaymentSigner {
  calls = 0;
  private readonly results = new Map<
    string,
    { authorizationReference: string }
  >();
  async authorize(
    request: SignedPaymentRequest,
    idempotencyKey = request.operationId,
  ) {
    const prior = this.results.get(idempotencyKey);
    if (prior) return prior;
    this.calls++;
    const result = {
      authorizationReference: `mock-auth-${request.operationId}`,
    };
    this.results.set(idempotencyKey, result);
    return result;
  }
  async lookupAuthorizationByIdempotencyKey(key: string) {
    return this.results.get(key) ?? null;
  }
}
export interface ReceiptVerifier {
  verify(receipt: VerifiedReceipt, payment: Payment): Promise<boolean>;
}
export class FailClosedReceiptVerifier implements ReceiptVerifier {
  async verify(): Promise<boolean> {
    return false;
  }
}
export class ConfiguredReceiptVerifier implements ReceiptVerifier {
  constructor(
    private readonly readEvidence: (
      receipt: VerifiedReceipt,
      payment: Payment,
    ) => Promise<VerifiedReceipt | null>,
  ) {}
  async verify(receipt: VerifiedReceipt, payment: Payment) {
    const evidence = await this.readEvidence(receipt, payment);
    return Boolean(
      evidence &&
      evidence.reference === receipt.reference &&
      evidence.transactionReference &&
      evidence.payerAddress === payment.payerAddress &&
      evidence.amountMicros === receipt.amountMicros &&
      evidence.currency === "USDC" &&
      evidence.network === "tempo" &&
      evidence.merchant === payment.manifestSnapshot.recipient &&
      evidence.status === receipt.status,
    );
  }
}
export class MockReceiptVerifier implements ReceiptVerifier {
  async verify(receipt: VerifiedReceipt, payment: Payment) {
    return (
      receipt.reference.length > 0 &&
      receipt.currency === "USDC" &&
      receipt.network === "tempo" &&
      receipt.amountMicros >= 0 &&
      receipt.amountMicros <=
        payment.reservedMicros + (payment.actualMicros ?? 0)
    );
  }
}
export type OnrampSessionRequest = {
  ownerId: string;
  walletAddress: string;
  amountMicros: number;
  idempotencyKey?: string;
  network: "tempo";
  currency: "USDC";
};
export type OnrampSession = {
  id: string;
  clientSecret: string;
  expiresAt: number;
  ownerId?: string;
  walletAddress?: string;
  amountMicros?: number;
};
export type OnrampLookupResult =
  | (OnrampSession & {
      status?: "succeeded" | "pending";
      ownerId?: string;
      walletAddress?: string;
      amountMicros?: number;
    })
  | { status: "failed"; error?: string };
export interface OnrampProvider {
  createSession(request: OnrampSessionRequest): Promise<OnrampSession>;
  lookupSessionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<OnrampLookupResult | null>;
}
export class FailClosedOnrampProvider implements OnrampProvider {
  async createSession(): Promise<never> {
    throw new PaymentError("onramp provider is disabled");
  }
  async lookupSessionByIdempotencyKey(): Promise<null> {
    return null;
  }
}
export class GatedOnrampProvider implements OnrampProvider {
  constructor(
    private readonly live: boolean,
    private readonly provider?: OnrampProvider,
  ) {
    if (
      live &&
      (!provider ||
        typeof provider.lookupSessionByIdempotencyKey !== "function")
    )
      throw new PaymentError("live onramp requires idempotency-key lookup");
  }
  async createSession(request: OnrampSessionRequest) {
    if (!this.live || !this.provider)
      throw new PaymentError("onramp is disabled or unconfigured");
    return this.provider.createSession({
      ...request,
      network: "tempo",
      currency: "USDC",
    });
  }
  async lookupSessionByIdempotencyKey(key: string) {
    if (!this.live || !this.provider) return null;
    return this.provider.lookupSessionByIdempotencyKey(key);
  }
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const heldStates: PaymentState[] = [
  "reserved",
  "challenged",
  "authorized",
  "submitted",
  "unknown",
];
const terminalStates: PaymentState[] = [
  "settled",
  "rejected",
  "expired",
  "cancelled",
  "reconciled_failed",
];

export class PaymentService {
  private walletOps?: WalletService;
  private manifestsReady?: Promise<void>;
  private authorizationOps = new Map<string, Promise<Payment>>();
  constructor(
    private readonly store: WalletPaymentStore,
    private readonly registry = new ToolRegistry(),
    private readonly configuredDailyLimit?: number,
    private readonly signer: PaymentSigner = new DenyPaymentSigner(),
    private readonly verifier: ReceiptVerifier = new FailClosedReceiptVerifier(),
    private readonly now: () => number = () => Date.now(),
    walletService?: WalletService,
  ) {
    this.walletOps = walletService;
    if (typeof signer.lookupAuthorizationByIdempotencyKey !== "function")
      throw new PaymentError("live signer requires idempotency-key lookup");
  }
  private financiallySafe() {
    if (this.store.supportsFinancialTransactions === false)
      throw new PaymentError(
        "durable financial transaction support is unavailable",
      );
  }
  private wallets() {
    return (this.walletOps ??= new WalletService(
      this.store,
      new MockWalletProvider(),
      () => false,
      this.now,
    ));
  }
  async wallet(ownerId: string) {
    return this.store.getWallet(ownerId);
  }
  async provision(ownerId: string) {
    return this.wallets().provision(ownerId);
  }
  async consent(
    ownerId: string,
    version: string,
    actor = ownerId,
    now = this.now(),
    confirmed = true,
  ) {
    if (!confirmed) throw new PaymentError("explicit confirmation required");
    return this.wallets().consent(ownerId, version, actor, now);
  }
  async revoke(ownerId: string, actor = ownerId, now = this.now()) {
    return this.wallets().revoke(ownerId, actor, now);
  }
  async listPayments(ownerId: string, day: string) {
    return this.store.listPayments(ownerId, day);
  }
  async enable(ownerId: string) {
    return this.provision(ownerId);
  }
  async getQuota(ownerId: string) {
    const existing = await this.store.getQuota(ownerId);
    if (existing !== null) return existing;
    const value = this.configuredDailyLimit ?? DEFAULT_DAILY_LIMIT_MICROS;
    await this.store.setQuota(ownerId, value, this.now());
    return value;
  }
  async setQuota(
    ownerId: string,
    dailyLimitMicros: number,
    confirmed: boolean,
    actor = ownerId,
  ) {
    if (!confirmed) throw new PaymentError("explicit confirmation required");
    if (!Number.isInteger(dailyLimitMicros) || dailyLimitMicros < 0)
      throw new PaymentError("invalid daily limit");
    const now = this.now();
    await this.store.transaction(async () => {
      await this.store.setQuota(ownerId, dailyLimitMicros, now);
      await this.audit(
        ownerId,
        actor,
        "quota_updated",
        undefined,
        dailyLimitMicros,
        now,
      );
    });
  }
  private async audit(
    ownerId: string,
    actor: string,
    event: string,
    payment?: Payment,
    amountMicros?: number,
    now = this.now(),
    receiptReference?: string,
    evidenceHash?: string,
    receiptEvidence?: VerifiedReceipt,
  ) {
    await this.store.appendAudit({
      id: crypto.randomUUID(),
      ownerId,
      actor,
      event,
      operationId: payment?.operationId,
      state: payment?.state,
      providerPhase: payment?.providerPhase,
      amountMicros: amountMicros ?? payment?.actualMicros,
      receiptReference,
      evidenceHash,
      manifestSnapshot: payment?.manifestSnapshot,
      consentVersion: payment?.consentVersion,
      pauseGenerations: payment?.pauseGenerations,
      requestDigest: payment?.requestDigest,
      transitionVersion: payment?.version,
      providerReference: payment?.providerReference,
      transactionReference: payment?.transactionReference,
      receiptEvidence,
      createdAt: now,
    });
  }
  private async ensureManifests() {
    this.manifestsReady ??= (async () => {
      const persisted = await this.store.listToolManifests();
      if (persisted.length) this.registry.load(persisted);
      else
        for (const manifest of this.registry.list())
          await this.store.saveToolManifest(manifest, this.now());
    })();
    await this.manifestsReady;
  }
  async reserve(input: {
    operationId: string;
    ownerId: string;
    toolId: string;
    input: unknown;
    maxTotalMicros?: number;
    now: number;
  }) {
    this.financiallySafe();
    await this.ensureManifests();
    const tool = this.registry.get(input.toolId);
    if (!tool || !tool.active || !tool.reviewed)
      throw new PaymentError("tool is not active");
    this.registry.validateInput(input.toolId, input.input);
    const existing = await this.store.getPayment(input.operationId);
    if (existing) {
      const requestedDigest = digest({
        tool: input.toolId,
        version: tool.version,
        input: input.input,
      });
      if (
        existing.ownerId !== input.ownerId ||
        existing.toolId !== input.toolId ||
        existing.toolVersion !== tool.version ||
        existing.requestDigest !== requestedDigest
      )
        throw new PaymentError(
          "operation id already belongs to another request",
        );
      return existing;
    }
    const amount = tool.fixedTotalMicros ?? input.maxTotalMicros;
    if (amount === undefined)
      throw new PaymentError("maximum total debit is unknown");
    if (!Number.isInteger(amount) || amount < 0 || amount > tool.maxTotalMicros)
      throw new PaymentError("maximum exceeds tool limit");
    const pause = await this.store.getPause("global");
    const userPause = await this.store.getPause(`user:${input.ownerId}`);
    const toolPause = await this.store.getPause(`tool:${input.toolId}`);
    const day = new Date(input.now).toISOString().slice(0, 10);
    const quota = await this.getQuota(input.ownerId);
    const wallet = await this.store.getWallet(input.ownerId);
    const payment: Payment = {
      operationId: input.operationId,
      ownerId: input.ownerId,
      toolId: input.toolId,
      toolVersion: tool.version,
      maxTotalMicros: amount,
      reservedMicros: amount,
      state: "reserved",
      createdAt: input.now,
      updatedAt: input.now,
      requestDigest: digest({
        tool: tool.id,
        version: tool.version,
        input: input.input,
      }),
      consentVersion: wallet?.consentVersion,
      payerAddress: wallet?.address,
      providerPhase: "not_started",
      version: 0,
      manifestSnapshot: tool,
      pauseGeneration: Math.max(
        pause.generation,
        userPause.generation,
        toolPause.generation,
      ),
      pauseGenerations: {
        global: pause.generation,
        user: userPause.generation,
        tool: toolPause.generation,
      },
    };
    const created = await this.store.reservePaymentIfUnpaused({
      ownerId: input.ownerId,
      day,
      amount,
      limit: quota,
      now: input.now,
      payment,
      generations: {
        global: pause.generation,
        user: userPause.generation,
        tool: toolPause.generation,
      },
    });
    if (!created) throw new PaymentError("daily limit exceeded");
    await this.audit(
      input.ownerId,
      input.ownerId,
      "payment_reserved",
      payment,
      amount,
      input.now,
    );
    return payment;
  }
  private async owned(id: string, ownerId: string) {
    const payment = await this.store.getPayment(id);
    if (!payment || payment.ownerId !== ownerId)
      throw new PaymentError("owner mismatch");
    return payment;
  }
  private async pauseGenerations(
    ownerId: string,
    toolId: string,
  ): Promise<PaymentGenerations> {
    const [global, user, tool] = await Promise.all([
      this.store.getPause("global"),
      this.store.getPause(`user:${ownerId}`),
      this.store.getPause(`tool:${toolId}`),
    ]);
    return {
      global: global.generation,
      user: user.generation,
      tool: tool.generation,
    };
  }
  private async assertNotPaused(
    ownerId: string,
    toolId: string,
    generation?: number,
  ) {
    const states = await Promise.all([
      this.store.getPause("global"),
      this.store.getPause(`user:${ownerId}`),
      this.store.getPause(`tool:${toolId}`),
    ]);
    if (states.some((pause) => pause.paused))
      throw new PaymentError("payments paused");
    if (
      generation !== undefined &&
      states.some((pause) => pause.generation > generation)
    )
      throw new PaymentError("payment pause changed");
    return states[0]!.generation;
  }
  async challenge(id: string, ownerId: string) {
    this.financiallySafe();
    const payment = await this.owned(id, ownerId);
    if (payment.state !== "reserved") {
      if (payment.state === "challenged") return payment;
      throw new PaymentError("invalid payment transition");
    }
    payment.state = "challenged";
    payment.version += 1;
    payment.updatedAt = this.now();
    await this.store.savePayment(payment);
    await this.audit(ownerId, ownerId, "payment_challenged", payment);
    return payment;
  }
  async authorize(id: string, ownerId: string) {
    this.financiallySafe();
    const key = `${ownerId}:${id}`;
    const pending = this.authorizationOps.get(key);
    if (pending) return pending;
    const operation = this.authorizeOnce(id, ownerId);
    this.authorizationOps.set(key, operation);
    try {
      return await operation;
    } finally {
      this.authorizationOps.delete(key);
    }
  }
  private async authorizeOnce(id: string, ownerId: string): Promise<Payment> {
    const initial = await this.owned(id, ownerId);
    if (initial.state === "authorized") return initial;
    if (initial.state !== "challenged" && initial.state !== "reserved")
      throw new PaymentError("invalid payment transition");
    const pauseSnapshot = await this.pauseGenerations(ownerId, initial.toolId);
    const claim = await this.store.claimPaymentAuthorization(
      id,
      ownerId,
      this.now(),
      pauseSnapshot,
    );
    if (!claim.claimed) {
      const deadline = this.now() + 5_000;
      for (;;) {
        const current = await this.owned(id, ownerId);
        if (current.state === "authorized") return current;
        if (
          current.state === "unknown" ||
          terminalStates.includes(current.state) ||
          current.providerPhase === "unknown"
        )
          throw new PaymentError("authorization reconciliation required");
        // A provider call may still be executing after the claim lease elapsed.
        // Never issue a second signer call without an explicit reconciliation.
        if (current.authorizationClaimedAt === undefined)
          throw new PaymentError("authorization claim is unresolved");
        if (this.now() >= deadline)
          throw new PaymentError("authorization claim polling timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const payment = claim.payment;
    const wallet = await this.store.getWallet(ownerId);
    if (!wallet?.delegated || wallet.revoked)
      throw new PaymentError(
        wallet?.revoked ? "revoked" : "versioned consent required",
      );
    payment.pauseGeneration = Math.max(
      pauseSnapshot.global,
      pauseSnapshot.user,
      pauseSnapshot.tool,
    );
    payment.pauseGenerations = pauseSnapshot;
    let authorization: { authorizationReference: string };
    try {
      authorization = await this.signer.authorize(
        {
          operationId: payment.operationId,
          ownerId,
          walletAddress: wallet.address,
          tool: payment.manifestSnapshot,
          amountMicros: payment.maxTotalMicros,
          requestDigest: payment.requestDigest ?? "",
        },
        payment.authorizationClaimToken!,
      );
    } catch (error) {
      payment.state = "unknown";
      payment.providerPhase = "unknown";
      payment.updatedAt = this.now();
      payment.version += 1;
      await this.store.transaction(async () => {
        await this.store.savePayment(payment);
        await this.audit(
          ownerId,
          ownerId,
          "payment_authorization_unknown",
          payment,
        );
      });
      throw error;
    }
    payment.providerReference = authorization.authorizationReference;
    payment.providerPhase = "succeeded";
    payment.state = "authorized";
    payment.updatedAt = this.now();
    payment.consentVersion = wallet.consentVersion;
    payment.payerAddress = wallet.address;
    payment.authorizationClaimToken = undefined;
    payment.authorizationClaimedAt = undefined;
    payment.version += 1;
    await this.store.savePayment(payment);
    await this.audit(ownerId, ownerId, "payment_authorized", payment);
    return payment;
  }
  async reconcileAuthorization(id: string, ownerId: string) {
    this.financiallySafe();
    const payment = await this.owned(id, ownerId);
    if (payment.state === "authorized" || payment.state === "reconciled_failed")
      return payment;
    if (payment.state !== "unknown")
      throw new PaymentError(
        "payment is not awaiting authorization reconciliation",
      );
    const lookup = this.signer.lookupAuthorizationByIdempotencyKey;
    if (!lookup) throw new PaymentError("authorization lookup is unavailable");
    const result = await lookup.call(
      this.signer,
      payment.authorizationProviderIdempotencyKey ??
        payment.authorizationClaimToken ??
        `authorize:${ownerId}:${id}`,
    );
    if (!result || result.status === "pending") return payment;
    if (
      (result.status !== "failed" && !result.authorizationReference) ||
      (result.operationId && result.operationId !== id) ||
      (result.ownerId && result.ownerId !== ownerId) ||
      (result.amountMicros !== undefined &&
        result.amountMicros !== payment.maxTotalMicros) ||
      (result.walletAddress && result.walletAddress !== payment.payerAddress) ||
      (result.requestDigest && result.requestDigest !== payment.requestDigest)
    )
      throw new PaymentError("authorization lookup evidence mismatch");
    const outcome =
      result.status === "failed" ? "reconciled_failed" : "authorized";
    const reconciled = await this.store.reconcilePaymentAuthorization(
      id,
      ownerId,
      outcome,
      this.now(),
      result.authorizationReference,
    );
    if (reconciled.transitioned)
      await this.audit(
        ownerId,
        ownerId,
        "payment_authorization_reconciled",
        reconciled,
      );
    return reconciled;
  }

  async submit(id: string, ownerId: string) {
    this.financiallySafe();
    const payment = await this.owned(id, ownerId);
    if (
      payment.state === "submitted" ||
      payment.state === "unknown" ||
      payment.state === "settled" ||
      payment.state === "reconciled_failed"
    )
      return payment;
    if (payment.state !== "authorized")
      throw new PaymentError("invalid payment transition");
    await this.assertNotPaused(
      ownerId,
      payment.toolId,
      payment.pauseGeneration,
    );
    payment.state = "submitted";
    payment.version += 1;
    payment.updatedAt = this.now();
    await this.store.savePayment(payment);
    await this.audit(ownerId, ownerId, "payment_submitted", payment);
    return payment;
  }
  async markUnknown(id: string, ownerId: string) {
    this.financiallySafe();
    const payment = await this.owned(id, ownerId);
    if (payment.state === "unknown") return payment;
    if (payment.state !== "submitted")
      throw new PaymentError("only submitted payments can be unknown");
    payment.state = "unknown";
    payment.version += 1;
    payment.updatedAt = this.now();
    await this.store.savePayment(payment);
    await this.audit(ownerId, ownerId, "payment_unknown", payment);
    return payment;
  }
  async release(id: string, ownerId?: string) {
    this.financiallySafe();
    const payment = await this.store.getPayment(id);
    if (!payment) throw new PaymentError("payment not found");
    if (ownerId && payment.ownerId !== ownerId)
      throw new PaymentError("owner mismatch");
    if (["submitted", "unknown"].includes(payment.state))
      throw new PaymentError("submitted payment requires reconciliation");
    if (terminalStates.includes(payment.state)) return payment;
    const next = await this.store.transitionAndRelease({
      payment,
      operationId: id,
      expectedState: payment.state,
      expectedVersion: payment.version,
      kind: "release",
      now: this.now(),
    });
    if (next.transitioned)
      await this.audit(
        payment.ownerId,
        ownerId ?? payment.ownerId,
        "payment_released",
        next,
      );
    return next;
  }
  async settle(id: string, actualMicros: number) {
    this.financiallySafe();
    const payment = await this.store.getPayment(id);
    if (payment?.state === "settled") return payment;
    if (!payment || actualMicros < 0 || actualMicros > payment.reservedMicros)
      throw new PaymentError("invalid settlement");
    if (payment.state === "submitted" || payment.state === "unknown")
      throw new PaymentError("verified receipt required");
    const next = await this.store.transitionAndSettle({
      payment,
      operationId: id,
      expectedState: payment.state,
      expectedVersion: payment.version,
      kind: "settle",
      actualMicros,
      now: this.now(),
    });
    if (next.transitioned)
      await this.audit(
        payment.ownerId,
        payment.ownerId,
        "payment_settled",
        next,
        actualMicros,
      );
    return next;
  }
  async reconcile(id: string, ownerId: string, receipt: VerifiedReceipt) {
    this.financiallySafe();
    return this.store.transaction(async () => {
      const payment = await this.owned(id, ownerId);
      if (
        !receipt ||
        typeof receipt.reference !== "string" ||
        !Number.isInteger(receipt.amountMicros) ||
        receipt.amountMicros < 0 ||
        receipt.currency !== "USDC" ||
        receipt.network !== "tempo" ||
        (receipt.status !== "settled" && receipt.status !== "failed") ||
        typeof receipt.merchant !== "string"
      )
        throw new PaymentError("invalid receipt schema");
      if (payment.state === "settled" || payment.state === "reconciled_failed")
        return payment;
      if (payment.state !== "submitted" && payment.state !== "unknown")
        throw new PaymentError("payment is not awaiting reconciliation");
      const valid = await this.verifier.verify(receipt, payment);
      if (
        !valid ||
        receipt.amountMicros > payment.reservedMicros ||
        receipt.merchant !== payment.manifestSnapshot.recipient ||
        (this.verifier instanceof ConfiguredReceiptVerifier &&
          (!receipt.transactionReference ||
            receipt.payerAddress !== payment.payerAddress))
      )
        throw new PaymentError("receipt mismatch");
      payment.providerReference = receipt.reference;
      payment.receiptReference = receipt.reference;
      payment.transactionReference = receipt.transactionReference;
      payment.receiptHash = digest(receipt);
      payment.receiptEvidence = receipt;
      payment.actualMicros =
        receipt.status === "settled" ? receipt.amountMicros : 0;
      const reservedMicros = payment.reservedMicros;
      payment.reservedMicros = 0;
      payment.state =
        receipt.status === "settled" ? "settled" : "reconciled_failed";
      payment.version += 1;
      payment.updatedAt = this.now();
      if (this.store.settleDailySpend)
        await this.store.settleDailySpend(
          payment.ownerId,
          new Date(payment.createdAt).toISOString().slice(0, 10),
          reservedMicros,
          payment.actualMicros,
          payment.updatedAt,
        );
      await this.store.savePayment(payment);
      await this.audit(
        ownerId,
        ownerId,
        "payment_reconciled",
        payment,
        payment.actualMicros,
        payment.updatedAt,
        receipt.reference,
        payment.receiptHash,
        receipt,
      );
      return payment;
    });
  }
  async pauseUser(ownerId: string, paused = true, actor = ownerId) {
    const result = await this.store.setPause(
      `user:${ownerId}`,
      paused,
      this.now(),
    );
    await this.audit(
      ownerId,
      actor,
      paused ? "user_spend_paused" : "user_spend_resumed",
    );
    return result;
  }
  async pauseGlobal(paused = true, actor = "operator") {
    const result = await this.store.setPause("global", paused, this.now());
    await this.audit(
      "system",
      actor,
      paused ? "global_spend_paused" : "global_spend_resumed",
    );
    return result;
  }
  async pauseTool(toolId: string, paused = true, actor = "operator") {
    const result = await this.store.setPause(
      `tool:${toolId}`,
      paused,
      this.now(),
    );
    await this.audit(
      "system",
      actor,
      paused ? "tool_spend_paused" : "tool_spend_resumed",
    );
    return result;
  }
  async listAudit(ownerId?: string) {
    return this.store.listAudit(ownerId);
  }
  listTools() {
    return this.registry.list();
  }
  async activateTool(id: string, version: number, actor = "operator") {
    await this.ensureManifests();
    await this.store.transaction(async () => {
      await this.store.activateToolManifest(id, version, this.now());
      await this.audit("system", actor, "tool_manifest_activated");
    });
    const current = await this.store.listToolManifests();
    if (current.length) this.registry.load(current);
  }
  async rawSign(_tx?: unknown): Promise<never> {
    throw new PaymentError("raw signing is denied");
  }
}

export class WalletFundingService {
  private readonly inFlight = new Map<string, Promise<OnrampSession>>();
  private static readonly MAX_OBSERVATION_MS = 1_000;
  constructor(
    private readonly store: WalletPaymentStore,
    private readonly provider: OnrampProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly maxFundingMicros = DEFAULT_MAX_FUNDING_MICROS,
  ) {}
  async reconcileFunding(ownerId: string, idempotencyKey: string) {
    const current = await this.store.getFundingAttempt(ownerId, idempotencyKey);
    if (!current) throw new PaymentError("funding attempt not found");
    if (current.status === "completed" || current.status === "failed")
      return current;
    if (current.status !== "unknown")
      throw new PaymentError("funding attempt is not awaiting reconciliation");
    const lookup = this.provider.lookupSessionByIdempotencyKey;
    if (!lookup) throw new PaymentError("funding lookup is unavailable");
    const result = await lookup.call(
      this.provider,
      current.providerIdempotencyKey,
    );
    if (!result || ("status" in result && result.status === "pending"))
      return current;
    if ("status" in result && result.status === "failed") {
      await this.store.failFundingAttempt(
        current,
        result.error ?? "funding failed",
        this.now(),
      );
      await this.store.appendAudit({
        id: crypto.randomUUID(),
        ownerId,
        actor: ownerId,
        event: "onramp_reconciled_failed",
        providerPhase: "failed",
        amountMicros: current.amountMicros,
        consentVersion: current.consentVersion,
        manifestSnapshot: current.policySnapshot ?? undefined,
        pauseGenerations: current.pauseGenerations,
        createdAt: this.now(),
      });
      return (await this.store.getFundingAttempt(ownerId, idempotencyKey))!;
    }
    if (
      !result.id ||
      !result.clientSecret ||
      (result.ownerId && result.ownerId !== ownerId) ||
      (result.walletAddress &&
        result.walletAddress !== current.walletAddress) ||
      (result.amountMicros !== undefined &&
        result.amountMicros !== current.amountMicros)
    )
      throw new PaymentError("funding lookup evidence mismatch");
    const completed = {
      ...current,
      session: result,
      status: "in_progress" as const,
    };
    await this.store.completeFundingAttempt(completed, this.now());
    await this.store.appendAudit({
      id: crypto.randomUUID(),
      ownerId,
      actor: ownerId,
      event: "onramp_session_reconciled",
      providerPhase: "succeeded",
      amountMicros: current.amountMicros,
      providerReference: result.id,
      consentVersion: current.consentVersion,
      manifestSnapshot: current.policySnapshot ?? undefined,
      pauseGenerations: current.pauseGenerations,
      createdAt: this.now(),
    });
    return (await this.store.getFundingAttempt(ownerId, idempotencyKey))!;
  }

  async createSession(
    ownerId: string,
    amountMicros: number,
    idempotencyKey = `fund:${ownerId}:${amountMicros}`,
  ) {
    if (
      !Number.isSafeInteger(amountMicros) ||
      amountMicros <= 0 ||
      amountMicros > this.maxFundingMicros
    )
      throw new PaymentError("invalid funding amount", "INVALID_AMOUNT");
    assertIdempotencyKey(idempotencyKey);
    const wallet = await this.store.getWallet(ownerId);
    if (
      !wallet ||
      wallet.revoked ||
      !wallet.delegated ||
      !wallet.consentVersion ||
      !(SUPPORTED_CONSENT_VERSIONS as readonly string[]).includes(
        wallet.consentVersion,
      )
    )
      throw new PaymentError("wallet is unavailable");
    const pauseSnapshot = await Promise.all([
      this.store.getPause("global"),
      this.store.getPause(`user:${ownerId}`),
    ]);
    const pauseGenerations = {
      global: pauseSnapshot[0]!.generation,
      user: pauseSnapshot[1]!.generation,
      tool: 0,
    };
    const initial: FundingAttempt = {
      ownerId,
      idempotencyKey,
      providerIdempotencyKey: `onramp:${ownerId}:${idempotencyKey}`,
      amountMicros,
      walletAddress: wallet.address,
      consentVersion: wallet.consentVersion,
      policySnapshot: {
        kind: "wallet-funding",
        network: "tempo",
        currency: "USDC",
        walletAddress: wallet.address,
        consentVersion: wallet.consentVersion,
      },
      pauseGenerations,
      status: "in_progress",
      providerPhase: "in_flight",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const claim = await this.store.claimFundingAttempt(
      initial,
      this.now(),
      pauseGenerations,
    );
    if (!claim.claimed) {
      const key = `${ownerId}:${idempotencyKey}`;
      const joined = this.inFlight.get(key);
      if (joined) {
        try {
          return await Promise.race([
            joined,
            new Promise<OnrampSession>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new PaymentError(
                      "funding attempt is unknown; reconciliation required",
                    ),
                  ),
                WalletFundingService.MAX_OBSERVATION_MS,
              ),
            ),
          ]);
        } catch (error) {
          if (error instanceof PaymentError) {
            const current = await this.store.getFundingAttempt(
              ownerId,
              idempotencyKey,
            );
            if (current?.status === "in_progress")
              await this.store.markFundingUnknown(
                current,
                error.message,
                this.now(),
              );
          }
          throw error;
        }
      }
      const current = await this.store.getFundingAttempt(
        ownerId,
        idempotencyKey,
      );
      if (current?.status === "completed" && current.session)
        return current.session;
      if (current?.status === "failed")
        throw new PaymentError(current.error ?? "funding failed");
      if (current?.status === "unknown")
        throw new PaymentError(
          "funding attempt is unknown; reconciliation required",
        );
      if (current?.status === "in_progress") {
        await this.store.markFundingUnknown(
          current,
          "funding attempt requires reconciliation after restart",
          this.now(),
        );
        throw new PaymentError(
          "funding attempt is unknown; reconciliation required",
        );
      }
      throw new PaymentError(
        "funding attempt is unknown; reconciliation required",
      );
    }
    const key = `${ownerId}:${idempotencyKey}`;
    const providerCall = this.provider.createSession({
      ownerId,
      walletAddress: wallet.address,
      amountMicros,
      idempotencyKey: claim.attempt.providerIdempotencyKey,
      network: "tempo",
      currency: "USDC",
    });
    this.inFlight.set(key, providerCall);
    try {
      const session = await providerCall;
      const completed = {
        ...claim.attempt,
        session,
        providerPhase: "succeeded" as const,
      };
      await this.store.transaction(async () => {
        await this.store.completeFundingAttempt(completed, this.now());
        await this.store.appendAudit({
          id: crypto.randomUUID(),
          ownerId,
          actor: ownerId,
          event: "onramp_session_created",
          amountMicros,
          providerReference: session.id,
          consentVersion: wallet.consentVersion,
          manifestSnapshot: completed.policySnapshot ?? undefined,
          requestDigest: digest({
            ownerId,
            amountMicros,
            walletAddress: wallet.address,
            idempotencyKey,
          }),
          pauseGenerations: {
            global: claim.attempt.pauseGenerations.global,
            user: claim.attempt.pauseGenerations.user,
            tool: claim.attempt.pauseGenerations.tool,
          },
          createdAt: this.now(),
        });
      });
      this.inFlight.delete(key);
      return session;
    } catch (error) {
      await this.store.transaction(async () => {
        await this.store.markFundingUnknown(
          claim.attempt,
          String(error),
          this.now(),
        );
        await this.store.appendAudit({
          id: crypto.randomUUID(),
          ownerId,
          actor: ownerId,
          event: "onramp_session_unknown",
          providerPhase: "unknown",
          amountMicros,
          consentVersion: wallet.consentVersion,
          manifestSnapshot: claim.attempt.policySnapshot ?? undefined,
          pauseGenerations: claim.attempt.pauseGenerations,
          createdAt: this.now(),
        });
      });
      this.inFlight.delete(key);
      throw error;
    }
  }
}
