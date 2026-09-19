import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldRepository } from "@agent-world/db";
import { createApp } from "./app.js";
import { LocalRuntime } from "./local-runtime.js";

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
    expect(response.json()).toMatchObject({ ok: true, liveMpp: false });
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
});
