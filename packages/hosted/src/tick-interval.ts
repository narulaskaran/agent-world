export const TICK_INTERVAL_MINUTES = [10, 30, 60] as const;
export type TickIntervalMin = (typeof TICK_INTERVAL_MINUTES)[number];
export const DEFAULT_TICK_INTERVAL_MIN: TickIntervalMin = 10;

export type TickIntervalParse = {
  minutes: TickIntervalMin;
  invalid: boolean;
};

const ALLOWED = new Set<string>(
  TICK_INTERVAL_MINUTES.map((value) => String(value)),
);

export function parseTickIntervalMin(
  raw: string | undefined,
): TickIntervalParse {
  const trimmed = raw?.trim();
  if (!trimmed) return { minutes: DEFAULT_TICK_INTERVAL_MIN, invalid: false };
  if (ALLOWED.has(trimmed))
    return {
      minutes: Number(trimmed) as TickIntervalMin,
      invalid: false,
    };
  return { minutes: DEFAULT_TICK_INTERVAL_MIN, invalid: true };
}

export function tickIntervalMs(minutes: TickIntervalMin): number {
  return minutes * 60_000;
}

export function shouldSkipWorldTick(
  lastTickAt: number,
  now: number,
  intervalMin: TickIntervalMin,
): boolean {
  if (lastTickAt <= 0) return false;
  return now - lastTickAt < tickIntervalMs(intervalMin);
}
