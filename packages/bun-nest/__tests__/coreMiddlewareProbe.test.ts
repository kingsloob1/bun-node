/**
 * `BunHttpAdapter` asks the core whether it runs a middleware once per request
 * through `MiddlewareModule.prototype.registerHandler`, which is internal and
 * has changed shape: 12.3.0 moved its set of handled requests to a fourth
 * parameter, the probe passed three, and on every release since it threw and
 * read as "no", so `/api/` silently skipped the core's exact `/api$` entry
 * where platform-express runs it. Only a matrix column on a newer Nest could
 * see that. Here each shape is a stand-in, so the lock's Nest sees them all.
 *
 * What the middleware should do on each real core is
 * `routingCompat.nest.test.ts`'s to say: it compares with platform-express.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "core-middleware-probe",
  "run.ts",
);

/** Each process loads the whole adapter, so a loaded machine may take a while. */
const TIMEOUT_MS = 30_000;

/** How many times the exact entry ran the middleware for `GET /api/`, on a core of this shape. */
async function runsOnSlashOver(shape: string): Promise<number> {
  const child = Bun.spawn([process.execPath, FIXTURE, shape], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`fixture exited ${code}: ${stderr}`);
  return (JSON.parse(stdout) as { runs: number }).runs;
}

describe("BunHttpAdapter asks the core whether a middleware runs once", () => {
  it(
    "up to 11.2.7 and 12.1.3, no guard: `/api/` skips the exact entry",
    async () => {
      expect(await runsOnSlashOver("noGuard")).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "11.2.8 on and 12.2.0, a guard of its own: `/api/` runs it",
    async () => {
      expect(await runsOnSlashOver("ownGuard")).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    "from 12.3.0, a guard from its caller: `/api/` runs it",
    async () => {
      expect(await runsOnSlashOver("callerGuard")).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    "a core the probe cannot ask is newer than the guard: `/api/` runs it",
    async () => {
      expect(await runsOnSlashOver("unreadable")).toBe(1);
    },
    TIMEOUT_MS,
  );
});
