import { WORLD_LOCATIONS, type WorldEvent } from "@agent-world/shared/world";

export const PUBLIC_RECORD_LIMIT = 100;

export function eventDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const text = detail.trim();
  return text || null;
}

export function eventClock(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Accessible name for See details. Uses the full summary; time + id keep duplicates unique. */
export function eventDetailsLabel(
  summary: string,
  extra?: { createdAt?: number; id?: string },
): string {
  const parts = [`See details: ${summary}`];
  if (extra?.createdAt != null) parts.push(eventClock(extra.createdAt));
  if (extra?.id) parts.push(extra.id);
  return parts.length === 1
    ? parts[0]!
    : `${parts[0]} · ${parts.slice(1).join(" · ")}`;
}

/** Shorten hashy display ids; leave ordinary names alone. */
export function shortDisplayId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const letterPrefix = /^([A-Za-z]{2,8})\d{3,}$/.exec(trimmed);
  if (letterPrefix) return letterPrefix[1]!;
  if (/^[0-9a-f]{8}-[0-9a-f-]{4,}$/i.test(trimmed)) return trimmed.slice(0, 8);
  return trimmed;
}

/** Visible feed copy: SmB511433 → SmB. Keep the original for title/aria. */
export function shortenFeedSummary(summary: string): string {
  return summary
    .replace(/\b([A-Za-z]{2,8})\d{3,}\b/g, (_, prefix: string) => prefix)
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (token) => token.slice(0, 8),
    );
}

export type FeedItem =
  | { type: "event"; event: WorldEvent }
  | {
      type: "conversation";
      conversationId: string;
      /** Oldest first, so the thread reads top to bottom. */
      events: WorldEvent[];
      latest: WorldEvent;
    };

/**
 * Collapses every event of a conversation into one thread placed where its
 * newest event sits. Input and output are newest first.
 */
export function threadEvents(events: WorldEvent[]): FeedItem[] {
  const threads = new Map<
    string,
    Extract<FeedItem, { type: "conversation" }>
  >();
  const items: FeedItem[] = [];
  for (const event of events) {
    const id = event.conversationId;
    if (!id) {
      items.push({ type: "event", event });
      continue;
    }
    const thread = threads.get(id);
    if (thread) {
      thread.events.unshift(event);
      continue;
    }
    const created = {
      type: "conversation" as const,
      conversationId: id,
      events: [event],
      latest: event,
    };
    threads.set(id, created);
    items.push(created);
  }
  return items;
}

export function eventInvolves(event: WorldEvent, characterId: string): boolean {
  return (
    event.characterId === characterId || event.targetCharacterId === characterId
  );
}

export interface SummarySegment {
  text: string;
  characterId?: string;
}

/** Splits a summary so living character names can render as links. */
export function summarySegments(
  summary: string,
  characters: Array<{ id: string; name: string }>,
): SummarySegment[] {
  const named = characters
    .filter((character) => character.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return [{ text: summary }];
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const places = WORLD_LOCATIONS.map((location) =>
    location.name.replace(/^The /, ""),
  );
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${[
      ...places,
      ...named.map((character) => character.name),
    ]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const byName = new Map(
    named.map((character) => [character.name, character.id]),
  );
  const segments: SummarySegment[] = [];
  let last = 0;
  for (const match of summary.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: summary.slice(last, index) });
    const characterId = byName.get(match[0]);
    segments.push(
      characterId ? { text: match[0], characterId } : { text: match[0] },
    );
    last = index + match[0].length;
  }
  if (last < summary.length) segments.push({ text: summary.slice(last) });
  return segments;
}

/** Splits a "Name: “line”" conversation summary into speaker and words. */
export function conversationLine(
  event: WorldEvent,
): { speaker: string; text: string } | null {
  const match = /^(.+?): “(.*)”$/s.exec(event.summary);
  if (!match || match[1] !== event.characterName) return null;
  return { speaker: match[1]!, text: match[2]! };
}
