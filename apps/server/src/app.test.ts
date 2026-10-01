import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldRepository } from "@agent-world/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LocalRuntime } from "./local-runtime.js";
import { createServices } from "./services.js";

const VALID_CHARACTER = {
  name: "Moss",
  personality: "Curious about tiny gardens and gentle conversations.",
  model: "z-ai/glm-5.3-flash",
  dailyBudgetMicros: 500_000,
  decisionIntervalSeconds: 60,
  firstMission: "meet" as const,
};

describe("createApp", () => {
  let repository: WorldRepository;
  let runtime: LocalRuntime;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    process.env.AGENT_WORLD_LIVE_MPP = "false";
    repository = new WorldRepository(":memory:");
    runtime = new LocalRuntime(repository);
    app = await createApp({ runtime, logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      liveMpp: false,
      mode: { decisions: "deterministic" },
    });
  });

  it("creates a character that appears in /api/state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe("Moss");

    const state = await app.inject({ method: "GET", url: "/api/state" });
    expect(state.statusCode).toBe(200);
    const names = (state.json().characters as Array<{ name: string }>).map(
      (character) => character.name,
    );
    expect(names).toContain("Moss");
  });

  it("inspects a character by name and 404s when missing", async () => {
    await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    const found = await app.inject({
      method: "GET",
      url: "/api/characters/Moss",
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      character: { name: string; reputation: number; personality: string };
    };
    expect(body.character.name).toBe("Moss");
    expect(body.character.personality).toContain("tiny gardens");
    expect(body.character.reputation).toBe(0);

    const missing = await app.inject({
      method: "GET",
      url: "/api/characters/nobody",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects an invalid create payload with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a duplicate name with 409", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects requests from other origins, including WebSocket upgrades", async () => {
    const evil = await app.inject({
      method: "POST",
      url: "/api/admin/reset",
      headers: { origin: "https://evil.example" },
      payload: { confirm: "reset" },
    });
    expect(evil.statusCode).toBe(403);
    const socket = await app.inject({
      method: "GET",
      url: "/ws",
      headers: {
        origin: "https://evil.example",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(socket.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: "GET",
      url: "/api/state",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.statusCode).toBe(403);
    const sameOrigin = await app.inject({
      method: "GET",
      url: "/api/state",
      headers: { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" },
    });
    expect(sameOrigin.statusCode).toBe(200);
    const devClient = await app.inject({
      method: "GET",
      url: "/api/state",
      headers: { origin: "http://127.0.0.1:4311" },
    });
    expect(devClient.statusCode).toBe(200);
  });

  it("rejects DNS-rebinding hosts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin",
      headers: { host: "attacker.example:4310" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires explicit bodies for pause and reset", async () => {
    await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    const emptyPause = await app.inject({
      method: "POST",
      url: "/api/admin/pause",
    });
    expect(emptyPause.statusCode).toBe(400);
    const pause = await app.inject({
      method: "POST",
      url: "/api/admin/pause",
      payload: { paused: true },
    });
    expect(pause.statusCode).toBe(200);
    expect(repository.getWorldState().simulationPaused).toBe(true);

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/admin/reset",
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(repository.listPublicCharacters()).toHaveLength(1);
    const reset = await app.inject({
      method: "POST",
      url: "/api/admin/reset",
      payload: { confirm: "reset" },
    });
    expect(reset.statusCode).toBe(200);
    expect(repository.listPublicCharacters()).toHaveLength(0);
  });

  it("changes world speed and budget at runtime", async () => {
    const empty = await app.inject({
      method: "PATCH",
      url: "/api/admin",
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin",
      payload: { decisionScale: 5, serverDailyBudgetMicros: 2_000_000 },
    });
    expect(response.statusCode).toBe(200);
    const state = (
      await app.inject({ method: "GET", url: "/api/state" })
    ).json();
    expect(state.decisionScale).toBe(5);
    expect(state.serverDailyBudgetMicros).toBe(2_000_000);
  });

  it("seeds the starter cast and serves a recap", async () => {
    const since = Date.now() - 1;
    const seeded = await app.inject({ method: "POST", url: "/api/admin/seed" });
    expect(seeded.json()).toEqual({ created: 3 });
    const recap = await app.inject({
      method: "GET",
      url: `/api/recap?since=${since}`,
    });
    expect(recap.statusCode).toBe(200);
    expect(recap.json().arrivals).toBe(3);
    const bad = await app.inject({ method: "GET", url: "/api/recap" });
    expect(bad.statusCode).toBe(400);
  });

  it("serves avatars by URL instead of embedding them in snapshots", async () => {
    await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: VALID_CHARACTER,
    });
    const moss = repository.getCharacter("Moss")!;
    repository.updateCharacter(moss.id, {
      avatarUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
    });
    const state = (
      await app.inject({ method: "GET", url: "/api/state" })
    ).json();
    const avatarUrl = state.characters[0].avatarUrl as string;
    expect(avatarUrl).toMatch(/^\/api\/characters\/.+\/avatar\?v=/);
    const image = await app.inject({ method: "GET", url: avatarUrl });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.body).toBe("png-bytes");
  });
});

describe("GET /health key hygiene", () => {
  it("never contains configured key strings", async () => {
    const secret = "sk-test-not-real";
    const repository = new WorldRepository(":memory:");
    const config = loadConfig({
      OPENROUTER_API_KEY: secret,
      AGENT_WORLD_LIVE_MPP: "false",
    });
    const runtime = new LocalRuntime(
      repository,
      createServices(repository, config, {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );
    const app = await createApp({ runtime, logger: false, config });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("OPENROUTER_API_KEY");
      expect(response.json()).toMatchObject({
        ok: true,
        mode: { decisions: "jev" },
      });
    } finally {
      await app.close();
    }
  });
});
