import { describe, expect, it } from "vitest";
import type { WorldRecap } from "@agent-world/shared/world";
import { brainLabel, recapSentence, recapWorthShowing } from "./brain";

const keyless = {
  decisions: "deterministic",
  dialogue: "deterministic",
  paidTools: false,
  budgeted: false,
} as const;

describe("brainLabel", () => {
  it("names the real brain instead of a generic mode", () => {
    expect(brainLabel(keyless)).toBe("Keyless brain");
    expect(
      brainLabel({
        decisions: "jev",
        dialogue: "openrouter",
        paidTools: false,
        budgeted: true,
      }),
    ).toBe("JEV + OpenRouter");
    expect(
      brainLabel({
        decisions: "openrouter",
        dialogue: "openrouter",
        paidTools: false,
        budgeted: true,
      }),
    ).toBe("OpenRouter brain");
  });
});

describe("recap", () => {
  const recap = (overrides: Partial<WorldRecap>): WorldRecap => ({
    since: 0,
    until: 1,
    conversations: 0,
    memories: 0,
    arrivals: 0,
    artifacts: 0,
    highlights: [],
    ...overrides,
  });

  it("only shows when something happened", () => {
    expect(recapWorthShowing(recap({}))).toBe(false);
    expect(recapWorthShowing(recap({ memories: 1 }))).toBe(true);
  });

  it("summarises counts in a sentence", () => {
    expect(recapSentence(recap({ conversations: 3, memories: 1 }))).toBe(
      "3 conversations and 1 new memory.",
    );
    expect(recapSentence(recap({ artifacts: 1 }))).toBe("1 thing left behind.");
  });
});
