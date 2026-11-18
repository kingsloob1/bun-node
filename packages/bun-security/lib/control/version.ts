/**
 * bun-security's own release, read once from its `package.json` (beside
 * `lib/` in the repository and in the published package), for `/meta`:
 * the managed rule set ships with the package, so this is its version too.
 */

/** The cached version. */
let cached: string | undefined;

/** bun-security's `version` (its `package.json`'s). */
export function securityPackageVersion(): string {
  cached ??= (import.meta.require("../../package.json") as { version: string })
    .version;
  return cached;
}
