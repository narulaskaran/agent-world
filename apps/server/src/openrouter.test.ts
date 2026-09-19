import { describe, expect, it, vi } from "vitest";
import type { WorldStore } from "@agent-world/db";
import { loadConfig } from "./config.js";
import { OPENROUTER_CHAT_URL, OpenRouterClient } from "./openrouter.js";
import { createServices } from "./services.js";

const KEY = "sk-test-not-real";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("OpenRouterClient", () => {
  it("posts chat completions with Bearer auth and parses usage.cost", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(OPENROUTER_CHAT_URL);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
        expect(headers.get("x-title")).toBe("Agent World");
        return jsonResponse(200, {
          choices: [
            { message: { content: '{"action":"idle","intent":"hi"}' } },
          ],
          usage: { cost: 0.00125 },
        });
      },
    );
    const client = new OpenRouterClient({ apiKey: KEY, fetch: fetchMock });
    const result = await client.chat({ model: "z-ai/glm-5.3-flash" });
    expect(result.metadata.transport).toBe("openrouter");
    expect(result.amountMicros).toBe(1_250);
  });

  it("returns null amountMicros when usage.cost is missing", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetch: async () =>
        jsonResponse(200, { choices: [{ message: { content: "{}" } }] }),
    });
    const result = await client.chat({});
    expect(result.amountMicros).toBeNull();
  });

  it("maps HTTP errors without leaking the key", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetch: async () =>
        jsonResponse(401, { error: { message: `Invalid key ${KEY}` } }),
    });
    await expect(client.chat({})).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.startsWith("OpenRouter 401:") &&
        message.includes("Invalid key") &&
        !message.includes(KEY)
      );
    });
  });

  it("pauses an endpoint after two non-auth failures", async () => {
    let now = 1_000;
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { error: { message: "upstream" } }),
    );
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetch: fetchMock,
      now: () => now,
    });
    await expect(client.chat({})).rejects.toThrow("OpenRouter 500:");
    await expect(client.chat({})).rejects.toThrow("OpenRouter 500:");
    await expect(client.chat({})).rejects.toThrow(
      "OpenRouter paused after repeated failures",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 60_000;
    await expect(client.chat({})).rejects.toThrow("OpenRouter 500:");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("PaidServices OpenRouter LLM path", () => {
  const repository = {
    reserveCost: vi.fn(() => "reservation"),
    settleCost: vi.fn(),
    releaseCost: vi.fn(),
  } as unknown as WorldStore;

  const context = {
    id: "moss",
    name: "Moss",
    personality: "Curious about tiny gardens and gentle conversations.",
    model: "z-ai/glm-5.3-flash",
    intent: "Looking around",
    position: { x: 1, y: 1 },
    area: {
      id: "plaza",
      name: "Sunbeam Plaza",
      description: "Center",
      proximity: "inside",
    },
    locations: [],
    nearby: [],
    memories: [],
    recentEvents: [],
    capabilities: [],
    directive: "look around",
  };

  it("returns the model message and settles the parsed cost", async () => {
    repository.reserveCost = vi.fn(() => "reservation");
    repository.settleCost = vi.fn();
    repository.releaseCost = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "idle",
                intent: "Watching the plaza",
              }),
            },
          },
        ],
        usage: { cost: 0.002 },
      }),
    );
    const services = createServices(
      repository,
      loadConfig({ OPENROUTER_API_KEY: KEY }),
      { fetch: fetchMock },
    );
    const result = await services.decide(context);
    expect(result.value.intent).toBe("Watching the plaza");
    expect(result.costMicros).toBe(2_000);
    expect(repository.settleCost).toHaveBeenCalledWith(
      "reservation",
      2_000,
      expect.objectContaining({ transport: "openrouter" }),
      expect.any(Number),
    );
  });

  it("settles the reserved maximum when usage.cost is missing", async () => {
    repository.reserveCost = vi.fn(() => "reservation");
    repository.settleCost = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({ action: "idle", intent: "ok" }),
            },
          },
        ],
      }),
    );
    const services = createServices(
      repository,
      loadConfig({ OPENROUTER_API_KEY: KEY }),
      { fetch: fetchMock },
    );
    const result = await services.decide(context);
    expect(result.costMicros).toBe(5_000);
    expect(repository.settleCost).toHaveBeenCalledWith(
      "reservation",
      5_000,
      expect.objectContaining({ transport: "openrouter" }),
      expect.any(Number),
    );
  });

  it("throws on 401/402/429, releases the reservation, and hides the key", async () => {
    for (const status of [401, 402, 429]) {
      const releaseCost = vi.fn();
      const settleCost = vi.fn();
      const repo = {
        reserveCost: vi.fn(() => "reservation"),
        settleCost,
        releaseCost,
      } as unknown as WorldStore;
      const fetchMock = vi.fn(async () =>
        jsonResponse(status, { error: { message: `denied ${KEY}` } }),
      );
      const services = createServices(
        repo,
        loadConfig({ OPENROUTER_API_KEY: KEY }),
        { fetch: fetchMock },
      );
      await expect(services.decide(context)).rejects.toSatisfy(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          return (
            message.includes(`OpenRouter ${status}:`) && !message.includes(KEY)
          );
        },
      );
      expect(releaseCost).toHaveBeenCalled();
      expect(settleCost).not.toHaveBeenCalled();
    }
  });

  it("uses the deterministic fallback when no key is set and never fetches", async () => {
    const fetchMock = vi.fn();
    const settleCost = vi.fn();
    const repo = {
      reserveCost: vi.fn(() => "reservation"),
      settleCost,
      releaseCost: vi.fn(),
    } as unknown as WorldStore;
    const services = createServices(repo, loadConfig({}), { fetch: fetchMock });
    const result = await services.decide(context);
    expect(result.value.action).toBe("move");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settleCost).toHaveBeenCalledWith(
      "reservation",
      250,
      { mode: "deterministic" },
      expect.any(Number),
    );
  });

  it("pauses after two failures without calling fetch during the cooldown", async () => {
    let now = 10_000;
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { error: { message: "boom" } }),
    );
    const services = createServices(
      {
        reserveCost: vi.fn(() => "reservation"),
        settleCost: vi.fn(),
        releaseCost: vi.fn(),
      } as unknown as WorldStore,
      loadConfig({ OPENROUTER_API_KEY: KEY }),
      { fetch: fetchMock, now: () => now },
    );
    await expect(services.decide(context)).rejects.toThrow("OpenRouter 500:");
    await expect(services.decide(context)).rejects.toThrow("OpenRouter 500:");
    await expect(services.decide(context)).rejects.toThrow(
      "OpenRouter paused after repeated failures",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
