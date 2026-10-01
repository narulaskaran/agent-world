import { describe, expect, it } from "vitest";
import {
  CreateCharacterSchema,
  LOCATION_WAYPOINTS,
  UpdateWorldSchema,
  WORLD_LOCATIONS,
  hashString,
  locationAtPoint,
  relationshipTier,
} from "./index.js";

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

  it("hashes stably and finds plaza and workshop locations", () => {
    expect(hashString("Moss")).toBe(hashString("Moss"));
    expect(hashString("Moss")).not.toBe(hashString("Juniper"));
    expect(locationAtPoint(455, 275)?.id).toBe("plaza");
    expect(locationAtPoint(880, 520)?.id).toBe("workshop");
  });

  it("keeps every waypoint inside its own location", () => {
    for (const location of WORLD_LOCATIONS) {
      for (const point of LOCATION_WAYPOINTS[location.id]) {
        expect(locationAtPoint(point.x, point.y)?.id).toBe(location.id);
      }
    }
  });

  it("reaches every relationship tier within a handful of conversations", () => {
    expect(relationshipTier(undefined)).toBe("stranger");
    expect(relationshipTier(1)).toBe("acquaintance");
    expect(relationshipTier(3)).toBe("friend");
    expect(relationshipTier(8)).toBe("close friend");
  });

  it("requires at least one world setting", () => {
    expect(UpdateWorldSchema.safeParse({}).success).toBe(false);
    expect(UpdateWorldSchema.safeParse({ decisionScale: 5 }).success).toBe(
      true,
    );
    expect(UpdateWorldSchema.safeParse({ decisionScale: 0 }).success).toBe(
      false,
    );
  });
});
