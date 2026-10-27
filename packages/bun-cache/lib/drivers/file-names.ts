/**
 * Copied from `bun-jobs/lib/drivers/file-names.ts@bbe11201` (plan §8.3: the
 * small helpers are copied with an origin comment, not shared).
 *
 * Encodes a namespace as a directory name that no case-insensitive filesystem
 * can confuse with another.
 *
 * `[a-z0-9_.-]` stays as written; an uppercase letter becomes `^` and the
 * letter in lowercase. Anything else is `~` and the hex of each UTF-8 byte,
 * so the encoding is still total and exact.
 */
export function encodeSegment(segment: string): string {
  if (/^[a-z0-9_.-]*$/.test(segment)) {
    return segment;
  }

  let out = "";

  for (const char of segment) {
    if (/^[a-z0-9_.-]$/.test(char)) {
      out += char;
    } else if (/^[A-Z]$/.test(char)) {
      out += `^${char.toLowerCase()}`;
    } else {
      for (const byte of new TextEncoder().encode(char)) {
        out += `~${byte.toString(16).padStart(2, "0")}`;
      }
    }
  }

  return out;
}
