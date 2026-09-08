import { describe, expect, it } from "vitest";
import { ifNoneMatchHits, worldSnapshotEtag } from "./observe.js";
import type { WorldSnapshot } from "../../shared/src/index.js";

const snapshot = (overrides: Partial<WorldSnapshot> = {}): WorldSnapshot => ({
  characters: [],
  events: [],
  locations: [],
  artifacts: [],
  simulationPaused: false,
  serverSpentTodayMicros: 0,
  serverDailyBudgetMicros: 2_000_000,
  budgetDate: "2026-09-08",
  connectedViewers: 0,
  generatedAt: 1,
  ...overrides,
});

describe("world snapshot ETag", () => {
  it("ignores generatedAt so unchanged worlds match", () => {
    const first = worldSnapshotEtag(snapshot({ generatedAt: 1 }), "anon");
    const second = worldSnapshotEtag(snapshot({ generatedAt: 9 }), "anon");
    expect(first).toBe(second);
    expect(ifNoneMatchHits(first, first)).toBe(true);
    expect(ifNoneMatchHits(`W/${first.replace(/^W\//, "")}`, first)).toBe(true);
  });

  it("changes when durable character state changes", () => {
    const idle = worldSnapshotEtag(snapshot(), "anon");
    const moved = worldSnapshotEtag(
      snapshot({
        characters: [
          {
            id: "moss",
            name: "Moss",
            personality: "Curious",
            model: "z-ai/glm-5.3-flash",
            dailyBudgetMicros: 1,
            spentTodayMicros: 0,
            decisionIntervalSeconds: 60,
            state: "moving",
            x: 1,
            y: 1,
            targetX: 2,
            targetY: 2,
            intent: "Walking",
            speech: null,
            avatarUrl: null,
            avatarColor: "#579c87",
            toolActive: false,
            reputation: 0,
            locationId: "plaza",
            memories: [],
            relationships: [],
            updatedAt: 2,
          },
        ],
      }),
      "anon",
    );
    expect(idle).not.toBe(moved);
  });
});
