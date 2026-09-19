export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

const REQUEST_TIMEOUT_MS = 4_000;

export function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") };
}

export function parseDotenv(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function resolveEnv(processEnv = {}, fileEnv = {}) {
  return { ...fileEnv, ...processEnv };
}

export function redact(text, apiKey) {
  if (!apiKey) return String(text);
  return String(text).split(apiKey).join("[redacted]");
}

export function probeRequest(env) {
  const model = env.AGENT_WORLD_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  const body = {
    model,
    state: { probe: "agent-world jev connectivity" },
    questions: {
      alive: {
        type: "noul",
        instructions: "Is this a successful connectivity probe?",
      },
    },
  };
  return {
    url: OPENROUTER_DECISIONS_URL,
    apiKey,
    model,
    body,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey || "[redacted]"}`,
        "Content-Type": "application/json",
        "X-Title": "Agent World",
      },
      body: JSON.stringify(body),
    },
  };
}

export function dryRunText(request) {
  const printed = {
    url: request.url,
    method: "POST",
    headers: {
      Authorization: "Bearer [redacted]",
      "Content-Type": "application/json",
      "X-Title": "Agent World",
    },
    body: request.body,
  };
  return JSON.stringify(printed, null, 2);
}

const isNoulAnswer = (value) =>
  Boolean(
    value &&
    typeof value === "object" &&
    value.type === "noul" &&
    typeof value.noul === "number" &&
    Number.isFinite(value.noul),
  );

export function parseProbeResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("unexpected Decisions response shape");
  }
  const model = body.model;
  const answers = body.answers;
  const alive =
    answers && typeof answers === "object" ? answers.alive : undefined;
  if (typeof model !== "string" || !model.trim() || !isNoulAnswer(alive)) {
    throw new Error("unexpected Decisions response shape");
  }
  const usage =
    body.usage && typeof body.usage === "object" ? body.usage : undefined;
  const cost = usage && typeof usage.cost === "number" ? usage.cost : undefined;
  return { model, noul: alive.noul, cost };
}

export async function runJevProbe({
  argv,
  env = {},
  fileEnv = {},
  fetchImpl = fetch,
  now = Date.now,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  const args = parseArgs(argv ?? []);
  const resolved = resolveEnv(env, fileEnv);
  const request = probeRequest(resolved);
  if (args.dryRun) {
    log(dryRunText(request));
    return 0;
  }
  if (!request.apiKey) {
    error(
      "OPENROUTER_API_KEY is required. Set it in the environment or .env, or pass --dry-run.",
    );
    return 1;
  }
  const started = now();
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Agent World",
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    error(
      redact(
        `JEV probe request failed: ${err instanceof Error ? err.message : String(err)}`,
        request.apiKey,
      ),
    );
    return 1;
  }
  const text = await response.text();
  if (!response.ok) {
    error(
      redact(
        `OpenRouter ${response.status}: ${text.trim().slice(0, 200)}`,
        request.apiKey,
      ),
    );
    return 1;
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    error("unexpected Decisions response shape");
    return 1;
  }
  try {
    const result = parseProbeResponse(parsed);
    const latencyMs = Math.max(0, now() - started);
    log(`model: ${result.model}`);
    log(`answer: ${result.noul}`);
    log(`latency_ms: ${latencyMs}`);
    log(`usage.cost: ${result.cost ?? "missing"}`);
    return 0;
  } catch (err) {
    error(
      redact(err instanceof Error ? err.message : String(err), request.apiKey),
    );
    return 1;
  }
}
