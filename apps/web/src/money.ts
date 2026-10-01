/**
 * Parses a dollar amount typed into a budget field. Returns micros, or null
 * when the text is empty, not a number, or outside `[min, max]` dollars.
 */
export function parseUsdInput(
  value: string,
  limits: { min: number; max: number },
): number | null {
  const text = value.trim();
  if (!text) return null;
  const dollars = Number(text);
  if (!Number.isFinite(dollars) || dollars < limits.min || dollars > limits.max)
    return null;
  return Math.round(dollars * 1_000_000);
}

export const microsToInput = (micros: number): string =>
  (micros / 1_000_000).toFixed(2);
