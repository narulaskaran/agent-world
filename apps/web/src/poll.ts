export const FOREGROUND_POLL_MS = 4_000;
export const MAX_ERROR_BACKOFF_MS = 60_000;

export const isStateUnavailable = (error: unknown): boolean => {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    const code =
      "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    const message = error instanceof Error ? error.message : "";
    return (
      status >= 500 ||
      code === "DATABASE_UNAVAILABLE" ||
      /DATABASE_UNAVAILABLE/i.test(message)
    );
  }
  return error instanceof Error && /DATABASE_UNAVAILABLE/i.test(error.message);
};

export const nextPollDelayMs = (input: {
  visible: boolean;
  unavailable: boolean;
  previousDelayMs: number;
}): number | null => {
  if (!input.visible) return null;
  if (!input.unavailable) return FOREGROUND_POLL_MS;
  const previous =
    input.previousDelayMs > 0 ? input.previousDelayMs : FOREGROUND_POLL_MS;
  return Math.min(previous * 2, MAX_ERROR_BACKOFF_MS);
};
