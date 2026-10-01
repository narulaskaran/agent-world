import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACT_LAYOUT_MAX_WIDTH, COMPACT_LAYOUT_QUERY } from "./layout";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("compact layout breakpoint", () => {
  it("is the stylesheet's single widest max-width breakpoint", () => {
    const widths = [...styles.matchAll(/@media \(max-width: (\d+)px\)/g)].map(
      (match) => Number(match[1]),
    );
    expect(Math.max(...widths)).toBe(COMPACT_LAYOUT_MAX_WIDTH);
    expect(
      widths.filter((width) => width === COMPACT_LAYOUT_MAX_WIDTH),
    ).toHaveLength(1);
    expect(styles).toContain(`@media ${COMPACT_LAYOUT_QUERY} {`);
  });
});
