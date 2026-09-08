import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICK_INTERVAL_MIN,
  parseTickIntervalMin,
  shouldSkipWorldTick,
  tickIntervalMs,
} from "./tick-interval.js";

describe("parseTickIntervalMin", () => {
  it("defaults to 10 when unset or blank", () => {
    expect(parseTickIntervalMin(undefined)).toEqual({
      minutes: DEFAULT_TICK_INTERVAL_MIN,
      invalid: false,
    });
    expect(parseTickIntervalMin("")).toEqual({
      minutes: DEFAULT_TICK_INTERVAL_MIN,
      invalid: false,
    });
    expect(parseTickIntervalMin("  ")).toEqual({
      minutes: DEFAULT_TICK_INTERVAL_MIN,
      invalid: false,
    });
  });

  it("accepts 10, 30, and 60", () => {
    expect(parseTickIntervalMin("10")).toEqual({
      minutes: 10,
      invalid: false,
    });
    expect(parseTickIntervalMin("30")).toEqual({
      minutes: 30,
      invalid: false,
    });
    expect(parseTickIntervalMin(" 60 ")).toEqual({
      minutes: 60,
      invalid: false,
    });
  });

  it("fails closed to 10 for invalid values", () => {
    for (const raw of ["0", "1", "15", "20", "120", "10.0", "foo", "-10"]) {
      expect(parseTickIntervalMin(raw)).toEqual({
        minutes: DEFAULT_TICK_INTERVAL_MIN,
        invalid: true,
      });
    }
  });
});

describe("shouldSkipWorldTick", () => {
  it("runs the first tick and skips until the interval elapses", () => {
    expect(shouldSkipWorldTick(0, 1, 10)).toBe(false);
    expect(shouldSkipWorldTick(1_000, 1_000, 10)).toBe(true);
    expect(shouldSkipWorldTick(1_000, 1_000 + tickIntervalMs(10) - 1, 10)).toBe(
      true,
    );
    expect(shouldSkipWorldTick(1_000, 1_000 + tickIntervalMs(10), 10)).toBe(
      false,
    );
    expect(shouldSkipWorldTick(1_000, 1_000 + tickIntervalMs(30) - 1, 30)).toBe(
      true,
    );
    expect(shouldSkipWorldTick(1_000, 1_000 + tickIntervalMs(60), 60)).toBe(
      false,
    );
  });
});
