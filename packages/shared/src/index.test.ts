import { describe, expect, it } from "vitest";
import { CreateCharacterSchema, nameColor } from "./index.js";

describe("shared contracts", () => {
  it("accepts the intended character creation shape", () => {
    expect(
      CreateCharacterSchema.safeParse({
        name: "Moss",
        personality: "Curious about tiny gardens",
        model: "z-ai/glm-5.3-flash",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "meet",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported models and unsafe names", () => {
    expect(
      CreateCharacterSchema.safeParse({
        name: "<script>",
        personality: "Curious about tiny gardens",
        model: "unknown/model",
        dailyBudgetMicros: 500_000,
        decisionIntervalSeconds: 60,
        firstMission: "meet",
      }).success,
    ).toBe(false);
  });

  it("generates stable fallback colors", () => {
    expect(nameColor("Moss")).toBe(nameColor("Moss"));
    expect(nameColor("Moss")).not.toBe(nameColor("Juniper"));
  });
});
