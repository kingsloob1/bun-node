/**
 * How the file driver turns names into file names, and back.
 *
 * **Case-proof.** macOS (APFS, by default) and Windows (NTFS) fold case when
 * they look a name up, so `Report.json` and `report.json` are one file there.
 * A job id, a queue-state name or a queue name that differed from another only
 * by case would silently share its file — overwriting it, and breaking the
 * idempotency the record file *is*. Linux is case-sensitive, which is why no
 * test run there ever saw it. Neither encoding below emits an uppercase letter,
 * so no two names can fold to one file.
 *
 * **Normalization-proof.** APFS also treats `é` (U+00E9) and `e` + U+0301 as
 * one name. Every character outside a small ASCII set is written as the hex of
 * its UTF-8 bytes, so output is plain ASCII that no normalization form changes,
 * and the two spellings stay two files.
 *
 * **Why two encodings.**
 *
 * - {@link encodeName} is for job ids, queue-state names and repeat keys —
 *   anything a caller chooses freely. It preserves order: the encoded names
 *   sort, bytewise, exactly as the names do in code-point order (see
 *   `compareCodePoints`). That is what lets a `readdir` sort of markers be the
 *   claim order with the id as tie-break. It also never emits `-` or `.`, which
 *   the driver uses as separators inside file names, so a marker or a hold
 *   splits one way only.
 * - {@link encodeSegment} is for namespaces, queue names and runner ids, which
 *   `assertSegment` already restricts to `[A-Za-z0-9_.-]`. Those name
 *   directories people look at, so everything but an uppercase letter stays as
 *   typed, and `Mail` becomes `^mail`. It needs no order: nothing lists these
 *   in one.
 *
 * Readability is kept where it costs nothing: lowercase letters and digits are
 * literal in both, and an uppercase letter reads as itself behind one marker.
 */

/**
 * Literal in a name: the characters that no filesystem folds and that sort in
 * the same relative order encoded as raw.
 */
const NAME_LITERAL = /^[0-9a-z]$/;

/** A byte as two lowercase hex digits. */
function toHex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/** Lowercase two-digit hex for every byte value, so encoding never formats. */
const HEX = Array.from({ length: 256 }, (_, byte) => toHex(byte));

/**
 * The encoding of each ASCII character in a name, indexed by code.
 *
 * Every character maps to a code word whose first character sorts where the
 * character does among the literals, and within a group the rest of the word
 * is fixed width and ordered. No word is a prefix of another. Together those
 * make the encoding order-preserving:
 *
 * | range | example | encoded as | first char sorts |
 * |---|---|---|---|
 * | U+0000–U+002F | `-` | `%2d` | below `0` |
 * | `0`–`9` | `7` | `7` | literal |
 * | U+003A–U+0040 | `:` | `_0` … `_6` | between `9` and `a` |
 * | `A`–`Z` | `R` | `_r` | between `9` and `a` |
 * | U+005B–U+0060 | `_` | `_~4` | between `9` and `a` |
 * | `a`–`z` | `r` | `r` | literal |
 * | U+007B–U+007F | `~` | `~7e` | above `z` |
 *
 * Above U+007F every UTF-8 byte is `~` and two hex digits, so bytes, and
 * therefore code points, compare the same encoded as raw.
 */
const NAME_ASCII: string[] = Array.from({ length: 128 }, (_, code) => {
  const char = String.fromCharCode(code);

  if (NAME_LITERAL.test(char)) {
    return char;
  }
  if (code < 0x30) {
    return `%${HEX[code]}`;
  }
  if (code <= 0x40) {
    return `_${code - 0x3a}`;
  }
  if (code <= 0x5a) {
    return `_${char.toLowerCase()}`;
  }
  if (code <= 0x60) {
    return `_~${code - 0x5b}`;
  }
  return `~${HEX[code]}`;
});

/**
 * Encodes a name as a case- and normalization-proof, order-preserving file
 * name. Total and exact: every string, lone surrogates included, round-trips
 * through {@link decodeName}.
 */
