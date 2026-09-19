export const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";

const AUTH_PAUSE_MS = 60_000;
const ENDPOINT_PAUSE_MS = 60_000;
const ENDPOINT_FAILURE_LIMIT = 2;

export type OpenRouterEndpoint = "chat" | "decisions";

export interface OpenRouterRequestResult<T> {
  body: T;
  metadata: { transport: "openrouter" };
  amountMicros: number | null;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  referer?: string;
}

const redact = (text: string, apiKey: string): string => {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
};

const errorMessageFromBody = (status: number, text: string): string => {
  let detail = text.trim().slice(0, 200);
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string };
      message?: string;
    };
    if (typeof parsed.error === "string") detail = parsed.error.slice(0, 200);
    else if (typeof parsed.error?.message === "string")
      detail = parsed.error.message.slice(0, 200);
    else if (typeof parsed.message === "string")
      detail = parsed.message.slice(0, 200);
  } catch {
    // Keep the clipped raw body.
  }
  return `OpenRouter ${status}: ${detail}`;
};

const costMicrosFromUsage = (body: unknown): number | null => {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: { cost?: unknown } }).usage;
  const cost = usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost)
    ? Math.round(cost * 1_000_000)
    : null;
};

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly referer?: string;
  private authPausedUntil = 0;
  private readonly endpoints = new Map<
    OpenRouterEndpoint,
    { failures: number; pausedUntil: number }
  >();

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.referer = options.referer;
  }

  async chat(body: unknown): Promise<OpenRouterRequestResult<unknown>> {
    return this.request("chat", OPENROUTER_CHAT_URL, body, 30_000);
  }

  async decisions(body: unknown): Promise<OpenRouterRequestResult<unknown>> {
    return this.request("decisions", OPENROUTER_DECISIONS_URL, body, 4_000);
  }

  private state(endpoint: OpenRouterEndpoint) {
    const current = this.endpoints.get(endpoint) ?? {
      failures: 0,
      pausedUntil: 0,
    };
    this.endpoints.set(endpoint, current);
    return current;
  }

  private async request(
    endpoint: OpenRouterEndpoint,
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<OpenRouterRequestResult<unknown>> {
    const now = this.now();
    if (now < this.authPausedUntil) {
      throw new Error("OpenRouter paused after repeated failures");
    }
    const state = this.state(endpoint);
    if (now < state.pausedUntil) {
      throw new Error("OpenRouter paused after repeated failures");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Agent World",
          ...(this.referer ? { "HTTP-Referer": this.referer } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.recordFailure(endpoint, false);
      const message = error instanceof Error ? error.message : "network error";
      throw new Error(
        redact(`OpenRouter request failed: ${message}`, this.apiKey),
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const authFailure = [401, 402, 403].includes(response.status);
      this.recordFailure(endpoint, authFailure);
      throw new Error(
        redact(errorMessageFromBody(response.status, text), this.apiKey),
      );
    }

    state.failures = 0;
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      this.recordFailure(endpoint, false);
      throw new Error("OpenRouter 200: response was not JSON");
    }
    return {
      body: parsed,
      metadata: { transport: "openrouter" },
      amountMicros: costMicrosFromUsage(parsed),
    };
  }

  private recordFailure(endpoint: OpenRouterEndpoint, authFailure: boolean) {
    const now = this.now();
    if (authFailure) {
      this.authPausedUntil = now + AUTH_PAUSE_MS;
      return;
    }
    const state = this.state(endpoint);
    state.failures += 1;
    if (state.failures >= ENDPOINT_FAILURE_LIMIT) {
      state.pausedUntil = now + ENDPOINT_PAUSE_MS;
    }
  }
}

export class OpenRouterTransport {
  constructor(private readonly client: OpenRouterClient) {}

  async requestJson<T>(
    _url: string,
    body: unknown,
    _maxSpendMicros: number,
  ): Promise<OpenRouterRequestResult<T>> {
    const result = await this.client.chat(body);
    return {
      body: result.body as T,
      metadata: result.metadata,
      amountMicros: result.amountMicros,
    };
  }
}
