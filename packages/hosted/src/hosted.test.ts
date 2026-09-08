import { describe, expect, it } from "vitest";
import {
  CharacterExportSchema,
  CreateCharacterSchema,
  ReportSchema,
  hashString,
  locationAtPoint,
} from "../../shared/src/index.js";
import { createHandler, isAdmin, parseEnv } from "./handler.js";
import { executeJob, positionAt, runAutonomy } from "./jobs.js";
import { MemoryStore } from "./memory-store.js";
import {
  MockPaymentSigner,
  MockReceiptVerifier,
  PaymentService,
  ToolRegistry,
} from "./wallet-payment.js";
import { CLAIM_JOB_SQL } from "./store.js";
import type {
  HostedDeps,
  Request as HandlerRequest,
  Response,
} from "./handler.js";
import type { CharacterRow } from "./store.js";

class MockResponse implements Response {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};
  body = "";
  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    this.body = body ?? "";
  }
  json(): any {
    return this.body ? JSON.parse(this.body) : undefined;
  }
}

const baseEnv = parseEnv({
  NEON_AUTH_BASE_URL: "https://auth.example.test",
  CRON_SECRET: "cron-secret",
  AGENT_WORLD_ADMIN_USER_IDS: "admin-1",
  AGENT_WORLD_MUTATION_LIMIT: "20",
});

const characterInput = {
  name: "Moss",
  personality: "Curious about tiny gardens and quiet libraries",
  model: "z-ai/glm-5.3-flash",
  dailyBudgetMicros: 500_000,
  decisionIntervalSeconds: 60,
  firstMission: "explore" as const,
};

const makeHandler = (
  store: MemoryStore,
  sessions: Map<string, string | null>,
  extras: Partial<HostedDeps> = {},
) =>
  createHandler({
    store,
    env: baseEnv,
    sessionUserId: async (request) => {
      const cookie = String(
        request.headers.cookie ?? request.headers.Cookie ?? "",
      );
      if (sessions.has(cookie)) return sessions.get(cookie) ?? null;
      return null;
    },
    now: () => Date.now(),
    fetch: (async () =>
      new globalThis.Response("{}", { status: 200 })) as typeof fetch,
    log: () => undefined,
    ...extras,
  });

const invoke = async (
  handler: ReturnType<typeof createHandler>,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string;
    authorization?: string;
    ifNoneMatch?: string;
  } = {},
) => {
  const response = new MockResponse();
  const headers: HandlerRequest["headers"] = {
    host: "agent-world.example",
    origin: "https://agent-world.example",
  };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  if (init.ifNoneMatch) headers["if-none-match"] = init.ifNoneMatch;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  await handler(
    {
      method: init.method ?? "GET",
      url: `https://agent-world.example/api${path}`,
      body: init.body,
      headers,
    },
    response,
  );
  return response;
};

const seedCharacter = async (
  store: MemoryStore,
  ownerId: string,
  name: string,
  now = Date.now(),
): Promise<CharacterRow> => {
  const row: CharacterRow = {
    id: crypto.randomUUID(),
    ownerId,
    name,
    personality: "Curious about tiny gardens and quiet libraries",
    model: "z-ai/glm-5.3-flash",
    dailyBudgetMicros: 500_000,
    spentTodayMicros: 0,
    budgetDate: new Date(now).toISOString().slice(0, 10),
    decisionIntervalSeconds: 60,
    nextDecisionAt: now + 60_000,
    lastReactionAt: 0,
    state: "active",
    x: 455,
    y: 275,
    targetX: 455,
    targetY: 275,
    movementStartedAt: now,
    movementArrivesAt: now,
    intent: "Looking around",
    speech: null,
    speechExpiresAt: null,
    avatarUrl: null,
    avatarColor: "#579c87",
    toolActive: false,
    paused: false,
    muted: false,
    reputation: 0,
    locationId: "plaza",
    currentConversationId: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.insertCharacter(row);
  return row;
};

describe("hosted wallet authorization", () => {
  it("derives wallet ownership from the authenticated session and gates consent", async () => {
    const store = new MemoryStore();
    const payments = new PaymentService(
      store,
      new ToolRegistry(),
      undefined,
      new MockPaymentSigner(),
      new MockReceiptVerifier(),
    );
    const sessions = new Map<string, string | null>([
      ["a=1", "owner-a"],
      ["b=1", "owner-b"],
      ["admin=1", "admin-1"],
    ]);
    const handler = makeHandler(store, sessions, { payments });
    const provision = await invoke(handler, "/wallet/provision", {
      method: "POST",
      cookie: "a=1",
    });
    expect(provision.statusCode).toBe(201);
    const hidden = await invoke(handler, "/wallet", { cookie: "b=1" });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().wallet).toBeNull();
    const missingConfirmation = await invoke(handler, "/wallet/consent", {
      method: "POST",
      cookie: "a=1",
      body: { version: "wallet-spend-v1" },
    });
    expect(missingConfirmation.statusCode).toBe(400);
    const consent = await invoke(handler, "/wallet/consent", {
      method: "POST",
      cookie: "a=1",
      body: { version: "wallet-spend-v1", confirmed: true },
    });
    expect(consent.statusCode).toBe(200);
    const pause = await invoke(handler, "/admin/spend-pause", {
      method: "POST",
      cookie: "admin=1",
      body: { scope: "global", paused: true },
    });
    expect(pause.statusCode).toBe(200);
  });
});

