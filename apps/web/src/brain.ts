import type { BrainMode, WorldRecap } from "@agent-world/shared/world";

const DECISION_LABELS: Record<BrainMode["decisions"], string> = {
  jev: "JEV",
  openrouter: "OpenRouter",
  mpp: "MPP",
  deterministic: "Keyless",
};

/** Short header label for the brain driving the world. */
export function brainLabel(brain: BrainMode): string {
  if (!brain.budgeted) return "Keyless brain";
  const decisions = DECISION_LABELS[brain.decisions];
  const dialogue = DECISION_LABELS[brain.dialogue];
  return decisions === dialogue
    ? `${decisions} brain`
    : `${decisions} + ${dialogue}`;
}

export function brainHint(brain: BrainMode): string {
  if (!brain.budgeted)
    return "Characters run on the free built-in brain. Add OPENROUTER_API_KEY to .env and restart for LLM characters.";
  return `Decisions: ${DECISION_LABELS[brain.decisions]}. Dialogue and memories: ${DECISION_LABELS[brain.dialogue]}. Web search and avatars: ${brain.paidTools ? "on" : "off"}.`;
}

export const LAST_SEEN_KEY = "agent-world:last-seen";
/** Shorter absences are not worth a recap. */
export const RECAP_MIN_AWAY_MS = 5 * 60_000;

export function recapWorthShowing(recap: WorldRecap): boolean {
  return (
    recap.conversations + recap.memories + recap.arrivals + recap.artifacts > 0
  );
}

export function recapSentence(recap: WorldRecap): string {
  const parts: string[] = [];
  const count = (value: number, one: string, many: string) =>
    value ? `${value} ${value === 1 ? one : many}` : null;
  for (const part of [
    count(recap.conversations, "conversation", "conversations"),
    count(recap.memories, "new memory", "new memories"),
    count(recap.arrivals, "arrival", "arrivals"),
    count(recap.artifacts, "thing left behind", "things left behind"),
  ])
    if (part) parts.push(part);
  if (!parts.length) return "Nothing much happened.";
  const last = parts.pop()!;
  return parts.length ? `${parts.join(", ")} and ${last}.` : `${last}.`;
}

export const WORLD_SPEEDS = [0.5, 1, 2, 5, 10, 30, 60] as const;
