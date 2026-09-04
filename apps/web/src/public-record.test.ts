import { describe, expect, it } from "vitest";
import { eventDetailsLabel, guestEventDetail } from "./public-record";

describe("guestEventDetail", () => {
  it("omits empty internals and private conversation markers", () => {
    expect(guestEventDetail(null)).toBeNull();
    expect(guestEventDetail("")).toBeNull();
    expect(guestEventDetail("conversation:abc")).toBeNull();
    expect(guestEventDetail("deterministic directive response")).toBeNull();
  });

  it("rewrites job/tick jargon into human copy", () => {
    expect(guestEventDetail("deterministic tick")).toBe("Looked around.");
    expect(guestEventDetail("deterministic job")).toBe("Looked around.");
    expect(guestEventDetail("First mission: explore")).toBe("Arrived.");
    expect(guestEventDetail("First mission: meet")).toBe("Arrived.");
    expect(guestEventDetail("First mission: meet someone")).toBe("Arrived.");
  });

  it("keeps guest-facing details", () => {
    expect(guestEventDetail("Looked around.")).toBe("Looked around.");
    expect(guestEventDetail("A note about the plaza.")).toBe(
      "A note about the plaza.",
    );
  });
});

describe("eventDetailsLabel", () => {
  it("includes the event summary for a unique accessible name", () => {
    expect(eventDetailsLabel("SmB left")).toBe("See details: SmB left");
    expect(eventDetailsLabel("Juniper arrived in Agent World.")).toBe(
      "See details: Juniper arrived in Agent World.",
    );
  });
});
