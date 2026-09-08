import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_LIMIT_MICROS,
  MemoryWalletStore,
  MockWalletProvider,
  GatedWalletProvider,
  WalletFundingService,
  FailClosedOnrampProvider,
  PaymentError,
  PaymentService,
  MockPaymentSigner,
  MockReceiptVerifier,
  ToolRegistry,
  WalletService,
  type AuthorizationLookupResult,
  type OnrampProvider,
  type OnrampSession,
  type PaymentSigner,
  type WalletProvider,
} from "./wallet-payment.js";

class DelayedWalletProvider implements WalletProvider {
  calls = 0;
  async create(ownerId: string) {
    this.calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      providerUserId: `delayed-user-${ownerId}`,
      providerWalletId: `delayed-wallet-${ownerId}`,
      address: `0x${"1".repeat(40)}`,
      chain: "tempo" as const,
      asset: "USDC" as const,
    };
  }
}

class CountingOnrampProvider implements OnrampProvider {
  calls = 0;
  async createSession(request: Parameters<OnrampProvider["createSession"]>[0]) {
    this.calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      id: `session-${this.calls}`,
      clientSecret: `secret-${request.ownerId}`,
      expiresAt: 10_000,
    };
  }
  async lookupSessionByIdempotencyKey() {
    return null;
  }
}

class GateSigner implements PaymentSigner {
  calls = 0;
  started!: () => void;
  continue!: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  private readonly continuePromise = new Promise<void>((resolve) => {
    this.continue = resolve;
  });
  async waitStarted() {
    return this.startedPromise;
  }
  async lookupAuthorizationByIdempotencyKey() {
    return null;
  }
  async authorize(request: Parameters<PaymentSigner["authorize"]>[0]) {
    this.calls++;
    this.started();
    await this.continuePromise;
    return { authorizationReference: `gated-auth-${request.operationId}` };
  }
}

class GateOnrampProvider implements OnrampProvider {
  calls = 0;
  started!: () => void;
  continue!: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  private readonly continuePromise = new Promise<void>((resolve) => {
    this.continue = resolve;
  });
  async waitStarted() {
    return this.startedPromise;
  }
  async lookupSessionByIdempotencyKey() {
    return null;
  }
  async createSession(request: Parameters<OnrampProvider["createSession"]>[0]) {
    this.calls++;
    this.started();
    await this.continuePromise;
    return { id: "gated-session", clientSecret: "secret", expiresAt: 10_000 };
  }
}

class AmbiguousSigner implements PaymentSigner {
  calls = 0;
  result: AuthorizationLookupResult | null = null;
  async authorize(): Promise<never> {
    this.calls++;
    throw new Error("signer timeout");
  }
  async lookupAuthorizationByIdempotencyKey() {
    return this.result;
  }
}

class AmbiguousOnrampProvider implements OnrampProvider {
  calls = 0;
  result: OnrampSession | null = null;
  async createSession(): Promise<never> {
    this.calls++;
    throw new Error("onramp timeout");
  }
  async lookupSessionByIdempotencyKey() {
    return this.result;
  }
}

class NonNestedTransactionStore extends MemoryWalletStore {
  private activeTransactions = 0;
  nestedTransactions = 0;
  override async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeTransactions) this.nestedTransactions++;
    this.activeTransactions++;
    try {
      return await super.transaction(fn);
    } finally {
      this.activeTransactions--;
    }
  }
}

