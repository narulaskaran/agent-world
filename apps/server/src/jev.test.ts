import { describe, expect, it, vi } from "vitest";
import type { WorldStore } from "@agent-world/db";
import { loadConfig } from "./config.js";
import {
  buildJevBody,
  jevCostMicros,
  JevDecider,
  mapJevDecision,
} from "./jev.js";
import {
  OPENROUTER_CHAT_URL,
  OPENROUTER_DECISIONS_URL,
  OpenRouterClient,
} from "./openrouter.js";
import { createServices, type AgentContext } from "./services.js";

const KEY = "sk-test-not-real";
const PRIVATE_LINE = "SECRET_CONVERSATION_LINE_DO_NOT_SEND";
const LLM_INTENT = "LLM-fallback";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  id: "moss",
  name: "Moss",
  personality: "Curious about tiny gardens",
  model: "z-ai/glm-5.3-flash",
  intent: "Looking around",
  position: { x: 455, y: 275 },
  area: {
    id: "plaza",
    name: "Sunbeam Plaza",
    description: "The social center of Agent World.",
    proximity: "inside",
  },
  locations: [],
  nearby: [
    {
      id: "juniper",
      name: "Juniper",
      distance: 12,
      state: "active",
      locationId: "plaza",
    },
    {
      id: "fern",
      name: "Fern",
      distance: 20,
      state: "active",
      locationId: "plaza",
    },
  ],
  memories: [
    {
      kind: "fact",
      bullet: "Juniper likes unusual stories.",
      subject: "Juniper",
    },
  ],
  relationships: [
    { name: "Juniper", impression: "Warm and curious", affinity: 40 },
  ],
  recentEvents: ["Moss entered Sunbeam Plaza."],
  conversationHistory: [PRIVATE_LINE],
  conversationPurpose: "A private topic",
  capabilities: ["Move to or inspect a listed location"],
  ...overrides,
});

const repository = () => {
  const reserveCost = vi.fn(() => "reservation");
  const settleCost = vi.fn();
  const releaseCost = vi.fn();
  return {
    mock: { reserveCost, settleCost, releaseCost },
    store: { reserveCost, settleCost, releaseCost } as unknown as WorldStore,
  };
};

const llmBody = {
  choices: [
    { message: { content: `{"action":"idle","intent":"${LLM_INTENT}"}` } },
  ],
  usage: { cost: 0.001 },
};

const jevAnswers = (
  answers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: "dec_test",
  model: "typesafe/jev-1.13-test",
  provider: "TypeSafe",
  answers,
  usage: { input_tokens: 476, output_tokens: 12, cost: 0.000019992 },
  ...extra,
});

const routeFetch = (options: {
  decisions?: (init?: RequestInit) => Promise<Response> | Response;
  chat?: (init?: RequestInit) => Promise<Response> | Response;
  calls?: { url: string; body: unknown }[];
}) => {
  const calls = options.calls ?? [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (url === OPENROUTER_DECISIONS_URL) {
        if (!options.decisions) throw new Error("unexpected decisions call");
        return options.decisions(init);
      }
      if (url === OPENROUTER_CHAT_URL) {
        if (!options.chat) throw new Error("unexpected chat call");
        return options.chat(init);
      }
      throw new Error(`unexpected url ${url}`);
    },
  );
  return { fetchMock, calls };
};

const servicesFor = (
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined> = { OPENROUTER_API_KEY: KEY },
  now?: () => number,
) => {
  const repo = repository();
  const services = createServices(repo.store, loadConfig(env), {
    fetch: fetchImpl,
    now,
  });
  return { services, repo };
};

describe("jevCostMicros", () => {
  it("ceils usage.cost dollars to micros with a 1-micro floor", () => {
    expect(jevCostMicros({ usage: { cost: 0.000019992 } }, {})).toBe(20);
    expect(jevCostMicros({ usage: { cost: 0 } }, { model: "x" })).toBe(1);
  });

  it("falls back to input tokens then request size", () => {
    expect(jevCostMicros({ usage: { input_tokens: 476 } }, {})).toBe(20);
    const request = {
      model: "typesafe/jev-1.13",
      state: { k: "v" },
      questions: {},
    };
    expect(jevCostMicros({}, request)).toBe(
      Math.max(1, Math.ceil((JSON.stringify(request).length / 4) * 0.042)),
    );
  });
});

describe("JEV request shape", () => {
  it("omits talk when nobody available and never includes private conversation text", () => {
    const body = buildJevBody(
      context({
        nearby: [
          { id: "sleepy", name: "Sleepy", distance: 4, state: "sleeping" },
          { id: "busy", name: "Busy", distance: 5, state: "talking" },
          { id: "halt", name: "Halt", distance: 6, state: "paused" },
        ],
      }),
      "typesafe/jev-1.13",
    );
    expect(body.questions.action.criteria.talk).toBeUndefined();
    expect(body.questions.partner).toBeUndefined();
    expect(body.questions.walk_to.criteria.plaza).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(PRIVATE_LINE);
    expect("messages" in body).toBe(false);
  });
});

