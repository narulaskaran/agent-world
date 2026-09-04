import { describe, expect, it, vi } from "vitest";
import type { WorldStore } from "@agent-world/db";
import {
  PaidServices,
  type AgentContext,
  type MppTransport,
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

describe("PaidServices live conversation messages", () => {
  it("does not substitute deterministic text when a paid response has no content", async () => {
    const settleCost = vi.fn();
    const releaseCost = vi.fn();
    let requestedBody: unknown;
    const repository = {
      reserveCost: vi.fn(() => "reservation"),
      settleCost,
      releaseCost,
    } as unknown as WorldStore;
    const transport: MppTransport = {
      async requestJson<T>(_url: string, body: unknown) {
        requestedBody = body;
        return {
          body: { choices: [{ message: {} }] } as T,
          metadata: { transport: "mppx" },
          amountMicros: 325,
        };
      },
    };
    const services = new PaidServices(repository, {
      live: true,
      transport,
    });

    await expect(
      services.conversationMessage(context, "Juniper", "Hello", 1),
    ).rejects.toThrow("no conversation message content");
    expect(settleCost).toHaveBeenCalledWith(
      "reservation",
      325,
      {
        transport: "mppx",
        completion: {
          responseKeys: ["choices"],
          model: null,
          choiceCount: 1,
          finishReason: null,
          contentPresent: false,
          contentLength: 0,
          reasoningLength: 0,
          usage: null,
        },
      },
      expect.any(Number),
    );
    expect(releaseCost).not.toHaveBeenCalled();
    expect(requestedBody).toMatchObject({
      max_tokens: 2_000,
    });
    expect(requestedBody).not.toHaveProperty("reasoning");
    const messages = (requestedBody as { messages: Array<{ content: string }> })
      .messages;
    expect(messages[0]?.content).toContain("Do not invent");
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
});

describe("PaidServices live avatar generation", () => {
  it("uses the supported GPT Image model and transparent low-quality output", async () => {
    const repository = {
      reserveCost: vi.fn(() => "reservation"),
      settleCost: vi.fn(),
      releaseCost: vi.fn(),
    } as unknown as WorldStore;
    let requestedBody: unknown;
    const services = new PaidServices(repository, {
      live: true,
      transport: {
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
});
