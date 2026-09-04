export type LogLevel = "info" | "warn" | "error" | "alert";

export interface LogEvent {
  level: LogLevel;
  msg: string;
  requestId?: string;
  path?: string;
  method?: string;
  status?: number;
  userId?: string;
  characterId?: string;
  jobId?: string;
  kind?: string;
  durationMs?: number;
  processed?: number;
}

const SECRET_KEYS = /cookie|authorization|password|secret|token|key|email/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(entry);
  }
  return result;
}

export function logEvent(event: LogEvent): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "agent-world",
      ...event,
    }),
  );
}

export async function postOperatorAlert(
  url: string | undefined,
  event: LogEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  try {
    await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "agent-world",
        ts: new Date().toISOString(),
        level: event.level,
        msg: event.msg,
        kind: event.kind,
        path: event.path,
      }),
    });
  } catch (error) {
    logEvent({
      level: "error",
      msg: "operator alert webhook failed",
      kind: error instanceof Error ? error.message : String(error),
    });
  }
}
