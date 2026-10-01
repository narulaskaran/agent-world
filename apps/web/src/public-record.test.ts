import { describe, expect, it } from "vitest";
import type { WorldEvent } from "@agent-world/shared/world";
import {
  PUBLIC_RECORD_LIMIT,
  conversationLine,
  eventDetail,
  eventDetailsLabel,
  eventInvolves,
  shortDisplayId,
  shortenFeedSummary,
  summarySegments,
  threadEvents,
  type FeedItem,
} from "./public-record";

describe("eventDetail", () => {
  it("omits empty details and keeps full event text", () => {
    expect(eventDetail(null)).toBeNull();
    expect(eventDetail("")).toBeNull();
    expect(eventDetail("conversation:abc")).toBe("conversation:abc");
    expect(eventDetail("deterministic directive response")).toBe(
      "deterministic directive response",
    );
    expect(eventDetail("Looked around.")).toBe("Looked around.");
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

const event = (overrides: Partial<WorldEvent>): WorldEvent => ({
  id: crypto.randomUUID(),
  kind: "conversation",
  characterId: "moss",
  characterName: "Moss",
  targetCharacterId: "juniper",
  summary: "Moss: “Hello.”",
  detail: null,
  createdAt: 0,
  ...overrides,
});

describe("threadEvents", () => {
  it("collapses a conversation into one thread at its newest position", () => {
    const items = threadEvents([
      event({ id: "c3", conversationId: "a", createdAt: 3 }),
      event({ id: "x", kind: "movement", createdAt: 2 }),
      event({ id: "c1", conversationId: "a", createdAt: 1 }),
    ]);
    expect(items.map((item) => item.type)).toEqual(["conversation", "event"]);
    const thread = items[0] as Extract<FeedItem, { type: "conversation" }>;
    expect(thread.events.map((item) => item.id)).toEqual(["c1", "c3"]);
    expect(thread.latest.id).toBe("c3");
  });

  it("keeps separate conversations apart", () => {
    const items = threadEvents([
      event({ conversationId: "a" }),
      event({ conversationId: "b" }),
    ]);
    expect(items).toHaveLength(2);
  });
});

describe("eventInvolves", () => {
  it("matches the actor or the target", () => {
    expect(eventInvolves(event({}), "juniper")).toBe(true);
    expect(eventInvolves(event({}), "tinker")).toBe(false);
  });
});

describe("summarySegments", () => {
  const characters = [
    { id: "moss", name: "Moss" },
    { id: "juniper", name: "Juniper" },
  ];

  it("does not link a name inside a place name", () => {
    const tinker = [{ id: "tinker", name: "Tinker" }];
    const segments = summarySegments(
      "Tinker left a map at the Tinker Shed.",
      tinker,
    );
    expect(segments.filter((segment) => segment.characterId)).toEqual([
      { text: "Tinker", characterId: "tinker" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "Tinker left a map at the Tinker Shed.",
    );
  });

  it("links whole character names only", () => {
    expect(
      summarySegments("Moss and Juniper started talking.", characters),
    ).toEqual([
      { text: "Moss", characterId: "moss" },
      { text: " and " },
      { text: "Juniper", characterId: "juniper" },
      { text: " started talking." },
    ]);
    expect(summarySegments("Mossy rocks", characters)).toEqual([
      { text: "Mossy rocks" },
    ]);
  });
});

describe("conversationLine", () => {
  it("splits a spoken line from its speaker", () => {
    expect(conversationLine(event({}))).toEqual({
      speaker: "Moss",
      text: "Hello.",
    });
    expect(
      conversationLine(event({ summary: "Moss and Juniper started talking." })),
    ).toBeNull();
  });
});

describe("PUBLIC_RECORD_LIMIT", () => {
  it("keeps the latest 100 events", () => {
    expect(PUBLIC_RECORD_LIMIT).toBe(100);
  });
});
