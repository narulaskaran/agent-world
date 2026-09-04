/** Guest-facing public-record details. Never leak job/tick internals. */

const FIRST_MISSION = /^first mission:\s*(.+)$/i;
const INTERNAL_JARGON =
  /^(?:deterministic(?:\s+(?:tick|job|directive response))?)$/i;

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