describe("bounded wallet/payment scaffold", () => {
  it("shares one durable provisioning claim across independent services", async () => {
    const store = new MemoryWalletStore();
    const provider = new MockWalletProvider();
    const a = new WalletService(store, provider, () => false);
    const b = new WalletService(store, provider, () => false);
    const [first, second] = await Promise.all([
      a.provision("owner-race"),
      b.provision("owner-race"),
    ]);
    expect(first).toEqual(second);
    expect(provider.calls).toBe(1);
    expect(await store.listWallets()).toHaveLength(1);
  });

  it("returns the persisted provisioning winner across delayed independent callers", async () => {
    const store = new MemoryWalletStore();
    const provider = new DelayedWalletProvider();
    const [first, second] = await Promise.all([
      new WalletService(store, provider, () => false).provision("slow-owner"),
      new WalletService(store, provider, () => false).provision("slow-owner"),
    ]);
    expect(first.providerWalletId).toBe("delayed-wallet-slow-owner");
    expect(second).toEqual(first);
    expect(provider.calls).toBe(1);
  });

  it("provisions exactly one wallet per owner", async () => {
    const store = new MemoryWalletStore();
    const provider = new MockWalletProvider();
    const service = new WalletService(store, provider, () => false);
    const [a, b] = await Promise.all([
      service.provision("owner-1"),
      service.provision("owner-1"),
    ]);
    expect(a).toEqual(b);
    expect((await store.listWallets()).length).toBe(1);
  });

  it("requires versioned consent before delegation", async () => {
    const store = new MemoryWalletStore();
    const service = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await expect(service.delegate("owner-1")).rejects.toThrow(PaymentError);
    await service.consent("owner-1", "wallet-spend-v1");
    expect((await service.delegate("owner-1")).consentVersion).toBe(
      "wallet-spend-v1",
    );
  });

  it("atomically caps concurrent reservations and rejects unknown maxima", async () => {
    const store = new MemoryWalletStore();
    const payments = new PaymentService(
      store,
      new ToolRegistry([
        { id: "weather", version: 1, active: true, maxTotalMicros: 150_000 },
      ]),
    );
    await payments.enable("owner-1");
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        payments.reserve({
          operationId: `op-${i}`,
          ownerId: "owner-1",
          toolId: "weather",
          input: {},
          maxTotalMicros: 150_000,
          now: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      payments.reserve({
        operationId: "unknown",
        ownerId: "owner-1",
        toolId: "weather",
        input: {},
        maxTotalMicros: undefined,
        now: 1,
      }),
    ).rejects.toThrow("maximum");
    expect(DEFAULT_DAILY_LIMIT_MICROS).toBe(200_000);
  });

  it("rejects unsupported consent versions and supports revocation", async () => {
    const store = new MemoryWalletStore();
    const service = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await expect(service.consent("owner-1", "bogus")).rejects.toThrow(
      "unsupported",
    );
    await service.consent("owner-1", "wallet-spend-v1");
    await service.revoke("owner-1");
    await expect(service.delegate("owner-1")).rejects.toThrow("revoked");
  });

  it("uses a reviewed default registry and validates closed tool input", async () => {
    const registry = new ToolRegistry();
    const weather = registry.get("weather");
    expect(weather?.active).toBe(true);
    expect(weather?.reviewed).toBe(true);
    expect(() =>
      registry.validateInput("weather", { unexpected: true }),
    ).toThrow("input");
    expect(() => registry.validateInput("weather", {})).not.toThrow();
  });

  it("persists quota overrides only after explicit confirmation", async () => {
    const store = new MemoryWalletStore();
    const payments = new PaymentService(store, new ToolRegistry());
    expect(await payments.getQuota("owner-1")).toBe(DEFAULT_DAILY_LIMIT_MICROS);
    await expect(payments.setQuota("owner-1", 300_000, false)).rejects.toThrow(
      "confirmation",
    );
    await payments.setQuota("owner-1", 300_000, true);
    expect(await payments.getQuota("owner-1")).toBe(300_000);
  });

  it("guards the complete payment state machine and reconciles a verified receipt exactly once", async () => {
    const store = new MemoryWalletStore();
    const registry = new ToolRegistry([
      {
        id: "weather",
        version: 2,
        active: true,
        reviewed: true,
        maxTotalMicros: 10_000,
        fixedTotalMicros: 10_000,
      },
    ]);
    const signer = new MockPaymentSigner();
    const payments = new PaymentService(
      store,
      registry,
      undefined,
      signer,
      new MockReceiptVerifier(),
    );
    await payments.consent("owner-1", "wallet-spend-v1");
    const reserved = await payments.reserve({
      operationId: "op",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      now: 1,
    });
    expect(reserved.state).toBe("reserved");
    expect((await payments.challenge("op", "owner-1")).state).toBe(
      "challenged",
    );
    expect((await payments.authorize("op", "owner-1")).state).toBe(
      "authorized",
    );
    expect((await payments.submit("op", "owner-1")).state).toBe("submitted");
    const receipt = {
      reference: "tx-1",
      amountMicros: 10_000,
      currency: "USDC" as const,
      network: "tempo" as const,
      merchant: "https://weather.example",
      status: "settled" as const,
    };
    expect((await payments.reconcile("op", "owner-1", receipt)).state).toBe(
      "settled",
    );
    expect((await payments.reconcile("op", "owner-1", receipt)).state).toBe(
      "settled",
    );
    expect((await store.listAudit("owner-1")).length).toBeGreaterThanOrEqual(6);
  });

  it("holds unknown submissions and refuses automatic repayment", async () => {
    const store = new MemoryWalletStore();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      new MockPaymentSigner(),
      new MockReceiptVerifier(),
    );
    await payments.consent("owner-1", "wallet-spend-v1");
    await payments.reserve({
      operationId: "op-unknown",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      now: 1,
    });
    await payments.challenge("op-unknown", "owner-1");
    await payments.authorize("op-unknown", "owner-1");
    await payments.submit("op-unknown", "owner-1");
    await expect(payments.release("op-unknown")).rejects.toThrow("submitted");
    expect((await payments.markUnknown("op-unknown", "owner-1")).state).toBe(
      "unknown",
    );
  });

  it("makes settle and release exact-once under concurrent retries", async () => {
    const store = new MemoryWalletStore();
    const payments = new PaymentService(
      store,
      new ToolRegistry([
        { id: "weather", version: 1, active: true, maxTotalMicros: 10_000 },
      ]),
    );
    const reserved = await payments.reserve({
      operationId: "once-1",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      maxTotalMicros: 10_000,
      now: 1_700_000_000_000,
    });
    await Promise.all([
      payments.settle(reserved.operationId, 9_000),
      payments.settle(reserved.operationId, 9_000),
    ]);
    expect(
      (await payments.listAudit("owner-1")).filter(
        (entry) => entry.event === "payment_settled",
      ),
    ).toHaveLength(1);
    const released = await payments.reserve({
      operationId: "once-2",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      maxTotalMicros: 10_000,
      now: 1_700_000_000_000,
    });
    await Promise.all([
      payments.release(released.operationId, "owner-1"),
      payments.release(released.operationId, "owner-1"),
    ]);
    expect(
      (await payments.listAudit("owner-1")).filter(
        (entry) => entry.event === "payment_released",
      ),
    ).toHaveLength(1);
  });

  it("fails closed for live wallet and onramp providers without configured adapters", async () => {
    const store = new MemoryWalletStore();
    const walletProvider = new GatedWalletProvider(true);
    await expect(walletProvider.create("owner-1")).rejects.toThrow("disabled");
    await expect(
      new WalletFundingService(
        store,
        new FailClosedOnrampProvider(),
      ).createSession("owner-1", 1),
    ).rejects.toThrow("wallet");
  });

  it("persists one consent-gated onramp attempt for concurrent callers", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("fund-owner", "wallet-spend-v1");
    const provider = new CountingOnrampProvider();
    const funding = new WalletFundingService(store, provider);
    const [a, b] = await Promise.all([
      funding.createSession("fund-owner", 25_000, "funding-1"),
      funding.createSession("fund-owner", 25_000, "funding-1"),
    ]);
    expect(a).toEqual(b);
    expect(provider.calls).toBe(1);
    expect(
      (await store.listAudit("fund-owner")).filter(
        (entry) => entry.event === "onramp_session_created",
      ),
    ).toHaveLength(1);
  });

  it("rejects conflicting onramp idempotency payloads", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("fund-conflict", "wallet-spend-v1");
    const funding = new WalletFundingService(
      store,
      new CountingOnrampProvider(),
    );
    await funding.createSession("fund-conflict", 25_000, "funding-conflict");
    await expect(
      funding.createSession("fund-conflict", 30_000, "funding-conflict"),
    ).rejects.toThrow("idempotency");
  });

  it("claims authorization durably across independent payment services", async () => {
    const store = new MemoryWalletStore();
    const signer = new MockPaymentSigner();
    const first = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    const second = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    await first.consent("auth-owner", "wallet-spend-v1");
    await first.reserve({
      operationId: "auth-race",
      ownerId: "auth-owner",
      toolId: "weather",
      input: {},
      now: 1_700_000_000_000,
    });
    await first.challenge("auth-race", "auth-owner");
    const [a, b] = await Promise.all([
      first.authorize("auth-race", "auth-owner"),
      second.authorize("auth-race", "auth-owner"),
    ]);
    expect(a.state).toBe("authorized");
    expect(b).toEqual(a);
    expect(signer.calls).toBe(1);
  });

  it("denies paused, revoked, inactive, cross-user and raw signing requests", async () => {
    const store = new MemoryWalletStore();
    const registry = new ToolRegistry([
      { id: "weather", version: 1, active: true, maxTotalMicros: 10_000 },
    ]);
    const payments = new PaymentService(store, registry);
    await payments.enable("owner-1");
    await payments.reserve({
      operationId: "op",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      maxTotalMicros: 10_000,
      now: 1,
    });
    await payments.pauseUser("owner-1");
    await expect(payments.authorize("op", "owner-1")).rejects.toThrow("paused");
    await expect(payments.authorize("op", "owner-2")).rejects.toThrow("owner");
    await expect(
      payments.rawSign({ to: "attacker", value: "1" }),
    ).rejects.toThrow("raw");
    registry.setActive("weather", false);
    await expect(
      payments.reserve({
        operationId: "op2",
        ownerId: "owner-1",
        toolId: "weather",
        input: {},
        maxTotalMicros: 1,
        now: 2,
      }),
    ).rejects.toThrow("active");
  });

  it("invokes the signer once when authorization is retried concurrently", async () => {
    const store = new MemoryWalletStore();
    const signer = new MockPaymentSigner();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    await payments.consent("owner-1", "wallet-spend-v1");
    await payments.reserve({
      operationId: "race",
      ownerId: "owner-1",
      toolId: "weather",
      input: {},
      now: 1,
    });
    await payments.challenge("race", "owner-1");
    await Promise.all([
      payments.authorize("race", "owner-1"),
      payments.authorize("race", "owner-1"),
    ]);
    expect(signer.calls).toBe(1);
  });

  it("blocks funding before claim when paused", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("pause-before", "wallet-spend-v1");
    await store.setPause("global", true, 1);
    const provider = new GateOnrampProvider();
    await expect(
      new WalletFundingService(store, provider).createSession(
        "pause-before",
        1_000,
        "pause-before-key",
      ),
    ).rejects.toThrow("pause");
    expect(provider.calls).toBe(0);
  });

  it("allows the single claimed funding call after a pause and persists it", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("pause-after", "wallet-spend-v1");
    const provider = new GateOnrampProvider();
    const pending = new WalletFundingService(store, provider).createSession(
      "pause-after",
      1_000,
      "pause-after-key",
    );
    await provider.waitStarted();
    await store.setPause("global", true, 1);
    provider.continue();
    await expect(pending).resolves.toMatchObject({ id: "gated-session" });
    expect(provider.calls).toBe(1);
  });

  it("allows a claimed signer call to finish after a pause", async () => {
    const store = new MemoryWalletStore();
    const signer = new GateSigner();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    await payments.consent("sign-pause-after", "wallet-spend-v1");
    await payments.reserve({
      operationId: "sign-pause",
      ownerId: "sign-pause-after",
      toolId: "weather",
      input: {},
      now: 1,
    });
    await payments.challenge("sign-pause", "sign-pause-after");
    const pending = payments.authorize("sign-pause", "sign-pause-after");
    await signer.waitStarted();
    await store.setPause("global", true, 2);
    signer.continue();
    await expect(pending).resolves.toMatchObject({ state: "authorized" });
    expect(signer.calls).toBe(1);
  });

  it("persists ambiguous authorization and reconciles without a second signer call", async () => {
    const store = new MemoryWalletStore();
    const signer = new AmbiguousSigner();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    await payments.consent("auth-unknown", "wallet-spend-v1");
    await payments.reserve({
      operationId: "auth-unknown-op",
      ownerId: "auth-unknown",
      toolId: "weather",
      input: {},
      now: 1,
    });
    await payments.challenge("auth-unknown-op", "auth-unknown");
    await expect(
      payments.authorize("auth-unknown-op", "auth-unknown"),
    ).rejects.toThrow("timeout");
    expect(await store.getPayment("auth-unknown-op")).toMatchObject({
      state: "unknown",
      providerPhase: "unknown",
    });
    const restarted = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    signer.result = { authorizationReference: "reconciled-auth" };
    await expect(
      restarted.reconcileAuthorization("auth-unknown-op", "auth-unknown"),
    ).resolves.toMatchObject({
      state: "authorized",
      providerReference: "reconciled-auth",
    });
    await expect(
      restarted.reconcileAuthorization("auth-unknown-op", "auth-unknown"),
    ).resolves.toMatchObject({ state: "authorized" });
    expect(signer.calls).toBe(1);
  });

  it("persists ambiguous funding and reconciles without a second onramp create", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("fund-unknown", "wallet-spend-v1");
    const provider = new AmbiguousOnrampProvider();
    const funding = new WalletFundingService(store, provider, () => 1);
    await expect(
      funding.createSession("fund-unknown", 1_000, "fund-unknown-key"),
    ).rejects.toThrow("timeout");
    expect(
      await store.getFundingAttempt("fund-unknown", "fund-unknown-key"),
    ).toMatchObject({ status: "unknown", providerPhase: "unknown" });
    provider.result = {
      id: "reconciled-session",
      clientSecret: "reconciled-secret",
      expiresAt: 2_000,
      ownerId: "fund-unknown",
      walletAddress: (await store.getWallet("fund-unknown"))!.address,
      amountMicros: 1_000,
    };
    const restarted = new WalletFundingService(store, provider, () => 2);
    await expect(
      restarted.reconcileFunding("fund-unknown", "fund-unknown-key"),
    ).resolves.toMatchObject({
      status: "completed",
      providerPhase: "succeeded",
    });
    await expect(
      restarted.reconcileFunding("fund-unknown", "fund-unknown-key"),
    ).resolves.toMatchObject({ status: "completed" });
    expect(provider.calls).toBe(1);
  });

  it("rejects mismatched authorization reconciliation evidence", async () => {
    const store = new MemoryWalletStore();
    const signer = new AmbiguousSigner();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      signer,
    );
    await payments.consent("auth-mismatch", "wallet-spend-v1");
    await payments.reserve({
      operationId: "auth-mismatch-op",
      ownerId: "auth-mismatch",
      toolId: "weather",
      input: {},
      now: 1,
    });
    await payments.challenge("auth-mismatch-op", "auth-mismatch");
    await expect(
      payments.authorize("auth-mismatch-op", "auth-mismatch"),
    ).rejects.toThrow("timeout");
    signer.result = {
      authorizationReference: "wrong",
      operationId: "other-operation",
    };
    await expect(
      payments.reconcileAuthorization("auth-mismatch-op", "auth-mismatch"),
    ).rejects.toThrow("mismatch");
    expect((await store.getPayment("auth-mismatch-op"))?.state).toBe("unknown");
  });

  it("rejects mismatched funding reconciliation evidence", async () => {
    const store = new MemoryWalletStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("fund-mismatch", "wallet-spend-v1");
    const provider = new AmbiguousOnrampProvider();
    const funding = new WalletFundingService(store, provider, () => 1);
    await expect(
      funding.createSession("fund-mismatch", 1_000, "fund-mismatch-key"),
    ).rejects.toThrow("timeout");
    provider.result = {
      id: "wrong-session",
      clientSecret: "secret",
      expiresAt: 2_000,
      ownerId: "other-owner",
    };
    await expect(
      funding.reconcileFunding("fund-mismatch", "fund-mismatch-key"),
    ).rejects.toThrow("mismatch");
  });

  it("does not nest the atomic reserve transaction", async () => {
    const store = new NonNestedTransactionStore();
    const wallet = new WalletService(
      store,
      new MockWalletProvider(),
      () => false,
    );
    await wallet.consent("non-nested", "wallet-spend-v1");
    store.nestedTransactions = 0;
    await new PaymentService(store, new ToolRegistry()).reserve({
      operationId: "non-nested-op",
      ownerId: "non-nested",
      toolId: "weather",
      input: {},
      now: 1,
    });
    expect(store.nestedTransactions).toBe(0);
  });

  it("refreshes the runtime registry after durable manifest activation", async () => {
    const store = new MemoryWalletStore();
    const manifest = {
      ...new ToolRegistry().get("weather")!,
      version: 2,
      active: true,
      reviewed: true,
    };
    await store.saveToolManifest(manifest);
    const payments = new PaymentService(store, new ToolRegistry());
    await payments.activateTool("weather", 2, "admin");
    expect(
      payments.listTools().find((tool) => tool.id === "weather"),
    ).toMatchObject({ version: 2, active: true, reviewed: true });
  });

  it("rejects mutation of an existing manifest version", async () => {
    const store = new MemoryWalletStore();
    const manifest = new ToolRegistry().get("weather")!;
    await store.saveToolManifest(manifest);
    await expect(
      store.saveToolManifest({
        ...manifest,
        recipient: "https://evil.example",
      }),
    ).rejects.toThrow("immutable");
  });
});
