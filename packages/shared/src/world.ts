export const MODEL_OPTIONS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
] as const;

export const CHARACTER_STATES = [
  "active",
  "moving",
  "waiting",
  "talking",
  "tool",
  "paused",
  "sleeping",
] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

export const FIRST_MISSIONS = ["meet", "explore"] as const;
export type FirstMission = (typeof FIRST_MISSIONS)[number];

export const ACTION_TYPES = [
  "move",
  "approach",
  "start_conversation",
  "respond",
  "end_conversation",
  "inspect_location",
  "leave_artifact",
  "web_search",
  "idle",
  "sleep",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const BUDGET_SLEEP_INTENT = "Sleeping until the daily budget resets";

export const MIN_DECISION_SCALE = 0.1;
export const MAX_DECISION_SCALE = 60;

export type DecisionMode = "jev" | "openrouter" | "mpp" | "deterministic";
export type DialogueMode = "openrouter" | "mpp" | "deterministic";

/** Which brain drives the world. `budgeted` is false when nothing costs money. */
export interface BrainMode {
  decisions: DecisionMode;
  dialogue: DialogueMode;
  paidTools: boolean;
  budgeted: boolean;
}

export interface PublicMemory {
  id: string;
  kind: "fact" | "impression";
  bullet: string;
  subject: string | null;
  confidence: number;
  createdAt: number;
}

export interface PublicRelationship {
  characterId: string;
  characterName: string;
  impression: string;
  affinity: number;
}

export interface PublicCharacter {
  id: string;
  name: string;
  personality: string;
  model: string;
  dailyBudgetMicros: number;
  spentTodayMicros: number;
  decisionIntervalSeconds: number;
  state: CharacterState;
  /** Position at `generatedAt` (server clock). */
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  /** Server time the current walk ends; equal to `generatedAt` or earlier when standing. */
  movementArrivesAt: number;
  intent: string;
  speech: string | null;
  avatarUrl: string | null;
  avatarColor: string;
  toolActive: boolean;
  reputation: number;
  locationId: WorldLocationId | null;
  currentConversationId: string | null;
  updatedAt: number;
}

/** Personality, memories, and relationships for the selected inspector. */
export interface CharacterInspect {
  id: string;
  name: string;
  personality: string;
  model: string;
  dailyBudgetMicros: number;
  spentTodayMicros: number;
  decisionIntervalSeconds: number;
  reputation: number;
  locationId: WorldLocationId | null;
  memories: PublicMemory[];
  relationships: PublicRelationship[];
}

export type WorldEventKind =
  | "arrival"
  | "movement"
  | "conversation"
  | "tool"
  | "memory"
  | "artifact"
  | "system"
  | "owner";

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  characterId: string | null;
  characterName: string | null;
  targetCharacterId: string | null;
  summary: string;
  detail: string | null;
  conversationId?: string | null;
  createdAt: number;
}

export type WorldLocationId =
  "plaza" | "cafe" | "park" | "library" | "workshop";