export function encodeName(name: string): string {
  let out = "";

  for (let index = 0; index < name.length; index++) {
    const unit = name.charCodeAt(index);

    if (unit < 0x80) {
      out += NAME_ASCII[unit];
      continue;
    }

    // A code point, as generalized UTF-8: a lone surrogate is encoded as the
    // three bytes its value would take, so it survives rather than collapsing
    // into U+FFFD, and still sorts by its value.
    const point = name.codePointAt(index)!;
    if (point > 0xffff) {
      index++;
    }

    if (point < 0x800) {
      out += `~${HEX[0xc0 | (point >> 6)]}~${HEX[0x80 | (point & 0x3f)]}`;
    } else if (point < 0x10000) {
      out += `~${HEX[0xe0 | (point >> 12)]}~${HEX[0x80 | ((point >> 6) & 0x3f)]}~${HEX[0x80 | (point & 0x3f)]}`;
    } else {
      out += `~${HEX[0xf0 | (point >> 18)]}~${HEX[0x80 | ((point >> 12) & 0x3f)]}~${HEX[0x80 | ((point >> 6) & 0x3f)]}~${HEX[0x80 | (point & 0x3f)]}`;
    }
  }

  return out;
}

/**
 * Decodes a file name {@link encodeName} wrote, or answers `null` for one it
 * could not have written — a file somebody else put in the directory.
 */
export function decodeName(encoded: string): string | null {
  const units: number[] = [];
  let index = 0;

  const hexByte = (at: number): number => {
    const digits = encoded.slice(at, at + 2);
    return /^[0-9a-f]{2}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
  };

  while (index < encoded.length) {
    const char = encoded[index]!;

    if (NAME_LITERAL.test(char)) {
      units.push(char.charCodeAt(0));
      index++;
      continue;
    }

    if (char === "%") {
      const byte = hexByte(index + 1);
      if (byte < 0 || byte >= 0x30) {
        return null;
      }
      units.push(byte);
      index += 3;
      continue;
    }

    if (char === "_") {
      const next = encoded[index + 1] ?? "";
      if (/^[0-6]$/.test(next)) {
        units.push(0x3a + Number(next));
        index += 2;
      } else if (/^[a-z]$/.test(next)) {
        units.push(next.toUpperCase().charCodeAt(0));
        index += 2;
      } else if (next === "~" && /^[0-5]$/.test(encoded[index + 2] ?? "")) {
        units.push(0x5b + Number(encoded[index + 2]));
        index += 3;
      } else {
        return null;
      }
      continue;
    }

    if (char !== "~") {
      return null;
    }

    const lead = hexByte(index + 1);
    if (lead < 0x7b) {
      return null;
    }
    index += 3;

    if (lead < 0x80) {
      units.push(lead);
      continue;
    }

    const extra = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : -1;
    if (extra < 0 || lead > 0xf4) {
      return null;
    }

    let point = lead & (0x3f >> extra);
    for (let count = 0; count < extra; count++) {
      const byte = encoded[index] === "~" ? hexByte(index + 1) : -1;
      if (byte < 0x80 || byte > 0xbf) {
        return null;
      }
      point = (point << 6) | (byte & 0x3f);
      index += 3;
    }

    if (point > 0xffff) {
      point -= 0x10000;
      units.push(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
    } else {
      units.push(point);
    }
  }

  const decoded = String.fromCharCode(...units);

  // Only the one spelling this encoder produces counts: an overlong sequence,
  // or a surrogate pair written as two three-byte halves, decodes to a name
  // whose real encoding is a different file.
  return encodeName(decoded) === encoded ? decoded : null;
}

/**
 * Encodes a namespace, queue name or runner id as a directory name that no
 * case-insensitive filesystem can confuse with another.
 *
 * `[a-z0-9_.-]` stays as written; an uppercase letter becomes `^` and the
 * letter in lowercase. Anything else — only reachable by a caller that skipped
 * `assertSegment` — is `~` and the hex of each UTF-8 byte, so the encoding is
 * still total and exact.
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
        out += `~${HEX[byte]}`;
      }
    }
  }

  return out;
}

/**
 * Decodes a directory name {@link encodeSegment} wrote, or answers `null` for
 * one it could not have written.
 */
export function decodeSegment(encoded: string): string | null {
  if (/^[a-z0-9_.-]*$/.test(encoded)) {
    return encoded;
  }

  const bytes: number[] = [];
  let index = 0;

  while (index < encoded.length) {
    const char = encoded[index]!;

    if (/^[a-z0-9_.-]$/.test(char)) {
      bytes.push(char.charCodeAt(0));
      index++;
    } else if (char === "^" && /^[a-z]$/.test(encoded[index + 1] ?? "")) {
      bytes.push(encoded[index + 1]!.toUpperCase().charCodeAt(0));
      index += 2;
    } else if (
      char === "~" &&
      /^[0-9a-f]{2}$/.test(encoded.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 3;
    } else {
      return null;
    }
  }

  const decoded = new TextDecoder().decode(new Uint8Array(bytes));
  return encodeSegment(decoded) === encoded ? decoded : null;
}
