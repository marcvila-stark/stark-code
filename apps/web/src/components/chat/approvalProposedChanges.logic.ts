/** Longest name kept whole; a longer one keeps its end, which carries the extension. */
const MAX_TAIL = 32;

/**
 * How many trailing characters (code points, as `MiddleTruncate` counts) of a file row's path
 * stay visible: the file name, so a narrow card cuts the directory and not the name. For a
 * rename, the new name.
 */
export function approvalPathTailLength(displayPath: string): number {
  const name = displayPath.split(/[\\/]/u).at(-1) ?? displayPath;
  return Math.min(MAX_TAIL, Math.max(1, Array.from(name).length));
}

/**
 * The narrowest a file row's path gets: the width of its kept name (in the row's monospace
 * `ch`), capped at the row. The directory gives way first; once only the name is left, the
 * row wraps its +/- counts below rather than cutting the name.
 */
export function approvalPathMinWidth(displayPath: string): string {
  return `min(${approvalPathTailLength(displayPath)}ch, 100%)`;
}