export interface WorldLocation {
  id: WorldLocationId;
  name: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface WorldArtifact {
  id: string;
  locationId: WorldLocationId;
  characterId: string | null;
  characterName: string | null;
  kind: "note" | "object";
  title: string;
  body: string;
  x: number;
  y: number;
  createdAt: number;
}

export const WORLD_WIDTH = 1120;
export const WORLD_HEIGHT = 700;

export const WORLD_LOCATIONS: WorldLocation[] = [
  {
    id: "plaza",
    name: "Sunbeam Plaza",
    description: "The social center of Agent World.",
    x: 390,
    y: 235,
    width: 340,
    height: 230,
    color: "#e7c98e",
  },
  {
    id: "cafe",
    name: "The Tiny Cup",
    description: "A warm café for long conversations.",
    x: 55,
    y: 60,
    width: 280,
    height: 205,
    color: "#ca8f65",
  },
  {
    id: "park",
    name: "Mossbell Park",
    description: "Flowers and open room to wander.",
    x: 760,
    y: 55,
    width: 305,
    height: 250,
    color: "#8fbd79",
  },
  {
    id: "library",
    name: "The Memory Stack",
    description: "A quiet home for ideas and discoveries.",
    x: 65,
    y: 450,
    width: 325,
    height: 190,
    color: "#8a87ad",
  },
  {
    id: "workshop",
    name: "The Tinker Shed",
    description: "A dusty shed for making and leaving things behind.",
    x: 760,
    y: 450,
    width: 300,
    height: 190,
    color: "#b08968",
  },
];

/** Standing spots. Every point lies inside its own location rectangle. */
export const LOCATION_WAYPOINTS: Record<
  WorldLocationId,
  Array<{ x: number; y: number }>
> = {
  plaza: [
    { x: 455, y: 275 },
    { x: 690, y: 275 },
    { x: 455, y: 420 },
    { x: 690, y: 420 },
  ],
  cafe: [
    { x: 190, y: 180 },
    { x: 285, y: 215 },
    { x: 300, y: 110 },
  ],
  park: [
    { x: 900, y: 180 },
    { x: 790, y: 245 },
    { x: 990, y: 270 },
  ],
  library: [
    { x: 220, y: 540 },
    { x: 370, y: 595 },
    { x: 310, y: 605 },
  ],
  workshop: [
    { x: 880, y: 520 },
    { x: 820, y: 560 },
    { x: 940, y: 560 },
  ],
};

/** Grounded things a character can notice when inspecting a place. */
export const LOCATION_DETAILS: Record<WorldLocationId, string[]> = {
  plaza: [
    "the fountain throws rings of ripples across its basin",
    "the plaza is where most paths in the world cross",
    "people tend to linger near the fountain before heading off",
  ],
  cafe: [
    "the café windows glow warm even in daylight",
    "the café has a counter and a sunny spot by the door",
    "the chimney on the café roof is always a little smoky",
  ],
  park: [
    "pink, orange and blue flowers grow between the park trees",
    "the park has the most open room to wander",
    "three tall trees shade the north side of the park",
  ],
  library: [
    "the library's stacked upper floors make it the tallest building",
    "two pale columns frame the library entrance",
    "the library is the quietest corner of the world",
  ],
  workshop: [
    "the Tinker Shed has a workbench beside its door",
    "a chimney pipe pokes out of the Tinker Shed roof",
    "things made in the Tinker Shed stay there for others to find",
  ],
};

function stringHash(value: string): number {
  let result = 0;
  for (const character of value)
    result = (result * 31 + character.charCodeAt(0)) | 0;
  return result;
}

export function hashString(value: string): number {
  return Math.abs(stringHash(value));
}

export function locationAtPoint(
  x: number,
  y: number,
): WorldLocation | undefined {
  return WORLD_LOCATIONS.find(
    (location) =>
      x >= location.x &&
      x <= location.x + location.width &&
      y >= location.y &&
      y <= location.y + location.height,
  );
}

export const locationName = (locationId: string): string =>
  WORLD_LOCATIONS.find((location) => location.id === locationId)?.name ??
  locationId;

/** A place name for the middle of a sentence: "The Tiny Cup" → "the Tiny Cup". */
export const placeInSentence = (name: string): string =>
  name.replace(/^The /, "the ");

export type RelationshipTier =
  "stranger" | "acquaintance" | "friend" | "close friend";

/** Affinity grows by one per finished conversation. */
export const relationshipTier = (
  affinity: number | undefined,
): RelationshipTier =>
  affinity === undefined || affinity <= 0
    ? "stranger"
    : affinity < 3
      ? "acquaintance"
      : affinity < 8
        ? "friend"
        : "close friend";

export interface WorldSnapshot {
  characters: PublicCharacter[];
  events: WorldEvent[];
  locations: WorldLocation[];
  artifacts: WorldArtifact[];
  simulationPaused: boolean;
  serverSpentTodayMicros: number;
  serverDailyBudgetMicros: number;
  budgetDate: string;
  decisionScale: number;
  brain: BrainMode;
  generatedAt: number;
}

export interface WorldRecap {
  since: number;
  until: number;
  conversations: number;
  memories: number;
  arrivals: number;
  artifacts: number;
  highlights: WorldEvent[];
}

export type ServerMessage =
  | { type: "snapshot"; payload: WorldSnapshot }
  | { type: "error"; payload: { message: string } };

export const formatUsd = (micros: number): string =>
  `$${(micros / 1_000_000).toFixed(2)}`;

export function nameColor(name: string): string {
  const palette = [
    "#e26d5a",
    "#579c87",
    "#6979c9",
    "#c47cab",
    "#d69b45",
    "#548db4",
  ];
  return palette[Math.abs(stringHash(name)) % palette.length] ?? "#579c87";
}