describe("mapJevDecision", () => {
  it("maps talk, walk, and inspect onto local actions with templated intents", () => {
    const base = context();
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "talk", confidence: 0.9 },
          partner: { type: "choice", choice: "Juniper", confidence: 0.8 },
        }),
        base,
      ),
    ).toEqual({
      action: "approach",
      targetCharacterId: "juniper",
      intent: "Ask Juniper what they have noticed around Sunbeam Plaza",
    });
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "walk", confidence: 0.9 },
          walk_to: { type: "choice", choice: "library", confidence: 0.7 },
        }),
        base,
      ),
    ).toEqual({
      action: "move",
      locationId: "library",
      intent: "Exploring The Memory Stack",
    });
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "inspect", confidence: 0.9 },
          inspect_what: { type: "choice", choice: "plaza", confidence: 0.7 },
        }),
        base,
      ),
    ).toEqual({
      action: "inspect_location",
      locationId: "plaza",
      intent: "Looking around Sunbeam Plaza",
    });
  });

  it("returns null for low confidence, unknown choices, and unexpected shapes", () => {
    const base = context();
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "walk", confidence: 0.1 },
        }),
        base,
      ),
    ).toBeNull();
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "teleport", confidence: 1 },
        }),
        base,
      ),
    ).toBeNull();
    expect(
      mapJevDecision(
        jevAnswers({
          action: { type: "choice", choice: "walk", confidence: 0.9 },
          walk_to: { type: "choice", choice: "plaza", confidence: 0.9 },
        }),
        base,
      ),
    ).toBeNull();
    expect(mapJevDecision({ answers: "nope" }, base)).toBeNull();
    expect(mapJevDecision("not-json-object", base)).toBeNull();
    expect(mapJevDecision({}, base)).toBeNull();
  });
});

