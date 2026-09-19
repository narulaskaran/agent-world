import { describe, expect, it } from "vitest";
import { decisionDelayMs, describeMode, loadConfig } from "./config.js";

const KEY = "sk-test-not-real";

describe("loadConfig", () => {
  it("uses safe local defaults", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4310);
    expect(config.hasOpenRouterKey).toBe(false);
    expect(config.jevDecisions).toBe(false);
    expect(config.liveMpp).toBe(false);
    expect(config.decisionScale).toBe(1);
    expect(config.serverDailyBudgetMicros).toBe(2_000_000);
  });

  it("treats a present OpenRouter key as the inference key", () => {
    const config = loadConfig({ OPENROUTER_API_KEY: KEY });
    expect(config.hasOpenRouterKey).toBe(true);
    expect(config.jevDecisions).toBe(true);
    expect(config.openRouterApiKey).toBe(KEY);
  });

  it("disables JEV when AGENT_WORLD_JEV_DECISIONS=false", () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: KEY,
      AGENT_WORLD_JEV_DECISIONS: "false",
    });
    expect(config.hasOpenRouterKey).toBe(true);
    expect(config.jevDecisions).toBe(false);
  });

  it("falls back to scale 1 when the value is invalid", () => {
    expect(
      loadConfig({ AGENT_WORLD_DECISION_SCALE: "nope" }).decisionScale,
    ).toBe(1);
    expect(loadConfig({ AGENT_WORLD_DECISION_SCALE: "0" }).decisionScale).toBe(
      1,
    );
    expect(
      loadConfig({ AGENT_WORLD_DECISION_SCALE: "100" }).decisionScale,
    ).toBe(1);
  });
});

describe("describeMode", () => {
  it("never includes key material", () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: KEY,
      AGENT_WORLD_LIVE_MPP: "true",
    });
    const serialized = JSON.stringify(describeMode(config));
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("OPENROUTER");
  });

  it("reports jev, openrouter, and deterministic decision modes", () => {
    expect(
      describeMode(loadConfig({ OPENROUTER_API_KEY: KEY })).decisions,
    ).toBe("jev");
    expect(
      describeMode(
        loadConfig({
          OPENROUTER_API_KEY: KEY,
          AGENT_WORLD_JEV_DECISIONS: "false",
        }),
      ).decisions,
    ).toBe("openrouter");
    expect(describeMode(loadConfig({})).decisions).toBe("deterministic");
  });

  it("reports dialogue and paid-tool sources", () => {
    expect(describeMode(loadConfig({ OPENROUTER_API_KEY: KEY })).dialogue).toBe(
      "openrouter",
    );
    expect(
      describeMode(loadConfig({ AGENT_WORLD_LIVE_MPP: "true" })).dialogue,
    ).toBe("mpp");
    expect(describeMode(loadConfig({})).dialogue).toBe("deterministic");
    expect(
      describeMode(loadConfig({ AGENT_WORLD_LIVE_MPP: "true" })).paidTools,
    ).toBe(true);
    expect(describeMode(loadConfig({})).paidTools).toBe(false);
  });
});

describe("decisionDelayMs", () => {
  it("divides the character interval by the scale", () => {
    expect(decisionDelayMs(60, 1)).toBe(60_000);
    expect(decisionDelayMs(60, 30)).toBe(2_000);
    expect(decisionDelayMs(60, 0.5)).toBe(120_000);
    expect(decisionDelayMs(4, 1)).toBe(4_000);
  });

  it("clamps invalid scales to 1 and never returns 0", () => {
    expect(decisionDelayMs(60, 0)).toBe(60_000);
    expect(decisionDelayMs(60, 99)).toBe(60_000);
    expect(decisionDelayMs(60, Number.NaN)).toBe(60_000);
    expect(decisionDelayMs(0.001, 60)).toBe(1);
  });
});
