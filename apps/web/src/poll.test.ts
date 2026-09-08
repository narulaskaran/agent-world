import { describe, expect, it } from "vitest";
import {
  FOREGROUND_POLL_MS,
  MAX_ERROR_BACKOFF_MS,
  isStateUnavailable,
  nextPollDelayMs,
} from "./poll";
import { ApiError } from "./api";

describe("spectator poll cadence", () => {
  it("keeps healthy foreground at 4s and pauses when hidden", () => {
    expect(
      nextPollDelayMs({
        visible: true,
        unavailable: false,
        previousDelayMs: FOREGROUND_POLL_MS,
      }),
    ).toBe(FOREGROUND_POLL_MS);
    expect(
      nextPollDelayMs({
        visible: false,
        unavailable: false,
        previousDelayMs: FOREGROUND_POLL_MS,
      }),
    ).toBeNull();
    expect(
      nextPollDelayMs({
        visible: false,
        unavailable: true,
        previousDelayMs: 8_000,
      }),
    ).toBeNull();
  });

  it("backs off exponentially on 5xx without jumping healthy polls to 30s", () => {
    expect(
      nextPollDelayMs({
        visible: true,
        unavailable: true,
        previousDelayMs: FOREGROUND_POLL_MS,
      }),
    ).toBe(8_000);
    expect(
      nextPollDelayMs({
        visible: true,
        unavailable: true,
        previousDelayMs: 8_000,
      }),
    ).toBe(16_000);
    expect(
      nextPollDelayMs({
        visible: true,
        unavailable: true,
        previousDelayMs: 32_000,
      }),
    ).toBe(MAX_ERROR_BACKOFF_MS);
    expect(
      isStateUnavailable(
        new ApiError("DATABASE_UNAVAILABLE", 503, "DATABASE_UNAVAILABLE"),
      ),
    ).toBe(true);
    expect(isStateUnavailable(new ApiError("nope", 400))).toBe(false);
  });
});