describe("hosted authorization", () => {
  it("rejects anonymous character mutations", async () => {
    const store = new MemoryStore();
    const handler = makeHandler(store, new Map());
    const created = await invoke(handler, "/characters", {
      method: "POST",
      body: characterInput,
    });
    expect(created.statusCode).toBe(401);
  });

  it("does not disclose authentication exceptions and logs only classification", async () => {
    const events: import("./logging.js").LogEvent[] = [];
    const store = new MemoryStore();
    const handler = makeHandler(store, new Map(), {
      sessionUserId: async () => {
        throw new Error("provider password=super-secret SQL stack trace");
      },
      log: (event) => events.push(event),
    });
    const response = await invoke(handler, "/characters", {
      method: "POST",
      body: characterInput,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("super-secret");
    expect(response.json()).toEqual({
      error: "AUTHENTICATION_UNAVAILABLE",
      requestId: expect.any(String),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: "authentication failed",
        kind: "AUTHENTICATION_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("does not disclose character creation exceptions and logs only classification", async () => {
    const events: import("./logging.js").LogEvent[] = [];
    class FailingStore extends MemoryStore {
      override async transaction<T>(_fn: () => Promise<T>): Promise<T> {
        throw new Error("duplicate secret=super-secret SQL details");
      }
    }
    const store = new FailingStore();
    const handler = makeHandler(store, new Map([["user=1", "user-a"]]), {
      log: (event) => events.push(event),
    });
    const response = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "user=1",
      body: characterInput,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("super-secret");
    expect(response.json()).toEqual({
      error: "CHARACTER_CREATION_FAILED",
      requestId: expect.any(String),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: "character creation failed",
        kind: "CHARACTER_CREATION_FAILED",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("rejects cross-user ownership mutations", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    const sessions = new Map<string, string | null>([["b=1", "user-b"]]);
    const handler = makeHandler(store, sessions);
    const patched = await invoke(handler, `/characters/${moss.id}`, {
      method: "PATCH",
      cookie: "b=1",
      body: { paused: true },
    });
    expect(patched.statusCode).toBe(404);
    expect((await store.getCharacter(moss.id))?.paused).toBe(false);
  });

  it("rejects admin routes for ordinary users and allows admins", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([
      ["user=1", "user-a"],
      ["admin=1", "admin-1"],
    ]);
    const handler = makeHandler(store, sessions);
    const denied = await invoke(handler, "/admin", { cookie: "user=1" });
    expect(denied.statusCode).toBe(403);
    const allowed = await invoke(handler, "/admin", { cookie: "admin=1" });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().queueDepth).toBe(0);
  });

  it("rejects job runs without the cron secret", async () => {
    const store = new MemoryStore();
    const handler = makeHandler(store, new Map());
    const denied = await invoke(handler, "/jobs/run", { method: "POST" });
    expect(denied.statusCode).toBe(401);
    const allowed = await invoke(handler, "/jobs/run", {
      method: "POST",
      authorization: "Bearer cron-secret",
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("hosted queue and transaction semantics", () => {
  it("keeps the Postgres SKIP LOCKED claim shape", () => {
    expect(CLAIM_JOB_SQL).toContain("FOR UPDATE SKIP LOCKED");
    expect(CLAIM_JOB_SQL).toContain("status = 'processing'");
    expect(CLAIM_JOB_SQL).toContain("LIMIT $3");
  });

  it("lets only one concurrent claim win a pending job", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss");
    await store.enqueueJob({
      id: "job-1",
      characterId: character.id,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: "tick",
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const [first, second] = await Promise.all([
      store.transaction(() => store.claimNextJob(Date.now(), 120_000)),
      store.transaction(() => store.claimNextJob(Date.now(), 120_000)),
    ]);
    const won = [first, second].filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]?.id).toBe("job-1");
    expect((await store.getJob("job-1"))?.status).toBe("processing");
  });

  it("claims a batch of pending jobs in one SKIP LOCKED pass", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss");
    for (const id of ["job-a", "job-b", "job-c"]) {
      await store.enqueueJob({
        id,
        characterId: character.id,
        kind: "tick",
        payload: {},
        priority: 10,
        dedupeKey: id,
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    }
    const claimed = await store.claimJobs(Date.now(), 120_000, 2);
    expect(claimed.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect((await store.getJob("job-c"))?.status).toBe("pending");
  });

  it("prunes completed queue rows, extra artifacts, and old conversations", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss");
    await store.enqueueJob({
      id: "done",
      characterId: character.id,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: null,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const job = await store.claimNextJob(Date.now(), 120_000);
    expect(job?.id).toBe("done");
    await store.completeJob("done");
    expect(await store.getJob("done")).toBeNull();
    await store.jobs.set("leftover", {
      id: "leftover",
      characterId: character.id,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: null,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
      status: "completed",
      attemptCount: 1,
      createdAt: Date.now(),
    });
    expect(await store.pruneQueue()).toBe(1);
    expect(await store.getJob("leftover")).toBeNull();
    for (let index = 0; index < 85; index += 1) {
      await store.addArtifact({
        id: `note-${index}`,
        locationId: "plaza",
        characterId: character.id,
        characterName: "Moss",
        kind: "note",
        title: `Note ${index}`,
        body: "Left behind.",
        x: 455,
        y: 275,
        createdAt: 1_000 + index,
      });
    }
    expect((await store.listArtifacts()).length).toBe(80);
    await store.insertConversation(
      {
        id: "old-chat",
        characterAId: character.id,
        characterBId: "other",
        status: "active",
        messageCount: 1,
        visibility: "public",
        locationId: "plaza",
        startedAt: 1_000,
      },
      [character.id],
    );
    await store.addConversationMessage({
      id: "msg-1",
      conversationId: "old-chat",
      characterId: character.id,
      characterName: "Moss",
      turn: 1,
      text: "Hello",
      createdAt: 1_000,
    });
    const pruned = await store.pruneConversations(100_000, 10, 1_000);
    expect(pruned).toBe(1);
    expect(store.conversations.has("old-chat")).toBe(false);
    expect(store.messages).toHaveLength(0);
  });

  it("recovers stale processing jobs so a later worker can claim them", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss");
    await store.enqueueJob({
      id: "stale",
      characterId: character.id,
      kind: "tick",
      payload: {},
      priority: 10,
      dedupeKey: "tick",
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const now = Date.now();
    await store.claimNextJob(now - 200_000, 120_000);
    expect((await store.getJob("stale"))?.status).toBe("processing");
    const recovered = await store.recoverStaleJobs(now);
    expect(recovered).toBe(1);
    const claimed = await store.claimNextJob(now, 120_000);
    expect(claimed?.id).toBe("stale");
  });

  it("enforces unique names inside a transaction", async () => {
    const store = new MemoryStore();
    const now = Date.now();
    const make = (id: string) =>
      seedCharacter(store, id, "Moss", now).then(
        () => "ok" as const,
        (error) => String(error),
      );
    const results = await Promise.all([
      store.transaction(() => make("user-a")),
      store.transaction(() => make("user-b")),
    ]);
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(
      (await store.countOwned("user-a")) + (await store.countOwned("user-b")),
    ).toBe(1);
  });

  it("does not process the same job twice after completion", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss");
    await store.enqueueJob({
      id: "once",
      characterId: character.id,
      kind: "owner_directive",
      payload: { text: "Wave at the fountain" },
      priority: 50,
      dedupeKey: null,
      notBefore: 0,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const first = await runAutonomy(store, {
      now: () => Date.now(),
      limit: 10,
      leaseMs: 120_000,
      maxAttempts: 5,
      eventKeep: 50,
      eventMaxAgeMs: 86_400_000,
      log: () => undefined,
    });
    const second = await runAutonomy(store, {
      now: () => Date.now(),
      limit: 10,
      leaseMs: 120_000,
      maxAttempts: 5,
      eventKeep: 50,
      eventMaxAgeMs: 86_400_000,
      log: () => undefined,
    });
    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(await store.getJob("once")).toBeNull();
  });

  it("exports memories for one character id only", async () => {
    class SpyStore extends MemoryStore {
      memoryIds: string[] = [];
      override async listMemories(options: {
        characterId: string;
        perCharacterLimit?: number;
      }) {
        this.memoryIds.push(options.characterId);
        return super.listMemories(options);
      }
    }
    const store = new SpyStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    await seedCharacter(store, "user-a", "Juniper");
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions);
    const exported = await invoke(handler, `/characters/${moss.id}/export`, {
      cookie: "a=1",
    });
    expect(exported.statusCode).toBe(200);
    expect(store.memoryIds).toEqual([moss.id]);
  });

  it("point-reads relationships during ticks instead of dumping the table", async () => {
    class SpyStore extends MemoryStore {
      dumps = 0;
      pointReads = 0;
      override async listRelationships(options: {
        characterId: string;
        perCharacterLimit?: number;
      }) {
        this.dumps += 1;
        return super.listRelationships(options);
      }
      override async getRelationship(
        characterId: string,
        otherCharacterId: string,
      ) {
        this.pointReads += 1;
        return super.getRelationship(characterId, otherCharacterId);
      }
    }
    const store = new SpyStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    const juniper = await seedCharacter(store, "user-b", "Juniper");
    await executeJob(
      store,
      {
        id: "meet",
        characterId: moss.id,
        kind: "first_mission",
        payload: { mission: "meet" },
        priority: 100,
        dedupeKey: "first_mission",
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
        status: "processing",
        attemptCount: 1,
        createdAt: Date.now(),
      },
      Date.now(),
    );
    expect(store.dumps).toBe(0);
    expect(store.pointReads).toBeGreaterThan(0);
    const row = await store.getRelationship(moss.id, juniper.id);
    expect(row?.affinity).toBe(2);
  });
});

describe("hosted product surfaces", () => {
  it("hides private conversation lines from spectators", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    const juniper = await seedCharacter(store, "user-b", "Juniper");
    await executeJob(
      store,
      {
        id: "meet",
        characterId: moss.id,
        kind: "first_mission",
        payload: { mission: "meet" },
        priority: 100,
        dedupeKey: "first_mission",
        notBefore: 0,
        expiresAt: Date.now() + 60_000,
        status: "processing",
        attemptCount: 1,
        createdAt: Date.now(),
      },
      Date.now(),
    );
    const publicEvents = await store.listEvents({
      limit: 20,
      viewerCharacterIds: [],
      isAdmin: false,
    });
    expect(
      publicEvents.some((event) => event.summary.includes("started talking")),
    ).toBe(true);
    expect(publicEvents.some((event) => event.visibility === "private")).toBe(
      false,
    );
    const ownerEvents = await store.listEvents({
      limit: 20,
      viewerCharacterIds: [moss.id],
      isAdmin: false,
    });
    expect(ownerEvents.some((event) => event.visibility === "private")).toBe(
      true,
    );
    expect(juniper.id).toBeTruthy();
  });

  it("rate-limits repeated mutations", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions, {
      env: { ...baseEnv, mutationLimit: 2 },
    });
    const first = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: characterInput,
    });
    const second = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: { ...characterInput, name: "Juniper" },
    });
    const third = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: { ...characterInput, name: "Cedar" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
  });

  it("prunes events older than the retention window", async () => {
    const store = new MemoryStore();
    const now = Date.now();
    await store.addEvent({
      id: "old",
      kind: "system",
      characterId: null,
      characterName: null,
      targetCharacterId: null,
      summary: "old",
      detail: null,
      visibility: "public",
      hidden: false,
      conversationId: null,
      createdAt: now - 10_000,
    });
    await store.addEvent({
      id: "new",
      kind: "system",
      characterId: null,
      characterName: null,
      targetCharacterId: null,
      summary: "new",
      detail: null,
      visibility: "public",
      hidden: false,
      conversationId: null,
      createdAt: now,
    });
    const pruned = await store.pruneEvents(now, 10, 5_000);
    expect(pruned).toBe(1);
    const remaining = await store.listEvents({
      limit: 10,
      viewerCharacterIds: [],
      isAdmin: true,
    });
    expect(remaining.map((event) => event.id)).toEqual(["new"]);
  });

  it("exports and imports a character for the same owner", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions);
    const created = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: characterInput,
    });
    expect(created.statusCode).toBe(201);
    const exported = await invoke(
      handler,
      `/characters/${created.json().id}/export`,
      {
        cookie: "a=1",
      },
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.json().version).toBe(1);
    const imported = await invoke(handler, "/characters/import", {
      method: "POST",
      cookie: "a=1",
      body: exported.json(),
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().name).not.toBe(created.json().name);
    expect(await store.countOwned("user-a")).toBe(2);
  });

  it("caps accounts at the configured character limit", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions, {
      env: { ...baseEnv, maxCharactersPerUser: 1 },
    });
    const first = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: characterInput,
    });
    const second = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: { ...characterInput, name: "Juniper" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
  });

  it("blocks character creation when invite-only and the user is not listed", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions, {
      env: { ...baseEnv, inviteOnly: true, inviteUserIds: ["someone-else"] },
    });
    const created = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: characterInput,
    });
    expect(created.statusCode).toBe(403);
  });

  it("keeps health and spectator state up when ensureSchema throws", async () => {
    class BrokenSchemaStore extends MemoryStore {
      override async ensureSchema(): Promise<void> {
        throw new Error("wallet ddl failed");
      }
    }
    const store = new BrokenSchemaStore();
    await seedCharacter(store, "user-a", "Moss");
    const handler = makeHandler(store, new Map());
    const health = await invoke(handler, "/health");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      ok: true,
      dependencies: { database: "ok", auth: "configured" },
    });
    const state = await invoke(handler, "/state");
    expect(state.statusCode).toBe(200);
    expect(state.json().snapshot.characters).toHaveLength(1);
  });

  it("recovers health after ensureSchema when the first world probe fails", async () => {
    class FlakyStore extends MemoryStore {
      probes = 0;
      override async getWorldState() {
        this.probes += 1;
        if (this.probes === 1)
          throw new Error("relation world_state does not exist");
        return super.getWorldState();
      }
    }
    const health = await invoke(
      makeHandler(new FlakyStore(), new Map()),
      "/health",
    );
    expect(health.statusCode).toBe(200);
    expect(health.json().dependencies.database).toBe("ok");
  });

  it("returns honest 503 health when the world database probe fails", async () => {
    class DownStore extends MemoryStore {
      override async getWorldState(): Promise<never> {
        throw new Error("db down");
      }
      override async ensureSchema(): Promise<void> {
        throw new Error("db down");
      }
    }
    const health = await invoke(
      makeHandler(new DownStore(), new Map()),
      "/health",
    );
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({
      ok: false,
      dependencies: { database: "error", auth: "configured" },
    });
  });

  it("returns 503 DATABASE_UNAVAILABLE for state when Neon quota is exceeded", async () => {
    class QuotaStore extends MemoryStore {
      override async getWorldState(): Promise<never> {
        throw new Error(
          'Server error (HTTP status 402): {"message":"Your project has exceeded the data transfer quota."}',
        );
      }
    }
    const state = await invoke(
      makeHandler(new QuotaStore(), new Map()),
      "/state",
    );
    expect(state.statusCode).toBe(503);
    expect(state.json().error).toBe("DATABASE_UNAVAILABLE");
  });

  it("does not retry schema ensure on Neon quota errors", async () => {
    class QuotaStore extends MemoryStore {
      ensured = 0;
      override async getWorldState(): Promise<never> {
        throw new Error("Server error (HTTP status 402): data transfer quota");
      }
      override async ensureSchema(): Promise<void> {
        this.ensured += 1;
      }
    }
    const store = new QuotaStore();
    const health = await invoke(makeHandler(store, new Map()), "/health");
    expect(health.statusCode).toBe(503);
    expect(store.ensured).toBe(0);
  });

  it("auth-gates wallet routes instead of returning INTERNAL_ERROR when schema ensure fails", async () => {
    class BrokenSchemaStore extends MemoryStore {
      override async ensureSchema(): Promise<void> {
        throw new Error("wallet ddl failed");
      }
    }
    const store = new BrokenSchemaStore();
    const handler = makeHandler(store, new Map(), {
      payments: new PaymentService(store, new ToolRegistry()),
    });
    const wallet = await invoke(handler, "/wallet");
    expect(wallet.statusCode).toBe(401);
    expect(wallet.json().error).not.toBe("INTERNAL_ERROR");
  });

  it("does not run ensureSchema on spectator GET /state", async () => {
    class SpyStore extends MemoryStore {
      ensures = 0;
      override async ensureSchema(): Promise<void> {
        this.ensures += 1;
      }
    }
    const store = new SpyStore();
    await seedCharacter(store, "user-a", "Moss", 1_000);
    const handler = makeHandler(store, new Map());
    const state = await invoke(handler, "/state");
    expect(state.statusCode).toBe(200);
    expect(store.ensures).toBe(0);
    const drained = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(drained.statusCode).toBe(200);
    expect(store.ensures).toBeGreaterThan(0);
  });

  it("keeps spectator state read-only without draining jobs or writing presence", async () => {
    class SpyStore extends MemoryStore {
      presenceWrites = 0;
      dueReads = 0;
      walletEnsures = 0;
      override async touchPresence(): Promise<void> {
        this.presenceWrites += 1;
      }
      override async dueCharacterIds(now: number) {
        this.dueReads += 1;
        return super.dueCharacterIds(now);
      }
      override async countDueJobs(now: number) {
        this.dueReads += 1;
        return super.countDueJobs(now);
      }
      override async ensureWalletSchema(): Promise<void> {
        this.walletEnsures += 1;
      }
    }
    const store = new SpyStore();
    const moss = await seedCharacter(store, "user-a", "Moss", 1_000);
    await store.updateCharacter(moss.id, { nextDecisionAt: 1_000 });
    const handler = makeHandler(store, new Map(), { now: () => 5_000 });
    const state = await invoke(handler, "/state");
    expect(state.statusCode).toBe(200);
    expect(state.json().snapshot.connectedViewers).toBe(0);
    expect(store.presenceWrites).toBe(0);
    expect(store.dueReads).toBe(0);
    expect(store.walletEnsures).toBe(0);
    const row = await store.getCharacter(moss.id);
    expect(row?.updatedAt).toBe(1_000);
    expect(row?.nextDecisionAt).toBe(1_000);
    const drained = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(drained.statusCode).toBe(200);
    expect(drained.json().processed).toBeGreaterThan(0);
    const after = await store.getCharacter(moss.id);
    expect(after?.updatedAt).toBe(5_000);
  });

  it("spaces /jobs/run world ticks by AGENT_WORLD_TICK_INTERVAL_MIN", async () => {
    class SpyStore extends MemoryStore {
      claims = 0;
      override async claimJobs(now: number, leaseMs: number, limit: number) {
        this.claims += 1;
        return super.claimJobs(now, leaseMs, limit);
      }
    }
    const store = new SpyStore();
    const moss = await seedCharacter(store, "user-a", "Moss", 1_000);
    await store.updateCharacter(moss.id, { nextDecisionAt: 1_000 });
    let now = 10_000;
    const handler = makeHandler(store, new Map(), {
      now: () => now,
      env: parseEnv({
        NEON_AUTH_BASE_URL: "https://auth.example.test",
        CRON_SECRET: "cron-secret",
        AGENT_WORLD_TICK_INTERVAL_MIN: "30",
      }),
    });
    const first = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().skipped).toBe(false);
    expect(first.json().processed).toBeGreaterThan(0);
    expect(first.json().tickIntervalMin).toBe(30);
    expect(store.claims).toBe(1);
    const lastTickAt = (await store.getWorldState()).lastTickAt;
    expect(lastTickAt).toBe(10_000);

    const observe = await invoke(handler, "/state");
    expect(observe.statusCode).toBe(200);
    expect((await store.getWorldState()).lastTickAt).toBe(lastTickAt);
    expect((await store.getCharacter(moss.id))?.updatedAt).toBe(10_000);

    now = 10_000 + 10 * 60_000;
    const skipped = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({
      skipped: true,
      processed: 0,
      tickIntervalMin: 30,
      lastTickAt: 10_000,
    });
    expect(store.claims).toBe(1);
    expect((await store.getCharacter(moss.id))?.updatedAt).toBe(10_000);

    now = 10_000 + 30 * 60_000;
    const second = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(second.json().skipped).toBe(false);
    expect(store.claims).toBe(2);
  });

  it("lets owner mutations drain immediately inside the world tick interval", async () => {
    const store = new MemoryStore();
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    let now = 20_000;
    const handler = makeHandler(store, sessions, {
      now: () => now,
      env: parseEnv({
        NEON_AUTH_BASE_URL: "https://auth.example.test",
        CRON_SECRET: "cron-secret",
        AGENT_WORLD_TICK_INTERVAL_MIN: "60",
      }),
    });
    await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect((await store.getWorldState()).lastTickAt).toBe(20_000);
    now = 20_000 + 5 * 60_000;
    const created = await invoke(handler, "/characters", {
      method: "POST",
      cookie: "a=1",
      body: characterInput,
    });
    expect(created.statusCode).toBe(201);
    const row = await store.getCharacter(created.json().id);
    expect(row?.updatedAt).toBe(now);
    expect((await store.getWorldState()).lastTickAt).toBe(20_000);
  });

  it("fails closed to a 10-minute world tick when the env value is invalid", async () => {
    const logs: string[] = [];
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss", 1_000);
    await store.updateCharacter(moss.id, { nextDecisionAt: 1_000 });
    let now = 1_000;
    const handler = makeHandler(store, new Map(), {
      now: () => now,
      env: parseEnv({
        NEON_AUTH_BASE_URL: "https://auth.example.test",
        CRON_SECRET: "cron-secret",
        AGENT_WORLD_TICK_INTERVAL_MIN: "15",
      }),
      log: (event) =>
        logs.push(`${event.level}:${event.kind ?? ""}:${event.msg}`),
    });
    const first = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().tickIntervalMin).toBe(10);
    expect(first.json().skipped).toBe(false);
    expect(logs.some((line) => line.includes("TICK_INTERVAL_INVALID"))).toBe(
      true,
    );
    now = 1_000 + 9 * 60_000;
    const skipped = await invoke(handler, "/jobs/run", {
      authorization: "Bearer cron-secret",
    });
    expect(skipped.json().skipped).toBe(true);
    expect((await store.getCharacter(moss.id))?.updatedAt).toBe(1_000);
  });

  it("returns 304 when spectator state is unchanged", async () => {
    const store = new MemoryStore();
    await seedCharacter(store, "user-a", "Moss", 1_000);
    const handler = makeHandler(store, new Map(), { now: () => 5_000 });
    const first = await invoke(handler, "/state");
    expect(first.statusCode).toBe(200);
    const etag = String(first.headers.etag);
    expect(etag.length).toBeGreaterThan(4);
    const again = await invoke(handler, "/state", { ifNoneMatch: etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    await store.updateCharacter((await store.listCharacters())[0]!.id, {
      intent: "Waving from the plaza",
      updatedAt: 6_000,
    });
    const changed = await invoke(handler, "/state", { ifNoneMatch: etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().snapshot.characters[0].intent).toBe(
      "Waving from the plaza",
    );
  });

  it("omits personality, memories, and relationships from spectator state", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss", 1_000);
    await store.addMemory({
      id: "mem-1",
      characterId: moss.id,
      kind: "fact",
      bullet: "Noticed the plaza fountain",
      subject: "plaza",
      confidence: 0.7,
      active: true,
      createdAt: 1_000,
    });
    await store.upsertRelationship({
      characterId: moss.id,
      otherCharacterId: "other-1",
      impression: "Met a neighbor",
      affinity: 4,
      updatedAt: 1_000,
    });
    const handler = makeHandler(store, new Map(), { now: () => 5_000 });
    const state = await invoke(handler, "/state");
    const character = state.json().snapshot.characters[0];
    expect(character.id).toBe(moss.id);
    expect(character.speech).toBeNull();
    expect(character.personality).toBeUndefined();
    expect(character.memories).toBeUndefined();
    expect(character.relationships).toBeUndefined();
  });

  it("lazy-loads capped personality, memories, and relationships for the inspector", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss", 1_000);
    for (let index = 0; index < 60; index += 1) {
      await store.addMemory({
        id: `mem-${index}`,
        characterId: moss.id,
        kind: "fact",
        bullet: `Noticed landmark ${index}`,
        subject: "plaza",
        confidence: 0.7,
        active: true,
        createdAt: 1_000 + index,
      });
      await store.upsertRelationship({
        characterId: moss.id,
        otherCharacterId: `other-${index}`,
        impression: `Met neighbor ${index}`,
        affinity: index,
        updatedAt: 1_000 + index,
      });
    }
    const handler = makeHandler(store, new Map(), { now: () => 5_000 });
    const inspect = await invoke(handler, `/characters/${moss.id}`);
    expect(inspect.statusCode).toBe(200);
    const character = inspect.json().character;
    expect(character.personality).toBe(moss.personality);
    expect(character.memories).toHaveLength(50);
    expect(character.memories[0].id).toBe("mem-59");
    expect(
      character.memories.some((row: { id: string }) => row.id === "mem-0"),
    ).toBe(false);
    expect(character.relationships).toHaveLength(50);
    expect(
      character.relationships.some(
        (row: { characterId: string }) => row.characterId === "other-59",
      ),
    ).toBe(true);
    expect(
      character.relationships.some(
        (row: { characterId: string }) => row.characterId === "other-0",
      ),
    ).toBe(false);
  });

  it("walks along a persisted movement segment instead of teleporting", async () => {
    const store = new MemoryStore();
    const character = await seedCharacter(store, "user-a", "Moss", 1_000);
    await executeJob(
      store,
      {
        id: "explore",
        characterId: character.id,
        kind: "first_mission",
        payload: { mission: "explore" },
        priority: 100,
        dedupeKey: "first_mission",
        notBefore: 0,
        expiresAt: 60_000,
        status: "processing",
        attemptCount: 1,
        createdAt: 1_000,
      },
      1_000,
    );
    const moved = await store.getCharacter(character.id);
    expect(moved).toBeTruthy();
    expect(moved!.movementArrivesAt).toBeGreaterThan(moved!.movementStartedAt);
    expect(moved!.state).toBe("moving");
    const mid = positionAt(
      moved!,
      Math.floor((moved!.movementStartedAt + moved!.movementArrivesAt) / 2),
    );
    const arrived = positionAt(moved!, moved!.movementArrivesAt);
    expect(arrived.x).toBe(moved!.targetX);
    expect(arrived.y).toBe(moved!.targetY);
    if (moved!.x !== moved!.targetX) expect(mid.x).not.toBe(moved!.targetX);
  });

  it("keeps owner directive text out of the public log", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    const sessions = new Map<string, string | null>([["a=1", "user-a"]]);
    const handler = makeHandler(store, sessions);
    const secret = "Secret park rendezvous at dusk";
    const directed = await invoke(
      handler,
      `/characters/${moss.id}/directives`,
      {
        method: "POST",
        cookie: "a=1",
        body: { mode: "directive", text: secret },
      },
    );
    expect(directed.statusCode).toBe(200);
    const publicEvents = await store.listEvents({
      limit: 20,
      viewerCharacterIds: [],
      isAdmin: false,
    });
    expect(publicEvents.some((event) => event.detail?.includes(secret))).toBe(
      false,
    );
  });

  it("accepts artifacts and reports, and lets admins mute", async () => {
    const store = new MemoryStore();
    const moss = await seedCharacter(store, "user-a", "Moss");
    const sessions = new Map<string, string | null>([
      ["a=1", "user-a"],
      ["admin=1", "admin-1"],
    ]);
    const handler = makeHandler(store, sessions);
    const artifact = await invoke(handler, `/characters/${moss.id}/artifacts`, {
      method: "POST",
      cookie: "a=1",
      body: { kind: "note", title: "A pebble", body: "Warm from the plaza." },
    });
    expect(artifact.statusCode).toBe(201);
    const reported = await invoke(handler, "/reports", {
      method: "POST",
      cookie: "a=1",
      body: { reason: "too loud in the library", characterId: moss.id },
    });
    expect(reported.statusCode).toBe(201);
    const muted = await invoke(handler, `/admin/characters/${moss.id}/mute`, {
      method: "POST",
      cookie: "admin=1",
      body: { muted: true },
    });
    expect(muted.statusCode).toBe(200);
    expect((await store.getCharacter(moss.id))?.muted).toBe(true);
  });
});

