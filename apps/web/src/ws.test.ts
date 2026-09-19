import { describe, expect, it } from "vitest";
import { reconnectDelayMs, websocketUrl } from "./ws";

describe("websocketUrl", () => {
  it("uses API_URL when set and maps http to ws", () => {
    expect(websocketUrl("http://localhost:4310", "http://localhost:4311")).toBe(
      "ws://localhost:4310/ws",
    );
  });

  it("falls back to location.origin and maps https to wss", () => {
    expect(websocketUrl("", "https://127.0.0.1:4310")).toBe(
      "wss://127.0.0.1:4310/ws",
    );
  });
});

describe("reconnectDelayMs", () => {
  it("starts at 1s and doubles until a 30s cap", () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(8)).toBe(30_000);
  });
});
