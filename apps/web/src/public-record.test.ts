import { describe, expect, it } from "vitest";
import {
  PUBLIC_RECORD_LIMIT,
  eventDetailsLabel,
  guestEventDetail,
  shortDisplayId,
  shortenFeedSummary,
} from "./public-record";

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

  it("keeps identical summaries unique with time and event id", () => {
    const summary = "From SmB511433 left";
    const at = Date.UTC(2026, 8, 4, 19, 4, 0);
    const first = eventDetailsLabel(summary, {
      createdAt: at,
      id: "evt-aaa",
    });
    const second = eventDetailsLabel(summary, {
      createdAt: at,
      id: "evt-bbb",
    });
    expect(first).toContain("See details: From SmB511433 left");
    expect(second).toContain("See details: From SmB511433 left");
    expect(first).not.toBe(second);
    expect(first).toContain("evt-aaa");
    expect(second).toContain("evt-bbb");
    expect(shortenFeedSummary(summary)).toBe("From SmB left");
  });
});

describe("shortDisplayId", () => {
  it("keeps ordinary names", () => {
    expect(shortDisplayId("Moss")).toBe("Moss");
    expect(shortDisplayId("Juniper")).toBe("Juniper");
    expect(shortDisplayId("someone")).toBe("someone");
  });

  it("shortens letter-plus-digits ids to the letter prefix", () => {
    expect(shortDisplayId("SmB511433")).toBe("SmB");
    expect(shortDisplayId("SmA510861")).toBe("SmA");
  });

  it("shortens UUIDs to the first segment", () => {
    expect(shortDisplayId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(
      "3fa85f64",
    );
  });
});

describe("shortenFeedSummary", () => {
  it("shortens hashy ids in feed copy without touching places", () => {
    expect(shortenFeedSummary("SmB511433 wandered to Sunbeam Plaza.")).toBe(
      "SmB wandered to Sunbeam Plaza.",
    );
    expect(shortenFeedSummary("SmA511433 and SmB511433 started talking.")).toBe(
      "SmA and SmB started talking.",
    );
    expect(shortenFeedSummary("From SmB511433")).toBe("From SmB");
    expect(shortenFeedSummary("From SmA511433")).toBe("From SmA");
  });

  it("leaves human names unchanged", () => {
    expect(shortenFeedSummary("Juniper arrived in Agent World.")).toBe(
      "Juniper arrived in Agent World.",
    );
  });

  it("keeps full ids in See details labels so they stay unique", () => {
    const full = "SmB511433 wandered to Sunbeam Plaza.";
    expect(shortenFeedSummary(full)).toBe("SmB wandered to Sunbeam Plaza.");
    expect(eventDetailsLabel(full)).toBe(
      "See details: SmB511433 wandered to Sunbeam Plaza.",
    );
    expect(eventDetailsLabel(full)).not.toBe(
      eventDetailsLabel("SmA511433 wandered to Sunbeam Plaza."),
    );
  });

  it("is stable across repeated calls", () => {
    const text = "SmB511433 studied Sunbeam Plaza.";
    expect(shortenFeedSummary(text)).toBe("SmB studied Sunbeam Plaza.");
    expect(shortenFeedSummary(text)).toBe("SmB studied Sunbeam Plaza.");
  });
});

describe("PUBLIC_RECORD_LIMIT", () => {
  it("keeps the latest 100 events", () => {
    expect(PUBLIC_RECORD_LIMIT).toBe(100);
  });
});
