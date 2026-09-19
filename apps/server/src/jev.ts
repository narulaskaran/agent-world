import { WORLD_LOCATIONS, type WorldLocationId } from "@agent-world/shared";
import { DEFAULT_JEV_MODEL } from "./config.js";
import type { OpenRouterClient } from "./openrouter.js";
import type { AgentContext, AgentDecision } from "./services.js";

export const MIN_ACTION_CONFIDENCE = 0.4;
export const JEV_RESERVATION_MICROS = 300;
export const JEV_BREAKER_FAILURES = 2;
export const JEV_BREAKER_COOLDOWN_MS = 60_000;
const MAX_PEOPLE = 6;
const MEMORY_LIMIT = 5;

type JevAnswer = {
  type?: string;
  choice?: string;
  confidence?: number;
};

interface JevChoice {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevPartner {
  id: string;
  name: string;
  state: string;
  distance: number;
  locationId?: string | null;
}

export const relationshipWord = (affinity: number | undefined): string =>
  affinity === undefined
    ? "stranger"
    : affinity < 20
      ? "acquaintance"
      : affinity < 50
        ? "friend"
        : "close friend";

export const availablePartners = (context: AgentContext): JevPartner[] =>
  context.nearby
    .filter(
      (person) =>
        person.state !== "talking" &&
        person.state !== "sleeping" &&
        person.state !== "paused",
    )
    .slice(0, MAX_PEOPLE);

export function jevCostMicros(
  responseBody: unknown,
  requestBody: unknown,
): number {
  const usage =
    responseBody && typeof responseBody === "object"
      ? (responseBody as { usage?: { cost?: unknown; input_tokens?: unknown } })
          .usage
      : undefined;
  if (usage && typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
    return Math.max(1, Math.ceil(usage.cost * 1_000_000));
  }
  if (
    usage &&
    typeof usage.input_tokens === "number" &&
    Number.isFinite(usage.input_tokens)
  ) {
    return Math.max(1, Math.ceil(usage.input_tokens * 0.042));
  }
  return Math.max(
    1,
    Math.ceil((JSON.stringify(requestBody).length / 4) * 0.042),
  );
}

const pick = (
  answer: JevAnswer | undefined,
  allowed: Set<string>,
): { choice: string; confidence: number } | null =>
  answer?.type === "choice" &&
  typeof answer.choice === "string" &&
  allowed.has(answer.choice)
    ? { choice: answer.choice, confidence: answer.confidence ?? 0 }
    : null;

const answersFromBody = (
  body: unknown,
): Record<string, JevAnswer | undefined> | null => {
  if (!body || typeof body !== "object") return null;
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return null;
  }
  return answers as Record<string, JevAnswer | undefined>;
};

const locationName = (locationId: string): string =>
  WORLD_LOCATIONS.find((location) => location.id === locationId)?.name ??
  locationId;

export function buildJevBody(
  context: AgentContext,
  model: string,
): {
  model: string;
  state: Record<string, unknown>;
  questions: {
    action: JevChoice;
    walk_to: JevChoice;
    inspect_what: JevChoice;
    partner?: JevChoice;
  };
} {
  const partners = availablePartners(context);
  const affinityByName = new Map(
    (context.relationships ?? []).map((item) => [item.name, item.affinity]),
  );
  const occupancy = (locationId: string) =>
    context.nearby.filter((person) => person.locationId === locationId).length;
  const places = WORLD_LOCATIONS.map((location) => ({
    id: location.id,
    name: location.name,
    description: location.description,
    people_there: occupancy(location.id),
    is_current_place: location.id === context.area.id,
  }));
  const state = {
    character: {
      name: context.name,
      personality: context.personality.slice(0, 240),
      currently: context.intent.slice(0, 140),
      current_place: context.area.name,
    },
    people_here: partners.map((person) => ({
      name: person.name,
      relationship: relationshipWord(affinityByName.get(person.name)),
      doing: person.state,
    })),
    places,
    recent_memories: context.memories
      .slice(0, MEMORY_LIMIT)
      .map((memory) => memory.bullet),
    relationships: (context.relationships ?? []).map((item) => ({
      name: item.name,
      relationship: relationshipWord(item.affinity),
    })),
  };
  const questions: {
    action: JevChoice;
    walk_to: JevChoice;
    inspect_what: JevChoice;
    partner?: JevChoice;
  } = {
    action: {
      type: "choice",
      instructions:
        "What does this character do next? Weigh their personality, what they are doing now, who is nearby, and their memories.",
      criteria: {
        ...(partners.length > 0
          ? { talk: "Start a conversation with someone who is here." }
          : {}),
        inspect: "Look closely at a place and remember something about it.",
        walk: "Wander to a different place, perhaps to find company.",
      },
    },
    walk_to: {
      type: "choice",
      instructions:
        "Which place would this character most like to walk to next?",
      criteria: Object.fromEntries(
        places
          .filter((place) => !place.is_current_place)
          .map((place) => [
            place.id,
            `${place.name}: ${place.description} (${place.people_there} people there)`,
          ]),
      ),
    },
    inspect_what: {
      type: "choice",
      instructions:
        "Which place would this character most like to study closely?",
      criteria: Object.fromEntries(
        places.map((place) => [
          place.id,
          `${place.name}: ${place.description}`,
        ]),
      ),
    },
  };
  if (partners.length > 0) {
    questions.partner = {
      type: "choice",
      instructions: "Who would this character most like to talk to right now?",
      criteria: Object.fromEntries(
        partners.map((person) => [
          person.name,
          `${relationshipWord(affinityByName.get(person.name))}; currently: ${person.state}`,
        ]),
      ),
    };
  }
  return { model, state, questions };
}

