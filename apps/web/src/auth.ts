import { createAuthClient } from "@neondatabase/neon-js/auth";
import { BetterAuthReactAdapter } from "@neondatabase/neon-js/auth/react/adapters";

// In production Vercel can proxy /api/auth to Neon Auth. Supplying
// VITE_NEON_AUTH_URL is useful when the hosted Auth URL is exposed directly.
export const NEON_AUTH_URL =
  import.meta.env.DEV && import.meta.env.VITE_NEON_AUTH_URL
    ? import.meta.env.VITE_NEON_AUTH_URL
    : "/api/auth";

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
