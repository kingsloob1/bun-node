/**
 * A local stand-in for a deployed bun-cache Worker, so the Cloudflare
 * examples run without a Cloudflare account.
 *
 * It bundles the Worker the package ships
 * (`@kingsleyweb/bun-cache/cloudflare-worker`, the very file a user deploys)
 * with `Bun.build` and runs it in workerd through
 * [miniflare](https://www.npmjs.com/package/miniflare), with a KV namespace
 * bound as `CACHE_KV` and a D1 database as `CACHE_DB`. The drivers then reach
 * it through their `endpoint` option, exactly as they reach a deployed Worker.
 *
 * - Nothing leaves the machine: miniflare runs with `cf: false` (otherwise,
 *   outside `bun test`, it fetches `cf.json` from the network and writes a
 *   `.wrangler` directory), on port 0, with every binding in memory.
 * - `miniflare` is a devDependency of `@kingsleyweb/bun-cache`, hoisted to the
 *   repository's `node_modules`. It is loaded dynamically, so an example run
 *   where it cannot be found skips visibly instead of failing.
 */

/** The KV binding the local Worker has (the README's name). */
export const KV_BINDING = "CACHE_KV";

/** The D1 binding the local Worker has (the README's name). */
export const D1_BINDING = "CACHE_DB";

/** A started local Worker. */
export interface LocalWorker {
  /** The Worker's URL, for a driver's `endpoint`. */
  endpoint: string;
  /** The Worker's `BUN_CACHE_PROXY_TOKEN`, for a driver's `apiToken`. */
  token: string;
  /** Stops workerd; resolves once it has gone. */
  stop: () => Promise<void>;
}

/**
 * Starts the local Worker, or answers `undefined` after printing a `skipped:`
 * line when miniflare cannot be loaded (the run-all runner counts that as a
 * pass).
 */
export async function startLocalWorker(): Promise<LocalWorker | undefined> {
  let Miniflare: typeof import("miniflare").Miniflare;
  try {
    ({ Miniflare } = await import("miniflare"));
  } catch (error) {
    console.log(
      `skipped: miniflare could not be loaded (${String(error)}); it is a devDependency of packages/bun-cache, so run \`bun install\` at the repository root`,
    );
    return undefined;
  }
  const built = await Bun.build({
    entrypoints: [
      Bun.resolveSync(
        "@kingsleyweb/bun-cache/cloudflare-worker",
        import.meta.dir,
      ),
    ],
    target: "browser",
    format: "esm",
  });
  if (!built.success) {
    throw new AggregateError(built.logs, "bundling the Worker failed");
  }
  const token = crypto.randomUUID();
  const mf = new Miniflare({
    modules: true,
    script: await built.outputs[0].text(),
    compatibilityDate: "2026-07-01",
    kvNamespaces: { [KV_BINDING]: "cache-kv" },
    d1Databases: { [D1_BINDING]: "cache-db" },
    bindings: { BUN_CACHE_PROXY_TOKEN: token },
    cf: false,
    port: 0,
  });
  const url = await mf.ready;
  return {
    endpoint: url.href.replace(/\/+$/, ""),
    token,
    stop: async () => {
      await mf.dispose();
    },
  };
}