export function mapJevDecision(
  body: unknown,
  context: AgentContext,
): AgentDecision | null {
  const answers = answersFromBody(body);
  if (!answers) return null;
  const partners = availablePartners(context);
  const actions = new Set<string>([
    ...(partners.length > 0 ? ["talk"] : []),
    "inspect",
    "walk",
  ]);
  const action = pick(answers.action, actions);
  if (!action || action.confidence < MIN_ACTION_CONFIDENCE) return null;
  const locationIds = new Set<string>(WORLD_LOCATIONS.map((item) => item.id));
  if (action.choice === "inspect" || action.choice === "walk") {
    const allowed =
      action.choice === "walk"
        ? new Set(
            WORLD_LOCATIONS.filter((item) => item.id !== context.area.id).map(
              (item) => item.id,
            ),
          )
        : locationIds;
    const answer = pick(
      action.choice === "walk" ? answers.walk_to : answers.inspect_what,
      allowed,
    );
    if (!answer) return null;
    const locationId = answer.choice as WorldLocationId;
    return action.choice === "walk"
      ? {
          action: "move",
          locationId,
          intent: `Exploring ${locationName(locationId)}`,
        }
      : {
          action: "inspect_location",
          locationId,
          intent: `Looking around ${locationName(locationId)}`,
        };
  }
  const partner = pick(
    answers.partner,
    new Set(partners.map((person) => person.name)),
  );
  const first = partners.find((person) => person.name === partner?.choice);
  if (!first) return null;
  return {
    action: "approach",
    targetCharacterId: first.id,
    intent: `Ask ${first.name} what they have noticed around ${context.area.name}`,
  };
}

export interface JevDecideResult {
  decision: AgentDecision | null;
  costMicros: number;
  metadata: Record<string, unknown>;
  requestBody: ReturnType<typeof buildJevBody>;
}

export class JevDecider {
  private readonly client: OpenRouterClient;
  private readonly model: string;
  private readonly now: () => number;
  private failures = 0;
  private pausedUntil = 0;

  constructor(options: {
    client: OpenRouterClient;
    model?: string;
    now?: () => number;
  }) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.now = options.now ?? Date.now;
  }

  isPaused(): boolean {
    return this.now() < this.pausedUntil;
  }

  async decide(context: AgentContext): Promise<JevDecideResult> {
    if (this.isPaused()) {
      throw new Error("JEV paused after repeated failures");
    }
    const requestBody = buildJevBody(context, this.model);
    try {
      const result = await this.client.decisions(requestBody);
      this.failures = 0;
      return {
        decision: mapJevDecision(result.body, context),
        costMicros: jevCostMicros(result.body, requestBody),
        metadata: { ...result.metadata, provider: "openrouter-jev" },
        requestBody,
      };
    } catch (error) {
      this.failures += 1;
      if (this.failures >= JEV_BREAKER_FAILURES) {
        this.pausedUntil = this.now() + JEV_BREAKER_COOLDOWN_MS;
      }
      throw error;
    }
  }
}
