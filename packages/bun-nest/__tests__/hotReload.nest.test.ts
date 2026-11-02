/**
 * bun-nest's `BunHttpAdapter` under `bun --hot`, in a real child process: a
 * NestJS app whose module is re-evaluated on an edit.
 *
 * The adapter's `listen()` passes `Bun.serve` no `id`, so Bun derives one from
 * the address (`[http]-tcp:<hostname>:<port>`, `[http]-unix:<path>`) and,
 * under `--hot`, reloads the running server with the re-evaluated app's
 * handlers instead of binding again (`Serve.Options.id` in bun-types;
 * oven-sh/bun#7207). bun-common's `hotReload.test.ts` covers the mechanism,
 * WebSockets and the `id: null` control; this file checks that Nest's
 * `app.listen()` on the same port, and on the same unix socket path, answers
 * with the edited controller, with no `EADDRINUSE`.
 *
 * Each child runs from this package's directory, whose `tsconfig.json` turns
 * on the legacy decorators Nest needs (Bun reads it from the cwd), and is
 * killed by its PID.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HotChild, HotEvent } from "../../bun-common/__tests__/hotChild";
import { bodyAt, startChild } from "../../bun-common/__tests__/hotChild";
import { getPort } from "../../bun-common/lib/utils/native";

/** This package's directory: the children's working directory. */
const PACKAGE_DIR = join(import.meta.dir, "..");

/** What the fixtures import, by absolute path (they live in a temporary directory). */
const MODULES = {
  adapter: join(PACKAGE_DIR, "lib", "index.ts"),
  common: Bun.resolveSync("@nestjs/common", PACKAGE_DIR),
  core: Bun.resolveSync("@nestjs/core", PACKAGE_DIR),
  reflect: Bun.resolveSync("reflect-metadata", PACKAGE_DIR),
};

/** A whole test: a Nest bootstrap and a reload, with margin. */
const TEST_TIMEOUT_MS = 45_000;

/** The children and directories the running test made, removed after it. */
const children: HotChild[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The fixture: a Nest app whose `GET /` answers `version`, listening on
 * `target` (a port or a socket path). It reports `listening` or `failed`.
 */
function nestFixture(version: string, target: number | string): string {
  return `
import ${JSON.stringify(MODULES.reflect)};
import { BunHttpAdapter } from ${JSON.stringify(MODULES.adapter)};
import { Controller, Get, Module } from ${JSON.stringify(MODULES.common)};
import { NestFactory } from ${JSON.stringify(MODULES.core)};
const version = ${JSON.stringify(version)};
const report = (event: string, fields: object = {}) =>
  console.log(JSON.stringify({ event, version, ...fields }));
@Controller()
class VersionController {
  @Get()
  get() {
    return version;
  }
}
@Module({ controllers: [VersionController] })
class AppModule {}
const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
  logger: false,
});
try {
  await app.listen(${JSON.stringify(target)});
  report("listening", { url: await app.getUrl() });
} catch (error) {
  report("failed", { code: (error as { code?: string }).code });
}
`;
}

/** Matches a `listening` event of `version`. */
function listeningAt(version: string) {
  return (event: HotEvent) =>
    event.event === "listening" && event.version === version;
}

/** Fails when the child's output shows a bind failure. */
function expectNoBindFailure(child: HotChild) {
  expect(child.stderr()).not.toContain("EADDRINUSE");
  expect(child.events.filter((event) => event.event === "failed")).toEqual([]);
}

/** GETs `/` over the unix socket at `path`; `undefined` when nothing answers. */
async function bodyAtSocket(path: string): Promise<string | undefined> {
  try {
    const response = await fetch("http://localhost/", {
      unix: path,
      signal: AbortSignal.timeout(2000),
    });
    return await response.text();
  } catch {
    return undefined;
  }
}

describe("bun-nest BunHttpAdapter under bun --hot", () => {
  it(
    "a re-evaluated app.listen() on the same port answers with the edited controller, with no EADDRINUSE",
    async () => {
      const port = await getPort();
      const child = startChild({
        source: nestFixture("v1", port),
        hot: true,
        cwd: PACKAGE_DIR,
      });
      children.push(child);
      await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const url = `http://127.0.0.1:${port}/`;
      expect(await bodyAt(url)).toBe("v1");

      child.rewrite(nestFixture("v2", port));
      await child.waitUntil(async () => {
        const body = await bodyAt(url);
        return body === "v2" || `answered ${body ?? "nothing"}`;
      }, `v2 answering on port ${port}`);
      const second = await child.waitForEvent(
        listeningAt("v2"),
        "v2 listening",
      );
      expect(second.url).toBe(`http://127.0.0.1:${port}`);
      expectNoBindFailure(child);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a re-evaluated app.listen() on the same unix socket path answers with the edited controller",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-nest-hot-sock-"));
      directories.push(dir);
      const path = join(dir, "app.sock");
      const child = startChild({
        source: nestFixture("v1", path),
        hot: true,
        cwd: PACKAGE_DIR,
      });
      children.push(child);
      await child.waitForEvent(listeningAt("v1"), "v1 listening");
      expect(await bodyAtSocket(path)).toBe("v1");

      child.rewrite(nestFixture("v2", path));
      await child.waitUntil(async () => {
        const body = await bodyAtSocket(path);
        return body === "v2" || `answered ${body ?? "nothing"}`;
      }, `v2 answering on ${path}`);
      await child.waitForEvent(listeningAt("v2"), "v2 listening");
      expectNoBindFailure(child);
    },
    TEST_TIMEOUT_MS,
  );
});
