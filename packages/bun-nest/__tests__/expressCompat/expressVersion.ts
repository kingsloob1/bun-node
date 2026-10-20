/**
 * Which Express the differentials compare against, and which one
 * bun-common's response helpers copy, so a difference that only an older
 * Express shows is known there and nowhere else.
 *
 * The version is read from the installed `express/package.json` on disk —
 * the copy `@nestjs/platform-express` resolves — never by importing
 * `express/package.json`, which Node's rules refuse for a package whose
 * `exports` does not list it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The `version` of the nearest `package.json` named `name` at or above `file`. */
function packageVersion(file: string, name: string): string {
  let dir = dirname(file);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name) return String(pkg.version);
    } catch {
      // No package.json here: keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name}'s package.json was not found`);
    dir = parent;
  }
}

const require = createRequire(import.meta.url);
const platformExpress = require.resolve("@nestjs/platform-express");

/** The installed Express's version: 5.2.1 under Nest 11 and 12.0-12.1.3, 5.3.0 under 12.2.0. */
export const EXPRESS_VERSION = packageVersion(
  require.resolve("express", { paths: [dirname(platformExpress)] }),
  "express",
);

/**
 * The Express minor whose `res.redirect` body and `Content-Disposition`
 * (`res.download`, `res.attachment`) bun-common copies. Bumped in the change
 * that makes bun-common copy a newer one (Express 5.3.0: an HTML document
 * around the redirect body, and a filename quoted only where it must be).
 */
export const BUN_COMMON_COPIES_EXPRESS = "5.2";

/** `[major, minor]` of a version string. */
function minorOf(version: string): [number, number] {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return [major, minor];
}

/**
 * Whether the installed Express is older than the one bun-common copies, so
 * the redirect body and `Content-Disposition` it answers are its own, not
 * bun-common's. A newer Express is no known difference: bun-common follows.
 */
export const EXPRESS_OLDER_THAN_BUN_COMMON = (() => {
  const [major, minor] = minorOf(EXPRESS_VERSION);
  const [copiedMajor, copiedMinor] = minorOf(BUN_COMMON_COPIES_EXPRESS);
  return major < copiedMajor || (major === copiedMajor && minor < copiedMinor);
})();

/** Why the redirect body or `Content-Disposition` differs, where it does. */
export const OLDER_EXPRESS = `bun-common answers as Express ${BUN_COMMON_COPIES_EXPRESS} does; this Express (${EXPRESS_VERSION}) is older: a bare redirect body, and every filename quoted`;
