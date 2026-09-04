import { createAuthClient } from "@neondatabase/neon-js/auth";
import { BetterAuthReactAdapter } from "@neondatabase/neon-js/auth/react/adapters";

function authBaseUrl(): string {
  if (import.meta.env.DEV && import.meta.env.VITE_NEON_AUTH_URL)
    return import.meta.env.VITE_NEON_AUTH_URL;
  if (typeof window !== "undefined" && window.location?.origin)
    return `${window.location.origin}/api/auth`;
  return "/api/auth";
}

// In production Vercel proxies /api/auth to Neon Auth. Better Auth requires an
// absolute base URL, so the browser origin is prefixed onto the same-origin path.
export const NEON_AUTH_URL = authBaseUrl();

export const authClient = createAuthClient(NEON_AUTH_URL, {
  adapter: BetterAuthReactAdapter(),
});

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export function useAuth() {
  const session = authClient.useSession();
  return {
    user: (session.data?.user as AuthUser | undefined) ?? null,
    isPending: session.isPending,
    error: session.error,
  };
}

export function authErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const error = (result as { error?: unknown }).error;
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Authentication failed. Please check your details and try again.";
}
