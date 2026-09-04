/** Guest-facing public-record details. Never leak job/tick internals. */

const FIRST_MISSION = /^first mission:\s*(.+)$/i;
const INTERNAL_JARGON =
  /^(?:deterministic(?:\s+(?:tick|job|directive response))?)$/i;

export const PUBLIC_RECORD_LIMIT = 100;

export function guestEventDetail(
  detail: string | null | undefined,
): string | null {
  if (!detail) return null;
  const text = detail.trim();
  if (!text) return null;
  if (text.startsWith("conversation:")) return null;
  if (INTERNAL_JARGON.test(text) || /\bdeterministic\b/i.test(text)) {
    if (/directive/i.test(text)) return null;
    return "Looked around.";
  }
  const mission = FIRST_MISSION.exec(text);
  if (mission) return "Arrived.";
  return text;
}

export function eventDetailsLabel(summary: string): string {
  return `See details: ${summary}`;
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
