import {
  MAX_DECISION_SCALE,
  MIN_DECISION_SCALE,
  type BrainMode,
  type DecisionMode,
  type DialogueMode,
} from "@agent-world/shared";

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4310;
export const DEFAULT_WEB_ORIGIN = "http://localhost:4311";
export const DEFAULT_DATABASE = "./data/agent-world.db";
export const DEFAULT_DECISION_SCALE = 1;
export const DEFAULT_SERVER_DAILY_BUDGET_MICROS = 2_000_000;
export const DEFAULT_REACTION_COOLDOWN_MS = 10_000;

export type { DecisionMode, DialogueMode };

export interface WorldConfig {
  host: string;
  port: number;
  database: string;
  webOrigin: string;
  /** Extra `Host` header values accepted besides loopback names. */
  allowedHosts: string[];
  decisionScale: number;
  decisionScaleInvalid: boolean;
  /** True when the env var was set, so it overrides the stored value. */
  decisionScaleFromEnv: boolean;
  reactionCooldownMs: number;
  reactionCooldownInvalid: boolean;
  serverDailyBudgetMicros: number;
  serverDailyBudgetFromEnv: boolean;
  hasOpenRouterKey: boolean;
  openRouterApiKey: string;
  jevDecisions: boolean;
  jevModel: string;
  liveMpp: boolean;
  mppxBin: string;
  mppxAccount: string;
  logLevel: string;
}

const isBlank = (value: string | undefined) =>
  value == null || value.trim() === "";

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORT;
};

const parseScale = (
  value: string | undefined,
): { scale: number; invalid: boolean } => {
  if (isBlank(value)) return { scale: DEFAULT_DECISION_SCALE, invalid: false };
  const scale = Number(value);
  if (
    !Number.isFinite(scale) ||
    scale < MIN_DECISION_SCALE ||
    scale > MAX_DECISION_SCALE
  )
    return { scale: DEFAULT_DECISION_SCALE, invalid: true };
  return { scale, invalid: false };
};

const parseCooldown = (
  value: string | undefined,
): { cooldown: number; invalid: boolean } => {
  if (isBlank(value))
    return { cooldown: DEFAULT_REACTION_COOLDOWN_MS, invalid: false };
  const cooldown = Number(value);
  return Number.isFinite(cooldown) && cooldown >= 0
    ? { cooldown: Math.floor(cooldown), invalid: false }
    : { cooldown: DEFAULT_REACTION_COOLDOWN_MS, invalid: true };
};

export function decisionDelayMs(
  intervalSeconds: number,
  scale: number,
): number {
  const safe =
    Number.isFinite(scale) &&
    scale >= MIN_DECISION_SCALE &&
    scale <= MAX_DECISION_SCALE
      ? scale
      : 1;
  const seconds = Number.isFinite(intervalSeconds) ? intervalSeconds : 60;
  return Math.max(1, Math.round((seconds * 1_000) / safe));
}

const parseBudget = (value: string | undefined): number => {
  const budget = Number(value ?? DEFAULT_SERVER_DAILY_BUDGET_MICROS);
  return Number.isFinite(budget) && budget >= 0
    ? Math.floor(budget)
    : DEFAULT_SERVER_DAILY_BUDGET_MICROS;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): WorldConfig {
  const openRouterApiKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  const hasOpenRouterKey = openRouterApiKey.length > 0;
  const { scale, invalid } = parseScale(env.AGENT_WORLD_DECISION_SCALE);
  const cooldown = parseCooldown(env.AGENT_WORLD_REACTION_COOLDOWN_MS);
  const jevDisabled = env.AGENT_WORLD_JEV_DECISIONS === "false";
  return {
    host: env.AGENT_WORLD_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.AGENT_WORLD_SERVER_PORT),
    database: env.AGENT_WORLD_DATABASE?.trim() || DEFAULT_DATABASE,
    webOrigin: env.AGENT_WORLD_WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN,
    allowedHosts: (env.AGENT_WORLD_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    decisionScale: scale,
    decisionScaleInvalid: invalid,
    decisionScaleFromEnv: !isBlank(env.AGENT_WORLD_DECISION_SCALE) && !invalid,
    reactionCooldownMs: cooldown.cooldown,
    reactionCooldownInvalid: cooldown.invalid,
    serverDailyBudgetMicros: parseBudget(
      env.AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS,
    ),
    serverDailyBudgetFromEnv: !isBlank(
      env.AGENT_WORLD_GLOBAL_DAILY_BUDGET_MICROS,
    ),
    hasOpenRouterKey,
    openRouterApiKey,
    jevDecisions: hasOpenRouterKey && !jevDisabled,
    jevModel: env.AGENT_WORLD_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    liveMpp: env.AGENT_WORLD_LIVE_MPP === "true",
    mppxBin: env.MPPX_BIN?.trim() || "",
    mppxAccount: env.MPPX_ACCOUNT?.trim() || "agent-world",
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}

export function describeMode(config: WorldConfig): BrainMode {
  const decisions: DecisionMode = config.jevDecisions
    ? "jev"
    : config.hasOpenRouterKey
      ? "openrouter"
      : config.liveMpp
        ? "mpp"
        : "deterministic";
  const dialogue: DialogueMode = config.hasOpenRouterKey
    ? "openrouter"
    : config.liveMpp
      ? "mpp"
      : "deterministic";
  return {
    decisions,
    dialogue,
    paidTools: config.liveMpp,
    budgeted: config.hasOpenRouterKey || config.liveMpp,
  };
}
