/**
 * Compares two strings by Unicode code point.
 *
 * That is the order UTF-8 bytes sort in, and so the order every backend with
 * a byte comparison produces: Redis `BYLEX`, MongoDB's default, SQLite's
 * `BINARY`, Postgres' `"C"` collation and MySQL's binary comparison. Any
 * listing the driver contract orders is ordered this way, so that paging with
 * `after` means the same thing whichever backend holds the data.
 *
 * JavaScript's default `sort()` is *not* this order. It compares UTF-16 code
 * units, and a character above U+FFFF is two units starting at U+D800 — so it
 * sorts ahead of U+E000–U+FFFF, where every byte-ordered backend puts it
 * after. Rare in practice, and exactly the kind of difference that makes a
 * page boundary skip or repeat an entry on one backend and not another.
 */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const left = a.charCodeAt(index);
    const right = b.charCodeAt(index);

    if (left === right) {
      continue;
    }

    // At the first differing unit, the code points decide. Where both units
    // are high surrogates (or both ordinary), this is the unit comparison; where
    // one is a surrogate pair and the other is not, reading the whole code
    // point is what puts U+10000 and above after U+FFFF. A differing low
    // surrogate follows an identical high one, so comparing it alone is right.
    return a.codePointAt(index)! - b.codePointAt(index)!;
  }

  return a.length - b.length;
}
