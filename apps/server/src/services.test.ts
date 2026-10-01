import { describe, expect, it, vi } from "vitest";
import type { WorldStore } from "@agent-world/db";
import {
  BudgetExhaustedError,
  PaidServices,
  parseDialogue,
  type AgentContext,
  type JsonTransport,
} from "./services.js";

const context: AgentContext = {
  id: "moss",
  name: "Moss",
  personality: "Curious and chaotic.",
  model: "z-ai/glm-5.3-flash",
  intent: "Talking with Juniper",
  position: { x: 572, y: 333 },
  area: {
    id: "plaza",
    name: "Sunbeam Plaza",
    description: "The social center of Agent World.",
    proximity: "inside",
  },
  locations: [
    {
      id: "plaza",
      name: "Sunbeam Plaza",
      description: "The social center of Agent World.",
    },
  ],
  nearby: [],
  memories: [
    {
      kind: "fact",
      bullet: "Juniper likes unusual stories.",
      subject: "Juniper",
    },
  ],
  recentEvents: ["Moss entered Sunbeam Plaza."],
  conversation: {
    id: "conversation-1",
    turn: 4,
    maxMessages: 20,
    maxMinutes: 10,
    phase: "continuing",
  },
  conversationHistory: ["Juniper: Tell me what you noticed."],
  conversationPurpose: "Compare grounded observations about Sunbeam Plaza",
  capabilities: ["Move to or inspect a listed location"],
};

const ledger = (reservation: string | null = "reservation") =>
  ({
    reserveCost: vi.fn(() => reservation),
    settleCost: vi.fn(),
    releaseCost: vi.fn(),
  }) as unknown as WorldStore & {
    reserveCost: ReturnType<typeof vi.fn>;
    settleCost: ReturnType<typeof vi.fn>;
    releaseCost: ReturnType<typeof vi.fn>;
  };

const replyWith = (body: unknown, amountMicros = 325): JsonTransport => ({
  async requestJson<T>() {
    return { body: body as T, metadata: { transport: "test" }, amountMicros };
  },
});

describe("PaidServices keyless mode", () => {
  it("never touches the ledger without a provider", async () => {
    const repository = ledger();
    const services = new PaidServices(repository);
    const decision = await services.decide({ ...context, directive: "talk" });
    const line = await services.conversationMessage(
      context,
      "Juniper",
      "Hello",
      1,
    );
    const memories = await services.extractMemory({
      characterId: "moss",
      model: context.model,
      characterName: "Moss",
      otherName: "Juniper",
      transcript: "Moss: The fountain is loud.\nJuniper: It is.",
    });
    expect(decision.costMicros).toBe(0);
    expect(line.value.text.length).toBeGreaterThan(0);
    expect(memories.value.length).toBeGreaterThan(0);
    expect(repository.reserveCost).not.toHaveBeenCalled();
    expect(repository.settleCost).not.toHaveBeenCalled();
    expect(services.brain()).toEqual({
      decisions: "deterministic",
      dialogue: "deterministic",
      paidTools: false,
      budgeted: false,
    });
  });

  it("does not offer web search when paid tools are off", async () => {
    let prompt = "";
    const services = new PaidServices(ledger(), {
      llmTransport: {
        async requestJson<T>(_url: string, body: unknown) {
          prompt = JSON.stringify(body);
          return {
            body: {
              choices: [
                {
                  message: {
                    content: '{"action":"web_search","intent":"Look it up"}',
                  },
                },
              ],
            } as T,
            metadata: {},
            amountMicros: 10,
          };
        },
      },
    });
    const result = await services.decide(context);
    expect(prompt).not.toContain("web_search");
    expect(services.canSearchWeb()).toBe(false);
    expect(result.value.action).toBe("web_search");
  });
});

