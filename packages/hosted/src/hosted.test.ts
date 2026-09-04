import { describe, expect, it } from "vitest";
import {
  CharacterExportSchema,
  CreateCharacterSchema,
  ReportSchema,
  hashString,
  locationAtPoint,
} from "../../shared/src/index.js";
import { createHandler, isAdmin, parseEnv } from "./handler.js";
import { executeJob, runAutonomy } from "./jobs.js";
import { MemoryStore } from "./memory-store.js";
import { CLAIM_JOB_SQL } from "./store.js";
import type { HostedDeps, Request as HandlerRequest, Response } from "./handler.js";
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
    fetch: (async () => new globalThis.Response("{}", { status: 200 })) as typeof fetch,
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
  } = {},
) => {
  const response = new MockResponse();
  const headers: HandlerRequest["headers"] = {
    host: "agent-world.example",
    origin: "https://agent-world.example",
  };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
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
    expect(await store.countOwned("user-a") + await store.countOwned("user-b")).toBe(1);
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
    expect((await store.getJob("once"))?.status).toBe("completed");
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
    expect(publicEvents.some((event) => event.summary.includes("started talking"))).toBe(true);
    expect(publicEvents.some((event) => event.visibility === "private")).toBe(false);
    const ownerEvents = await store.listEvents({
      limit: 20,
      viewerCharacterIds: [moss.id],
      isAdmin: false,
    });
    expect(ownerEvents.some((event) => event.visibility === "private")).toBe(true);
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
    const exported = await invoke(handler, `/characters/${created.json().id}/export`, {
      cookie: "a=1",
    });
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
});
