import { describe, expect, it } from "vitest";
import { microsToInput, parseUsdInput } from "./money";

describe("parseUsdInput", () => {
  const limits = { min: 0.05, max: 2 };

  it("converts valid dollars to micros", () => {
    expect(parseUsdInput("0.50", limits)).toBe(500_000);
    expect(parseUsdInput(" 2 ", limits)).toBe(2_000_000);
  });

  it("rejects empty, non-numeric and out-of-range input instead of sending 0", () => {
    expect(parseUsdInput("", limits)).toBeNull();
    expect(parseUsdInput("abc", limits)).toBeNull();
    expect(parseUsdInput("0", limits)).toBeNull();
    expect(parseUsdInput("3", limits)).toBeNull();
  });

  it("allows zero when the minimum is zero", () => {
    expect(parseUsdInput("0", { min: 0, max: 50 })).toBe(0);
  });
});

describe("microsToInput", () => {
  it("formats micros for an input field", () => {
    expect(microsToInput(250_000)).toBe("0.25");
  });
});