describe("PaidServices live conversation messages", () => {
  it("bills an empty paid reply but replaces it with a keyless line", async () => {
    const repository = ledger();
    let requestedBody: unknown;
    const services = new PaidServices(repository, {
      llmTransport: {
        async requestJson<T>(_url: string, body: unknown) {
          requestedBody = body;
          return {
            body: { choices: [{ message: {} }] } as T,
            metadata: { transport: "mppx" },
            amountMicros: 325,
          };
        },
      },
    });

    const result = await services.conversationMessage(
      context,
      "Juniper",
      "Hello",
      1,
    );
    expect(result.degraded).toBe(true);
    expect(result.costMicros).toBe(325);
    expect(result.value.text.length).toBeGreaterThan(0);
    expect(services.lastFailure()?.message).toBe("Reply had no usable content");
    expect(repository.settleCost).toHaveBeenCalledWith(
      "reservation",
      325,
      expect.objectContaining({
        transport: "mppx",
        costEstimated: false,
        completion: expect.objectContaining({ contentPresent: false }),
      }),
      expect.any(Number),
    );
    expect(repository.releaseCost).not.toHaveBeenCalled();
    expect(requestedBody).toMatchObject({ max_tokens: 2_000 });
    expect(requestedBody).not.toHaveProperty("reasoning");
    const messages = (requestedBody as { messages: Array<{ content: string }> })
      .messages;
    expect(messages[0]?.content).toContain("Do not invent");
    expect(messages[0]?.content).toContain('"end"');
    expect(messages[1]?.content).toContain("Sunbeam Plaza");
    expect(messages[1]?.content).toContain("Juniper likes unusual stories");
    expect(messages[1]?.content).toContain("conversationHistory");
    expect(messages[1]?.content).toContain('"phase":"continuing"');
    expect(messages[1]?.content).toContain(
      '"conversationPurpose":"Compare grounded observations about Sunbeam Plaza"',
    );
    expect(messages[0]?.content).toContain("spoken words only");
    expect(messages[0]?.content).toContain("unsupported invention");
    expect(messages[1]?.content).toContain('"ownerDirective":null');
  });

  it("reads the end flag from a JSON reply", async () => {
    const services = new PaidServices(ledger(), {
      llmTransport: replyWith({
        choices: [
          {
            message: {
              content: '{"say":"Goodbye for now, Juniper.","end":true}',
            },
          },
        ],
      }),
    });
    const result = await services.conversationMessage(
      context,
      "Juniper",
      "See you",
      9,
    );
    expect(result.value).toEqual({
      text: "Goodbye for now, Juniper.",
      end: true,
    });
  });

  it("throws BudgetExhaustedError when nothing can be reserved", async () => {
    const services = new PaidServices(ledger(null), {
      llmTransport: replyWith({}),
    });
    await expect(services.decide(context)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });
});

describe("parseDialogue", () => {
  it("accepts JSON, fenced JSON and plain text", () => {
    expect(parseDialogue('{"say":"Hi there","end":false}')).toEqual({
      text: "Hi there",
      end: false,
    });
    expect(parseDialogue('```json\n{"say":"Bye","end":true}\n```')).toEqual({
      text: "Bye",
      end: true,
    });
    expect(parseDialogue("Just words.")).toEqual({
      text: "Just words.",
      end: false,
    });
  });
});

describe("PaidServices live avatar generation", () => {
  it("uses the supported GPT Image model and transparent low-quality output", async () => {
    let requestedBody: unknown;
    const services = new PaidServices(ledger(), {
      paidToolsTransport: {
        async requestJson<T>(_url: string, body: unknown) {
          requestedBody = body;
          return {
            body: { data: [{ b64_json: "image-data" }] } as T,
            metadata: { transport: "mppx" },
            amountMicros: 50_000,
          };
        },
      },
    });

    const result = await services.generateAvatar(
      "frog",
      "Frog",
      "Curious and bright",
    );

    expect(result.value).toBe("data:image/png;base64,image-data");
    expect(requestedBody).toMatchObject({
      model: "gpt-image-2",
      background: "transparent",
      quality: "low",
      size: "1024x1024",
    });
  });

  it("returns no avatar without paid tools", async () => {
    const repository = ledger();
    const result = await new PaidServices(repository).generateAvatar(
      "frog",
      "Frog",
      "Curious",
    );
    expect(result.value).toBeNull();
    expect(repository.reserveCost).not.toHaveBeenCalled();
  });
});
