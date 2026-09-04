import { z } from "zod";

export const MODEL_OPTIONS = [
  { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
] as const;

export const CharacterStateSchema = z.enum([
  "active",
  "moving",
  "waiting",
  "talking",
  "tool",
  "paused",
  "sleeping",
]);
export type CharacterState = z.infer<typeof CharacterStateSchema>;

export const FirstMissionSchema = z.enum(["meet", "explore"]);
export type FirstMission = z.infer<typeof FirstMissionSchema>;

export const ActionTypeSchema = z.enum([
  "move",
  "approach",
  "start_conversation",
  "respond",
  "end_conversation",
  "inspect_location",
  "web_search",
  "idle",
  "sleep",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const CreateCharacterSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
      "Use letters, numbers, spaces, _ or -",
    ),
  personality: z.string().trim().min(10).max(800),
  model: z.enum(
    MODEL_OPTIONS.map((model) => model.id) as [string, ...string[]],
  ),
  dailyBudgetMicros: z.number().int().min(50_000).max(2_000_000),
  decisionIntervalSeconds: z.number().int().min(30).max(900).default(60),
  firstMission: FirstMissionSchema,
});
export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>;

export const UpdateCharacterSchema = z.object({
  personality: z.string().trim().min(10).max(800).optional(),
  model: z
    .enum(MODEL_OPTIONS.map((model) => model.id) as [string, ...string[]])
    .optional(),
  dailyBudgetMicros: z.number().int().min(50_000).max(2_000_000).optional(),
  decisionIntervalSeconds: z.number().int().min(30).max(900).optional(),
  paused: z.boolean().optional(),
});
export type UpdateCharacterInput = z.infer<typeof UpdateCharacterSchema>;

export const UpdateWorldSchema = z.object({
  serverDailyBudgetMicros: z.number().int().min(0).max(50_000_000),
});
export type UpdateWorldInput = z.infer<typeof UpdateWorldSchema>;

export const DirectiveSchema = z.object({
  mode: z.enum(["directive", "personality"]),
  text: z.string().trim().min(2).max(800),
});
export type DirectiveInput = z.infer<typeof DirectiveSchema>;

export const ReportSchema = z
  .object({
    reason: z.string().trim().min(4).max(500),
    characterId: z.string().trim().min(1).max(80).optional(),
    eventId: z.string().trim().min(1).max(80).optional(),
  })
  .refine((value) => Boolean(value.characterId || value.eventId), {
    message: "Report a character or an event",
  });
export type ReportInput = z.infer<typeof ReportSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["note", "object"]).default("note"),
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(400),
});
export type ArtifactInput = z.infer<typeof ArtifactSchema>;

export const CharacterExportSchema = z.object({
  version: z.literal(1),
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
      "Use letters, numbers, spaces, _ or -",
    ),
  personality: z.string().trim().min(10).max(800),
  model: z.enum(
    MODEL_OPTIONS.map((model) => model.id) as [string, ...string[]],
  ),
  memories: z
    .array(
      z.object({
        kind: z.enum(["fact", "impression"]),
        bullet: z.string().trim().min(1).max(400),
        subject: z.string().trim().max(80).nullable().optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type CharacterExport = z.infer<typeof CharacterExportSchema>;

export const MAX_CHARACTERS_PER_USER = 5;

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
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  intent: string;
  speech: string | null;
  avatarUrl: string | null;
  avatarColor: string;
  toolActive: boolean;
  reputation: number;
  locationId: WorldLocationId | null;
  memories: PublicMemory[];
  relationships: PublicRelationship[];
  updatedAt: number;
}

export type WorldEventKind =
  | "arrival"
  | "movement"
  | "conversation"
  | "tool"
  | "memory"
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
  visibility?: "public" | "private";
  createdAt: number;
}

export type WorldLocationId =
  | "plaza"
  | "cafe"
  | "park"
  | "library"
  | "workshop";

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
    name: "Tinker Shed",
    description: "A dusty shed for making and leaving things behind.",
    x: 760,
    y: 450,
    width: 300,
    height: 190,
    color: "#b08968",
  },
];

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
    { x: 300, y: 300 },
    { x: 382, y: 245 },
  ],
  park: [
    { x: 900, y: 180 },
    { x: 790, y: 245 },
    { x: 960, y: 385 },
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

export function hashString(value: string): number {
  let result = 0;
  for (const character of value)
    result = (result * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(result);
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

export interface WorldSnapshot {
  characters: PublicCharacter[];
  events: WorldEvent[];
  locations: WorldLocation[];
  artifacts: WorldArtifact[];
  simulationPaused: boolean;
  serverSpentTodayMicros: number;
  serverDailyBudgetMicros: number;
  budgetDate: string;
  connectedViewers: number;
  generatedAt: number;
  inviteOnly?: boolean;
}

export type ServerMessage =
  | { type: "snapshot"; payload: WorldSnapshot }
  | { type: "error"; payload: { message: string } };

export const formatUsd = (micros: number): string =>
  `$${(micros / 1_000_000).toFixed(2)}`;

export function nameColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const palette = [
    "#e26d5a",
    "#579c87",
    "#6979c9",
    "#c47cab",
    "#d69b45",
    "#548db4",
  ];
  return palette[Math.abs(hash) % palette.length] ?? "#579c87";
}
