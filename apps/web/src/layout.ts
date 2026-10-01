/**
 * Widest viewport that uses the compact layout: header chips hidden, the
 * activity feed as a sheet and the inspector docked to the bottom.
 * `styles.css` uses the same width in its compact `@media` block.
 */
export const COMPACT_LAYOUT_MAX_WIDTH = 900;

export const COMPACT_LAYOUT_QUERY = `(max-width: ${COMPACT_LAYOUT_MAX_WIDTH}px)`;
