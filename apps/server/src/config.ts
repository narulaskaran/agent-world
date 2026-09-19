export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4310;
export const DEFAULT_WEB_ORIGIN = "http://localhost:4311";
export const DEFAULT_DATABASE = "./data/agent-world.db";
export const DEFAULT_DECISION_SCALE = 1;
export const DEFAULT_SERVER_DAILY_BUDGET_MICROS = 2_000_000;
export const DEFAULT_REACTION_COOLDOWN_MS = 10_000;

export type DecisionMode = "jev" | "openrouter" | "deterministic";
export type DialogueMode = "openrouter" | "mpp" | "deterministic";

export interface WorldMode {
  decisions: DecisionMode;
  dialogue: DialogueMode;
  paidTools: boolean;
  decisionScale: number;
  serverDailyBudgetMicros: number;
}

export interface WorldConfig {
  host: string;
  port: number;
  database: string;
  webOrigin: string;
  decisionScale: number;
  reactionCooldownMs: number;
  serverDailyBudgetMicros: number;
  hasOpenRouterKey: boolean;
  openRouterApiKey: string;
  jevDecisions: boolean;
  jevModel: string;
  liveMpp: boolean;
  mppxBin: string;
  mppxAccount: string;
  logLevel: string;
  decisionScaleInvalid: boolean;
}

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORT;
};

const parseScale = (
  value: string | undefined,
): { scale: number; invalid: boolean } => {
  if (value == null || value.trim() === "")
    return { scale: DEFAULT_DECISION_SCALE, invalid: false };
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 60)
    return { scale: DEFAULT_DECISION_SCALE, invalid: true };
  return { scale, invalid: false };
};

export function decisionDelayMs(
  intervalSeconds: number,
  scale: number,
): number {
  const safe =
    Number.isFinite(scale) && scale >= 0.1 && scale <= 60 ? scale : 1;
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
  const jevDisabled = env.AGENT_WORLD_JEV_DECISIONS === "false";
  return {
    host: env.AGENT_WORLD_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.AGENT_WORLD_SERVER_PORT),
    database: env.AGENT_WORLD_DATABASE?.trim() || DEFAULT_DATABASE,
    webOrigin: env.AGENT_WORLD_WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN,
    decisionScale: scale,
    decisionScaleInvalid: invalid,
    reactionCooldownMs: Number(
      env.AGENT_WORLD_REACTION_COOLDOWN_MS ?? DEFAULT_REACTION_COOLDOWN_MS,
    ),
    serverDailyBudgetMicros: parseBudget(
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

export function describeMode(config: WorldConfig): WorldMode {
  const decisions: DecisionMode = config.jevDecisions
    ? "jev"
    : config.hasOpenRouterKey
      ? "openrouter"
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
    decisionScale: config.decisionScale,
    serverDailyBudgetMicros: config.serverDailyBudgetMicros,
  };
}