describe("PaidServices JEV decisions", () => {
  it("posts to the Decisions API with Bearer auth, model, state, and questions", async () => {
    const { fetchMock, calls } = routeFetch({
      decisions: () =>
        jsonResponse(
          200,
          jevAnswers({
            action: { type: "choice", choice: "talk", confidence: 0.9 },
            partner: { type: "choice", choice: "Juniper", confidence: 0.8 },
          }),
        ),
    });
    const { services, repo } = servicesFor(fetchMock);
    const result = await services.decide(context());
    expect(result.value).toEqual({
      action: "approach",
      targetCharacterId: "juniper",
      intent: "Ask Juniper what they have noticed around Sunbeam Plaza",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(OPENROUTER_DECISIONS_URL);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toMatchObject({
      model: "typesafe/jev-1.13",
      questions: expect.any(Object),
      state: expect.any(Object),
    });
    expect(calls[0]?.body).not.toHaveProperty("messages");
    expect(JSON.stringify(calls[0]?.body)).not.toContain(PRIVATE_LINE);
    expect(
      Object.keys(
        (calls[0]?.body as { questions: { partner: { criteria: object } } })
          .questions.partner.criteria,
      ),
    ).toEqual(["Juniper", "Fern"]);
    expect(repo.mock.reserveCost).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "inference",
        provider: "openrouter-jev",
        maxMicros: 300,
        countAgainstCharacter: true,
      }),
    );
    expect(repo.mock.settleCost).toHaveBeenCalledWith(
      "reservation",
      20,
      expect.objectContaining({ provider: "openrouter-jev" }),
      expect.any(Number),
    );
  });

  it("maps walk and inspect through PaidServices without calling chat", async () => {
    for (const [answers, expected] of [
      [
        {
          action: { type: "choice", choice: "walk", confidence: 0.9 },
          walk_to: { type: "choice", choice: "library", confidence: 0.7 },
        },
        {
          action: "move",
          locationId: "library",
          intent: "Exploring The Memory Stack",
        },
      ],
      [
        {
          action: { type: "choice", choice: "inspect", confidence: 0.9 },
          inspect_what: { type: "choice", choice: "cafe", confidence: 0.7 },
        },
        {
          action: "inspect_location",
          locationId: "cafe",
          intent: "Looking around The Tiny Cup",
        },
      ],
    ] as const) {
      const { fetchMock } = routeFetch({
        decisions: () => jsonResponse(200, jevAnswers(answers)),
      });
      const { services } = servicesFor(fetchMock);
      expect((await services.decide(context())).value).toEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("falls through to the LLM when JEV is low-confidence, invalid, or malformed", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () =>
        jsonResponse(
          200,
          jevAnswers({
            action: { type: "choice", choice: "walk", confidence: 0.1 },
          }),
        ),
      async () =>
        jsonResponse(
          200,
          jevAnswers({
            action: { type: "choice", choice: "teleport", confidence: 1 },
          }),
        ),
      async () => jsonResponse(200, { answers: null }),
      async () => jsonResponse(200, { id: "x" }),
    ];
    for (const decisions of cases) {
      const { fetchMock, calls } = routeFetch({
        decisions,
        chat: () => jsonResponse(200, llmBody),
      });
      const { services } = servicesFor(fetchMock);
      const result = await services.decide(context());
      expect(result.value.intent).toBe(LLM_INTENT);
      expect(calls.map((item) => item.url)).toEqual([
        OPENROUTER_DECISIONS_URL,
        OPENROUTER_CHAT_URL,
      ]);
    }
  });

  it("falls through on HTTP 402/429/5xx and timeout, then trips the breaker", async () => {
    let now = 1_000;
    const { fetchMock: fetch402 } = routeFetch({
      decisions: () => jsonResponse(402, { error: { message: `fail ${KEY}` } }),
      chat: () => jsonResponse(200, llmBody),
    });
    const billed = servicesFor(fetch402);
    const billedResult = await billed.services.decide(context());
    expect(billedResult.value.intent).not.toBe(LLM_INTENT);
    expect(billedResult.value.intent).not.toContain("noticed");
    expect(JSON.stringify(fetch402.mock.results)).not.toContain(KEY);

    for (const status of [429, 500]) {
      const { fetchMock } = routeFetch({
        decisions: () =>
          jsonResponse(status, { error: { message: `fail ${KEY}` } }),
        chat: () => jsonResponse(200, llmBody),
      });
      const { services } = servicesFor(fetchMock);
      const result = await services.decide(context());
      expect(result.value.intent).toBe(LLM_INTENT);
      expect(JSON.stringify(fetchMock.mock.results)).not.toContain(KEY);
    }

    const timeout = routeFetch({
      decisions: async () => {
        const error = new Error("The operation was aborted");
        error.name = "TimeoutError";
        throw error;
      },
      chat: () => jsonResponse(200, llmBody),
    });
    const timed = servicesFor(timeout.fetchMock);
    expect((await timed.services.decide(context())).value.intent).toBe(
      LLM_INTENT,
    );

    const { fetchMock, calls } = routeFetch({
      decisions: () =>
        jsonResponse(500, { error: { message: `upstream ${KEY}` } }),
      chat: () => jsonResponse(200, llmBody),
    });
    const { services } = servicesFor(
      fetchMock,
      { OPENROUTER_API_KEY: KEY },
      () => now,
    );
    await services.decide(context());
    await services.decide(context());
    const before = calls.filter(
      (item) => item.url === OPENROUTER_DECISIONS_URL,
    ).length;
    expect(before).toBe(2);
    await services.decide(context());
    expect(
      calls.filter((item) => item.url === OPENROUTER_DECISIONS_URL),
    ).toHaveLength(2);
    now += 61_000;
    await services.decide(context());
    expect(
      calls.filter((item) => item.url === OPENROUTER_DECISIONS_URL),
    ).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain(KEY);
  });

  it("does not call JEV without a key, when disabled, or for directive/event decisions", async () => {
    const none = routeFetch({});
    const { services: noKey } = servicesFor(none.fetchMock, {});
    await noKey.decide(context());
    expect(none.fetchMock).not.toHaveBeenCalled();

    const disabled = routeFetch({
      chat: () => jsonResponse(200, llmBody),
    });
    const { services: off } = servicesFor(disabled.fetchMock, {
      OPENROUTER_API_KEY: KEY,
      AGENT_WORLD_JEV_DECISIONS: "false",
    });
    expect((await off.decide(context())).value.intent).toBe(LLM_INTENT);
    expect(disabled.calls.map((item) => item.url)).toEqual([
      OPENROUTER_CHAT_URL,
    ]);

    const directed = routeFetch({
      chat: () => jsonResponse(200, llmBody),
    });
    const { services } = servicesFor(directed.fetchMock);
    await services.decide(context({ directive: "talk to Fern" }));
    await services.decide(
      context({ event: { kind: "new_character", payload: {} } }),
    );
    expect(directed.calls.map((item) => item.url)).toEqual([
      OPENROUTER_CHAT_URL,
      OPENROUTER_CHAT_URL,
    ]);
  });

  it("never puts the key in JEV transport errors", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetch: async () =>
        jsonResponse(401, { error: { message: `Invalid key ${KEY}` } }),
    });
    const decider = new JevDecider({ client });
    await expect(decider.decide(context())).rejects.toSatisfy(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          message.startsWith("OpenRouter 401:") &&
          message.includes("Invalid key") &&
          !message.includes(KEY)
        );
      },
    );
  });
});
