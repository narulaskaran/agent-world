import type {
  CreateCharacterInput,
  DirectiveInput,
  UpdateCharacterInput,
  WorldSnapshot,
} from "@agent-world/shared";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4310";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  state: () => request<WorldSnapshot>("/api/state"),
  create: (input: CreateCharacterInput) =>
    request("/api/characters", { method: "POST", body: JSON.stringify(input) }),
  update: (name: string, input: UpdateCharacterInput) =>
    request(`/api/characters/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  directive: (name: string, input: DirectiveInput) =>
    request(`/api/characters/${encodeURIComponent(name)}/directives`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  avatar: (name: string) =>
    request(`/api/characters/${encodeURIComponent(name)}/avatar`, {
      method: "POST",
      body: "{}",
    }),
  remove: (name: string) =>
    request(`/api/characters/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  admin: () =>
    request<{
      liveMpp: boolean;
      queueDepth: number;
      costs: unknown[];
      world: Record<string, unknown>;
      inFlight: string[];
    }>("/api/admin"),
  pauseWorld: (paused: boolean) =>
    request("/api/admin/pause", {
      method: "POST",
      body: JSON.stringify({ paused }),
    }),
  updateWorld: (serverDailyBudgetMicros: number) =>
    request("/api/admin", {
      method: "PATCH",
      body: JSON.stringify({ serverDailyBudgetMicros }),
    }),
  resetWorld: () => request("/api/admin/reset", { method: "POST", body: "{}" }),
};
