import { describe, expect, it } from "vitest";
import { WORLD_LOCATIONS } from "@agent-world/shared";
import {
  conversationOpener,
  conversationTargetLength,
  deterministicArtifact,
  deterministicDecision,
  deterministicLine,
  deterministicMemories,
  leadingTrait,
} from "./deterministic.js";
import type { AgentContext } from "./services.js";

const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  id: "moss",
  name: "Moss",
  personality: "Quiet, patient and slightly obsessed with tiny gardens.",
  model: "z-ai/glm-5.3-flash",
  intent: "Looking around",
  position: { x: 500, y: 350 },
  area: {
    id: "plaza",
    name: "Sunbeam Plaza",
    description: "The social center.",
    proximity: "inside",
  },
  locations: [],
  nearby: [
    { id: "juniper", name: "Juniper", distance: 40, state: "active" },
    { id: "tinker", name: "Tinker", distance: 300, state: "active" },
  ],
  memories: [],
  recentEvents: [],
  capabilities: [],
  ...overrides,
});

/** A seeded generator so tests can sample many decisions deterministically. */
const seeded = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

describe("leadingTrait", () => {
  it("returns a leading adjective, not a whole clause", () => {
    expect(
      leadingTrait(
        "Restless maker who leaves notes and odd little objects everywhere.",
      ),
    ).toBe("restless");
    expect(leadingTrait("Playful and observant.")).toBe("playful");
    expect(leadingTrait("Moss is curious and grounded.")).toBe("curious");
    expect(leadingTrait("A very gentle soul")).toBe("gentle");
    expect(leadingTrait("")).toBe("curious");
  });
});

describe("deterministicDecision", () => {
  it("approaches the newcomer named by a new_character event, not the nearest", () => {
    const decision = deterministicDecision(
      context({
        event: {
          kind: "new_character",
          payload: { targetCharacterId: "tinker" },
        },
      }),
      { random: () => 0.5, canSearchWeb: false },
    );
    expect(decision).toMatchObject({
      action: "approach",
      targetCharacterId: "tinker",
    });
    expect(decision.message).toContain("Tinker");
  });

  it("visits every place, including the Tinker Shed, when wandering keyless", () => {
    const random = seeded(7);
    const visited = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      const decision = deterministicDecision(context({ nearby: [] }), {
        random,
        canSearchWeb: false,
      });
      if (decision.locationId) visited.add(decision.locationId);
    }
    expect([...visited].sort()).toEqual(
      WORLD_LOCATIONS.map((location) => location.id).sort(),
    );
  });

  it("does not choose web search without paid tools", () => {
    const decision = deterministicDecision(
      context({ directive: "Search for tiny garden ideas" }),
      { random: () => 0.5, canSearchWeb: false },
    );
    expect(decision).toMatchObject({ action: "move", locationId: "library" });
  });

  it("leaves an artifact when asked to make something at the workshop", () => {
    const decision = deterministicDecision(
      context({
        directive: "Make something for the others",
        area: {
          id: "workshop",
          name: "The Tinker Shed",
          description: "",
          proximity: "inside",
        },
      }),
      { random: () => 0.5, canSearchWeb: false },
    );
    expect(decision.action).toBe("leave_artifact");
  });
});

describe("conversationOpener", () => {
  it("varies openers and uses natural place names", () => {
    const random = seeded(3);
    const openers = new Set(
      Array.from({ length: 30 }, () =>
        conversationOpener(context(), "Juniper", random),
      ),
    );
    expect(openers.size).toBeGreaterThan(2);
    const cafe = conversationOpener(
      context({
        area: {
          id: "cafe",
          name: "The Tiny Cup",
          description: "",
          proximity: "inside",
        },
      }),
      "Juniper",
      () => 0,
    );
    expect(cafe).toContain("the Tiny Cup");
  });
});

describe("deterministicLine", () => {
  it("ends on the pair's target length", () => {
    const targetLength = conversationTargetLength("conversation-1");
    expect(targetLength).toBeGreaterThanOrEqual(6);
    expect(targetLength).toBeLessThanOrEqual(14);
    const last = deterministicLine({
      context: context(),
      otherName: "Juniper",
      previous: "Hi",
      turn: targetLength - 1,
      targetLength,
    });
    expect(last.end).toBe(true);
    const middle = deterministicLine({
      context: context(),
      otherName: "Juniper",
      previous: "Hi",
      turn: 3,
      targetLength,
    });
    expect(middle.end).toBe(false);
  });

  it("does not repeat a line already said in the conversation", () => {
    const history: string[] = [];
    for (let turn = 2; turn < 9; turn += 1) {
      const { text } = deterministicLine({
        context: context({ conversationHistory: [...history] }),
        otherName: "Juniper",
        previous: "Same thing",
        turn,
        targetLength: 14,
      });
      expect(history.map((line) => line.slice(6))).not.toContain(text);
      history.push(`Moss: ${text}`);
    }
  });

  it("carries an owner directive into the line", () => {
    const { text } = deterministicLine({
      context: context({ directive: "mention the fountain" }),
      otherName: "Juniper",
      previous: "Hi",
      turn: 3,
      targetLength: 10,
    });
    expect(text).toContain("mention the fountain");
  });
});

describe("deterministicMemories", () => {
  it("records a fact and an impression grounded in the transcript", () => {
    const memories = deterministicMemories({
      characterName: "Moss",
      otherName: "Juniper",
      otherPersonality: "Playful and observant.",
      transcript: "Moss: Have you been to the Tiny Cup?\nJuniper: Not yet.",
    });
    expect(memories).toEqual([
      expect.objectContaining({
        kind: "fact",
        bullet: "Talked with Juniper about the Tiny Cup.",
      }),
      expect.objectContaining({
        kind: "impression",
        bullet: "Juniper comes across as playful.",
      }),
    ]);
  });
});

describe("deterministicArtifact", () => {
  it("does not leave something already on the shelf", () => {
    const random = seeded(11);
    const shelf = [
      "A small carved token",
      "A hand-drawn map",
      "A note from Moss",
    ];
    for (let i = 0; i < 40; i += 1) {
      const artifact = deterministicArtifact(
        context({ notesHere: shelf }),
        random,
      );
      expect(shelf).not.toContain(artifact.title);
      expect(artifact.body).not.toMatch(/ The [A-Z]/);
    }
  });
});
