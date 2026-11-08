/**
 * The persister on a real IndexedDB: headless Chrome through `Bun.WebView`
 * (CDP, no new dependency), as bun-ui's jobs e2e suites drive it. The page
 * (`fixtures/page.ts`, bundled for the browser here) runs query-core's
 * `persistQueryClient` over `idbPersister`, and the test reads the result
 * after a **navigation**, a fresh JavaScript realm: nothing but the browser's
 * IndexedDB carries the cache across it.
 *
 * - a cache saved under a buster restores after the navigation, and is the
 *   `PersistedClient` itself in the object store (a structured clone, not a
 *   string), read with IndexedDB directly;
 * - another buster (a schema change: the generated `typesHash` differs)
 *   restores nothing and deletes the record;
 * - `maxAge` drops an older record, and restores a younger one (the control).
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search). The profile directory is the suite's own, deleted after it; one
 * left by a killed run is swept by the next (its owner's pid is gone).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

/** The first Chrome that exists, if any. */
const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** Profile directories: `bun-client-e2e-p<pid>-<random>`. */
const PROFILE = /^bun-client-e2e-p(\d+)-/;

/** Whether process `pid` is running (or exists under another user). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

/** Deletes the profiles of suites whose process has exited. */
function sweepProfiles(): void {
  for (const name of readdirSync(tmpdir())) {
    const owner = PROFILE.exec(name);
    if (owner && Number(owner[1]) !== process.pid && !isAlive(Number(owner[1])))
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

const HOUR = 60 * 60_000;

describe.skipIf(chromePath === undefined)(
  `idbPersister on Chrome's IndexedDB${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    let view: Bun.WebView | undefined;
    let profile: string | undefined;
    let origin = "";
    const pageConsole: string[] = [];

    /** Loads the page afresh (a new realm) and evaluates `script` in it. */
    async function inFreshPage<T>(script: string): Promise<T> {
      await view!.navigate(`${origin}/?${crypto.randomUUID()}`);
      const ready = await view!.evaluate<boolean>(`new Promise((resolve) => {
        const deadline = Date.now() + 10000;
        const check = () => {
          if (globalThis.persistTest) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(check, 20);
        };
        check();
      })`);
      if (!ready)
        throw new Error(
          `the page never loaded; console:\n${pageConsole.join("\n")}`,
        );
      return view!.evaluate<T>(script);
    }

    beforeAll(async () => {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures", "page.ts")],
        target: "browser",
        // persist-client-core reads it in its restore's error path.
        define: { "process.env.NODE_ENV": '"production"' },
      });
      if (!built.success) throw new AggregateError(built.logs, "page build");
      const script = await built.outputs[0].text();
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) =>
          new URL(request.url).pathname === "/page.js"
            ? new Response(script, {
                headers: { "content-type": "text/javascript" },
              })
            : new Response(
                '<!doctype html><title>persist</title><script type="module" src="/page.js"></script>',
                { headers: { "content-type": "text/html" } },
              ),
      });
      origin = `http://127.0.0.1:${server.port}`;
      sweepProfiles();
      profile = mkdtempSync(join(tmpdir(), `bun-client-e2e-p${process.pid}-`));
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath!,
          // Off the desktop's display, as bun-ui's jobs suites run it.
          argv: ["--use-gl=disabled"],
        },
        dataStore: { directory: profile },
        width: 800,
        height: 600,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await server?.stop(true);
      // Chrome writes a few last files as it exits: delete, wait, delete.
      // A skeleton it writes later still is swept by the next run.
      for (let attempt = 0; profile !== undefined && attempt < 6; attempt++) {
        rmSync(profile, { recursive: true, force: true });
        await Bun.sleep(300);
        if (!existsSync(profile)) profile = undefined;
      }
    });

    it("a saved cache restores after a navigation, stored as the PersistedClient itself", async () => {
      const value = { id: "42", name: "Ada", at: "2026-01-01" };
      expect(
        await inFreshPage<boolean>(
          `persistTest.save("hash-1", ${JSON.stringify(value)})`,
        ),
      ).toBe(true);

      expect(
        await inFreshPage<unknown>(`persistTest.restore("hash-1")`),
      ).toEqual(value);

      const record = await inFreshPage<{
        buster: string;
        timestamp: number;
        clientState: { queries: { queryKey: unknown }[] };
      } | null>(`persistTest.raw()`);
      expect(record?.buster).toBe("hash-1");
      expect(typeof record?.timestamp).toBe("number");
      expect(
        record?.clientState.queries.map((query) => query.queryKey),
      ).toEqual([["item"]]);
    }, 30_000);

    it("negative control: another database restores nothing", async () => {
      expect(
        await inFreshPage<unknown>(
          `persistTest.restore("hash-1", undefined, "bun-client-e2e-other")`,
        ),
      ).toBeNull();
    }, 30_000);

    it("another buster (the documents' hash after a schema change) restores nothing and deletes the record", async () => {
      expect(
        await inFreshPage<boolean>(`persistTest.save("hash-1", { v: 1 })`),
      ).toBe(true);
      expect(
        await inFreshPage<unknown>(`persistTest.restore("hash-2")`),
      ).toBeNull();
      expect(await inFreshPage<unknown>(`persistTest.raw()`)).toBeNull();
    }, 30_000);

    it("maxAge drops an older record; a younger one restores (the control)", async () => {
      await inFreshPage(
        `persistTest.saveAged("hash-1", ${2 * HOUR}, { v: "aged" })`,
      );
      expect(
        await inFreshPage<unknown>(
          `persistTest.restore("hash-1", ${3 * HOUR})`,
        ),
      ).toEqual({ v: "aged" });
      expect(
        await inFreshPage<unknown>(`persistTest.restore("hash-1", ${HOUR})`),
      ).toBeNull();
      expect(await inFreshPage<unknown>(`persistTest.raw()`)).toBeNull();
    }, 30_000);
  },
);
