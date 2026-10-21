/**
 * Which Nest is installed, for the examples whose checks differ by release.
 *
 * A check is gated on a capability, never on a version string, as the
 * adapter itself does: the method, export or behaviour that release added.
 * The version is read only to print it, on the `skipped:` line naming the
 * checks that sat out and in the check that the capability arrives with the
 * release it is expected in.
 */
import { dirname, join } from "node:path";
import { AbstractHttpAdapter } from "@nestjs/core";

/**
 * The installed `@nestjs/core`'s version, read from its `package.json` on
 * disk, found by walking up from the resolved entry point: that works on
 * every release, whatever its `exports` map lists.
 * @returns The version string, such as "12.2.0".
 */
export async function nestCoreVersion(): Promise<string> {
  let dir = dirname(Bun.resolveSync("@nestjs/core", import.meta.dir));
  for (;;) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const pkg = (await file.json()) as { name?: string; version: string };
      if (pkg.name === "@nestjs/core") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("@nestjs/core's package.json was not found");
    dir = parent;
  }
}

/**
 * Whether the core has `AbstractHttpAdapter.prototype.mapException` (Nest
 * 12.0.0): what the adapter reads Nest 12 from, for example to merge
 * `MulterModule`'s `limits` key by key.
 */
export function coreHasMapException(): boolean {
  return (
    typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
      .mapException === "function"
  );
}

/**
 * Whether the core has `isRejectedByPipes` in `@nestjs/core/internal` (Nest
 * 12.2.0): what the adapter reads the 12.2.0 upload behaviours from — files
 * removed when a pipe rejects the request, and a route's `dest` replacing
 * the module's storage. Nest 11 has no `@nestjs/core/internal`; 12.0 and
 * 12.1 have no such export.
 * @returns `true` on Nest 12.2.0 and later.
 */
export async function coreHasIsRejectedByPipes(): Promise<boolean> {
  try {
    const internal = (await import("@nestjs/core/internal")) as {
      isRejectedByPipes?: unknown;
    };
    return typeof internal.isRejectedByPipes === "function";
  } catch {
    return false;
  }
}
