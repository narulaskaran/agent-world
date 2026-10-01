import { z } from "zod";
import {
  ACTION_TYPES,
  CHARACTER_STATES,
  FIRST_MISSIONS,
  MAX_DECISION_SCALE,
  MIN_DECISION_SCALE,
  MODEL_OPTIONS,
} from "./world.js";

export * from "./world.js";

const MODEL_IDS = MODEL_OPTIONS.map((model) => model.id) as [
  string,
  ...string[],
];

const CHARACTER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;

export const CharacterStateSchema = z.enum(CHARACTER_STATES);
export const FirstMissionSchema = z.enum(FIRST_MISSIONS);
export const ActionTypeSchema = z.enum(ACTION_TYPES);

export const CreateCharacterSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(CHARACTER_NAME_PATTERN, "Use letters, numbers, spaces, _ or -"),
  personality: z.string().trim().min(10).max(800),
  model: z.enum(MODEL_IDS),
  dailyBudgetMicros: z.number().int().min(50_000).max(2_000_000),
  decisionIntervalSeconds: z.number().int().min(30).max(900).default(60),
  firstMission: FirstMissionSchema,
});
export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>;

export const UpdateCharacterSchema = z.object({
  personality: z.string().trim().min(10).max(800).optional(),
  model: z.enum(MODEL_IDS).optional(),
  dailyBudgetMicros: z.number().int().min(50_000).max(2_000_000).optional(),
  decisionIntervalSeconds: z.number().int().min(30).max(900).optional(),
  paused: z.boolean().optional(),
});
export type UpdateCharacterInput = z.infer<typeof UpdateCharacterSchema>;

export const UpdateWorldSchema = z
  .object({
    serverDailyBudgetMicros: z.number().int().min(0).max(50_000_000),
    decisionScale: z.number().min(MIN_DECISION_SCALE).max(MAX_DECISION_SCALE),
  })
  .partial()
  .refine(
    (value) =>
      value.serverDailyBudgetMicros !== undefined ||
      value.decisionScale !== undefined,
    { message: "Nothing to update" },
  );
export type UpdateWorldInput = z.infer<typeof UpdateWorldSchema>;

export const PauseWorldSchema = z.object({ paused: z.boolean() });
export const ResetWorldSchema = z.object({ confirm: z.literal("reset") });

export const DirectiveSchema = z.object({
  mode: z.enum(["directive", "personality"]),
  text: z.string().trim().min(2).max(800),
});
export type DirectiveInput = z.infer<typeof DirectiveSchema>;
