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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface StateResponse {
  snapshot: WorldSnapshot;
  /** Optional while rolling out the authenticated API to older deployments. */
  viewer?: Viewer | null;
  etag?: string;
  notModified?: boolean;
}

export interface StateFetchResult {
  snapshot?: WorldSnapshot;
  viewer?: Viewer | null;
  etag?: string;
  notModified?: boolean;
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
    throw new ApiError(
      body.error ?? `Request failed (${response.status})`,
      response.status,
      body.error,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface AdminReport {
  id?: string;
  status?: string;
  reason?: string;
  characterId?: string | null;
}

export const api = {
  state: async (etag?: string): Promise<StateFetchResult> => {
    const headers = new Headers();
    if (etag) headers.set("if-none-match", etag);
    const response = await fetch(`${API_URL}/api/state`, {
      headers,
      credentials: "include",
    });
    const nextEtag = response.headers.get("etag") ?? etag;
    if (response.status === 304) return { notModified: true, etag: nextEtag };
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new ApiError(
        body.error ?? `Request failed (${response.status})`,
        response.status,
        body.error,
      );
    }
    const payload = (await response.json()) as WorldSnapshot & {
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
        etag: nextEtag,
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
      etag: nextEtag,
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
      reports?: AdminReport[];
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
  resolveReport: (reportId: string) =>
    request(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, {
      method: "POST",
      body: "{}",
    }),
  muteCharacter: (characterId: string, muted: boolean) =>
    request(`/api/admin/characters/${encodeURIComponent(characterId)}/mute`, {
      method: "POST",
      body: JSON.stringify({ muted }),
    }),
};
