/**
 * Text edits by UTF-16 offset: the one edit that turns a buffer into
 * `bun fmt`'s output, and "Fix all" from a report's fixes. Offsets are what
 * `vscode.TextDocument.positionAt` takes, so the extension converts them there.
 */
import type { Fix } from "./report";

/** One replacement, by UTF-16 offsets. */
export interface OffsetEdit {
  /** Offset of the first character replaced. */
  start: number;
  /** Offset just past the last character replaced. */
  end: number;
  /** The replacement. */
  text: string;
}

/**
 * The single smallest edit that turns `before` into `after`: everything
 * between their common prefix and common suffix. One edit rather than a
 * whole-document replacement keeps the cursor, folding and markers outside
 * the changed region where they were.
 * @param before The buffer.
 * @param after What it should become.
 * @returns The edit, or `undefined` when the two are equal.
 */
export function minimalEdit(
  before: string,
  after: string,
): OffsetEdit | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix))
    prefix++;
  // Never split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix)))
    suffix--;
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

/**
 * @param code A UTF-16 code unit.
 * @returns Whether it opens a surrogate pair.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param code A UTF-16 code unit.
 * @returns Whether it closes a surrogate pair.
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The fixes one pass can apply together, as ESLint's `SourceCodeFixer`
 * chooses them: sorted by start, and a fix that starts at or before the end
 * of the last one taken is left for the next run (`lastPos >= start`), as is
 * a backwards range.
 * @param fixes The report's fixes, in any order.
 * @returns The fixes to apply, sorted by start.
 */
export function mergeFixes(fixes: Fix[]): Fix[] {
  const sorted = [...fixes].sort(
    (a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1],
  );
  const taken: Fix[] = [];
  let lastPos = Number.NEGATIVE_INFINITY;
  for (const fix of sorted) {
    const [start, end] = fix.range;
    if (lastPos >= start || start > end) continue;
    taken.push(fix);
    lastPos = end;
  }
  return taken;
}

/**
 * Applies non-overlapping fixes to a text.
 * @param text The buffer the fixes were computed on.
 * @param fixes Fixes from `mergeFixes`.
 * @returns The fixed text.
 */
export function applyFixes(text: string, fixes: Fix[]): string {
  let out = "";
  let at = 0;
  for (const fix of mergeFixes(fixes)) {
    out += text.slice(at, fix.range[0]) + fix.text;
    at = fix.range[1];
  }
  return out + text.slice(at);
}

/**
 * The fixes as edits, ready for one `WorkspaceEdit`.
 * @param fixes The report's fixes.
 * @returns One edit per fix that one pass can apply.
 */
export function fixEdits(fixes: Fix[]): OffsetEdit[] {
  return mergeFixes(fixes).map((f) => ({
    start: f.range[0],
    end: f.range[1],
    text: f.text,
  }));
}