describe("shared helpers", () => {
  it("accepts reports and character exports", () => {
    expect(
      ReportSchema.safeParse({ reason: "spammy shouts", characterId: "abc" })
        .success,
    ).toBe(true);
    expect(
      CharacterExportSchema.safeParse({
        version: 1,
        name: "Moss",
        personality: "Curious about tiny gardens",
        model: "z-ai/glm-5.3-flash",
        memories: [],
      }).success,
    ).toBe(true);
    expect(CreateCharacterSchema.safeParse(characterInput).success).toBe(true);
  });

  it("hashes stably and finds locations", () => {
    expect(hashString("Moss")).toBe(hashString("Moss"));
    expect(locationAtPoint(455, 275)?.id).toBe("plaza");
  });

  it("parses admin ids from env", () => {
    expect(isAdmin(parseEnv({ AGENT_WORLD_ADMIN_USER_IDS: "a,b" }), "b")).toBe(
      true,
    );
    expect(isAdmin(parseEnv({}), "b")).toBe(false);
  });

  it("parses world tick interval from env and fails closed on invalid values", () => {
    expect(parseEnv({}).tickIntervalMin).toBe(10);
    expect(parseEnv({}).tickIntervalInvalid).toBe(false);
    expect(
      parseEnv({ AGENT_WORLD_TICK_INTERVAL_MIN: "30" }).tickIntervalMin,
    ).toBe(30);
    expect(
      parseEnv({ AGENT_WORLD_TICK_INTERVAL_MIN: "60" }).tickIntervalInvalid,
    ).toBe(false);
    const invalid = parseEnv({ AGENT_WORLD_TICK_INTERVAL_MIN: "15" });
    expect(invalid.tickIntervalMin).toBe(10);
    expect(invalid.tickIntervalInvalid).toBe(true);
  });
});
