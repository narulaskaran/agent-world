import type {
  ArtifactInput,
  CharacterExport,
  CreateCharacterInput,
  DirectiveInput,
  ReportInput,
  UpdateCharacterInput,
  WorldSnapshot,
} from "@agent-world/shared";

export const API_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? "http://localhost:4310" : "");

export interface Viewer {
  userId: string;
  isAdmin: boolean;
  characterId: string | null;
  characterIds?: string[];
}

export interface StateResponse {
  snapshot: WorldSnapshot;
  /** Optional while rolling out the authenticated API to older deployments. */
  viewer?: Viewer | null;
}

export interface SessionResponse {
  viewer: Viewer | null;
  session?: unknown;
  user?: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
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
  state: async (): Promise<StateResponse> => {
    const payload = (await request<
      WorldSnapshot & {
        viewer?: Viewer | null;
        snapshot?: WorldSnapshot;
      }
    >("/api/state")) as WorldSnapshot & {
      viewer?: Viewer | null;
      snapshot?: WorldSnapshot;
    };
    // Accept both the existing flat snapshot and the authenticated envelope
    // so the client can be deployed before/after the API migration.
    if (payload.snapshot) {
      return {
        snapshot: {
          ...payload.snapshot,
          artifacts: payload.snapshot.artifacts ?? [],
        },
        viewer: payload.viewer,
      };
    }
    const { viewer, ...snapshot } = payload;
    const world = snapshot as WorldSnapshot;
    return {
      snapshot: {
        ...world,
        artifacts: world.artifacts ?? [],
      },
      viewer,
    };
  },
  session: () => request<SessionResponse>("/api/auth/session"),
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
  exportCharacter: (name: string) =>
    request<CharacterExport>(
      `/api/characters/${encodeURIComponent(name)}/export`,
    ),
  importCharacter: (input: CharacterExport) =>
    request("/api/characters/import", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  leaveArtifact: (name: string, input: ArtifactInput) =>
    request(`/api/characters/${encodeURIComponent(name)}/artifacts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  report: (input: ReportInput) =>
    request("/api/reports", { method: "POST", body: JSON.stringify(input) }),
  admin: () =>
    request<{
      liveMpp: boolean;
      queueDepth: number;
      costs: unknown[];
      world: Record<string, unknown>;
      inFlight: string[];
      reports?: unknown[];
      alerts?: unknown[];
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
  hideEvent: (eventId: string) =>
    request(`/api/admin/events/${encodeURIComponent(eventId)}/hide`, {
      method: "POST",
      body: "{}",
    }),
};
