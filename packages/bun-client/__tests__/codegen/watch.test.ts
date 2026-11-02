/**
 * `bun-client watch` (typed-client plan §3.3, §12.1's PR-C3 row) against a
 * real bun-common `devTypes()` server on port 0, in process, found through
 * the token file the server writes under the test's directory:
 *
 * - a route added at run time regenerates the file, which gains the route;
 * - one line per regeneration, with the hash and the time taken;
 * - no change, no write: the file keeps its inode and modification time;
 * - a server restart with a new token (and port): reconnects, re-reads the
 *   token file, regenerates;
 * - a wrong token is refused and logged, and the right one picked up once
 *   the file holds it;
 * - atomic: a reader polling the file never sees a part of one, and every
 *   write replaces the file (a new inode);
 * - several servers: refuses to guess, unless `--url` names one;
 * - SIGINT stops the bin, exit 0.
 *
 * Each check is paired with its control.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../lib/codegen/index";
import { randomToken, startDevServer } from "./fixtures/devServer";

const BIN = join(import.meta.dir, "..", "..", "lib", "codegen", "cli.ts");
/** The last line of every generated module: a file ending otherwise is a part of one. */
const LAST_LINE = "} as const satisfies RouteManifest<Routes>;\n";

let dir: string;
let out: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-client-watch-"));
  out = join(dir, "src", "api.gen.ts");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** Polls `predicate` until true, or fails after `timeoutMs` naming `what`. */
async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A watcher run in process: its output, and how to stop it. */
interface Watcher {
  /** Everything written to stdout, by line. */
  readonly stdout: string[];
  /** Everything written to stderr. */
  readonly stderr: string[];
  /** The exit status, once it has stopped. */
  readonly done: Promise<number>;
  /** Stops it and returns its exit status. */
  readonly stop: () => Promise<number>;
}

/** Starts `bun-client watch --out src/api.gen.ts …` in `dir`. */
function watch(...extra: string[]): Watcher {
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const done = runCli(["watch", "--out", "src/api.gen.ts", ...extra], {
    cwd: dir,
    signal: controller.signal,
    stdout: (text) => void stdout.push(...text.split("\n").filter(Boolean)),
    stderr: (text) => void stderr.push(text),
  });
  const stop = () => {
    controller.abort();
    return done;
  };
  cleanups.push(async () => {
    await stop();
  });
  return { stdout, stderr, done, stop };
}

/** The lines reporting a regeneration. */
function regenerations(lines: readonly string[]): string[] {
  return lines.filter((line) =>
    /: (?:wrote|unchanged) src\/api\.gen\.ts /.test(line),
  );
}

/** The file's text, or `""` before it exists. */
async function text(): Promise<string> {
  try {
    return await readFile(out, "utf8");
  } catch {
    return "";
  }
}

/** The served hash, read with the server's token. */
async function servedHash(url: string, token: string): Promise<string> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await response.json()) as { hash: string }).hash;
}

describe("bun-client watch: regeneration", () => {
  it("writes the file, then regenerates it when a route is added at run time (control: the route is absent before)", async () => {
    const server = await startDevServer({ dir });
    cleanups.push(server.close);
    const watcher = watch();
    await until(
      "the first write",
      () => regenerations(watcher.stdout).length === 1,
    );
    const first = await text();
    expect(first).toContain('"GET /users/:id"');
    // Control: the route the next step adds is not there yet.
    expect(first).not.toContain('"GET /posts"');
    expect(first).toContain(
      `typesHash: ${await servedHash(server.url, String(server.dev.token))}`,
    );
    await until("the channel", () =>
      watcher.stdout.some((line) => line.includes(`following ${server.url}`)),
    );

    server.addRoute("/posts");
    await until(
      "the second write",
      () => regenerations(watcher.stdout).length === 2,
    );
    const second = await text();
    expect(second).toContain('"GET /posts"');
    const hash = await servedHash(server.url, String(server.dev.token));
    expect(second).toContain(`typesHash: ${hash}`);
    // One line per regeneration: the hash and the time it took.
    expect(regenerations(watcher.stdout)[1]).toMatch(
      new RegExp(`wrote src/api\\.gen\\.ts \\(typesHash ${hash}, \\d+ ms\\)$`),
    );
    expect(await watcher.stop()).toBe(0);
    expect(watcher.stdout.at(-1)).toBe("bun-client watch: stopped");
    expect(watcher.stderr).toEqual([]);
  });

  it("no change, no write: a fresh run and an undeclared change keep the file's inode and mtime (control: a stale file is rewritten)", async () => {
    const server = await startDevServer({ dir });
    cleanups.push(server.close);
    const first = watch();
    await until(
      "the first write",
      () => regenerations(first.stdout).length === 1,
    );
    await first.stop();
    const before = statSync(out);

    // A fresh run fetches unconditionally, generates the same text, and
    // writes nothing.
    await Bun.sleep(20); // so a rewrite would show in the mtime
    const second = watch();
    await until(
      "the regeneration",
      () => regenerations(second.stdout).length === 1,
    );
    expect(regenerations(second.stdout)[0]).toContain(
      "unchanged src/api.gen.ts",
    );
    await until("the channel", () =>
      second.stdout.some((line) => line.includes("following")),
    );
    // A route hidden from the documents moves the route set, not the hash:
    // nothing is announced, nothing fetched.
    server.app
      .get("/hidden", (_req, res) => {
        res.json({});
      })
      .describe({ hidden: true });
    await Bun.sleep(400); // four of the server's 100 ms polls
    expect(regenerations(second.stdout)).toHaveLength(1);
    const after = statSync(out);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    await second.stop();

    // Control: a file that differs (edited by hand) is rewritten.
    await writeFile(out, `${await text()}// edited\n`);
    const edited = statSync(out);
    await Bun.sleep(20);
    const third = watch();
    await until("the rewrite", () => regenerations(third.stdout).length === 1);
    expect(regenerations(third.stdout)[0]).toContain("wrote src/api.gen.ts");
    expect(await text()).not.toContain("// edited");
    expect(statSync(out).ino).not.toBe(edited.ino);
  });
});

describe("bun-client watch --zod (PR-C4)", () => {
  it("keeps the zod module in step with the route map (control: without --zod none is written)", async () => {
    const server = await startDevServer({ dir });
    cleanups.push(server.close);
    const zod = join(dir, "src", "schemas", "api.zod.gen.ts");
    const watcher = watch("--zod", "src/schemas/api.zod.gen.ts");
    await until(
      "the first write",
      () => regenerations(watcher.stdout).length === 1,
    );
    const first = await readFile(zod, "utf8");
    expect(first).toContain('import { z } from "zod/mini";');
    expect(first).toContain('import type { Routes } from "../api.gen";');
    expect(first).toContain(
      `typesHash: ${await servedHash(server.url, String(server.dev.token))}`,
    );
    expect(first).not.toContain('"GET /posts"');
    expect(
      watcher.stdout.some((line) =>
        /wrote src\/schemas\/api\.zod\.gen\.ts \(typesHash /.test(line),
      ),
    ).toBe(true);
    await until("the channel", () =>
      watcher.stdout.some((line) => line.includes(`following ${server.url}`)),
    );

    server.addRoute("/posts");
    await until(
      "the second write",
      () => regenerations(watcher.stdout).length === 2,
    );
    const second = await readFile(zod, "utf8");
    expect(second).toContain(
      `typesHash: ${await servedHash(server.url, String(server.dev.token))}`,
    );
    expect(await watcher.stop()).toBe(0);

    // Control: a watcher without --zod writes the map alone.
    await rm(zod);
    const plain = watch();
    await until(
      "the plain write",
      () => regenerations(plain.stdout).length === 1,
    );
    expect(await plain.stop()).toBe(0);
    expect(await readdir(join(dir, "src", "schemas"))).toEqual([]);
  });
});

describe("bun-client watch: restarts and tokens", () => {
  it("follows a restart with a new token and port: reconnects, re-reads the token file, regenerates (control: the old token is refused by the new server)", async () => {
    const path = "/__bun/restart";
    const firstToken = randomToken();
    const first = await startDevServer({ dir, path, token: firstToken });
    const watcher = watch();
    await until("the channel", () =>
      watcher.stdout.some((line) => line.includes(`following ${first.url}`)),
    );
    expect(await text()).not.toContain('"GET /after-restart"');

    // The restart: the old server goes (its token file with it), a new one
    // comes up with another token, on another port, with a new route.
    await first.close();
    const secondToken = randomToken();
    const second = await startDevServer({
      dir,
      path,
      token: secondToken,
      routes: ["/after-restart"],
    });
    cleanups.push(second.close);
    expect(second.url).not.toBe(first.url);
    await until("the regeneration after the restart", async () =>
      (await text()).includes('"GET /after-restart"'),
    );
    await until("the new channel", () =>
      watcher.stdout.some((line) => line.includes(`following ${second.url}`)),
    );
    expect(await text()).toContain(
      `typesHash: ${await servedHash(second.url, secondToken)}`,
    );
    // Control: the token changed, so a watcher that kept the old one would
    // have been refused.
    const stale = await fetch(second.url, {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(stale.status).toBe(404);
    expect(watcher.stderr.join("")).not.toContain("refused");
  });

  it("logs a refused token and keeps the file, then picks up the right one (control: the right token is accepted)", async () => {
    const server = await startDevServer({ dir, tokenFile: false });
    cleanups.push(server.close);
    const tokenDir = join(dir, "node_modules", ".cache", "bun-types");
    await mkdir(tokenDir, { recursive: true });
    const tokenFile = join(tokenDir, `${server.port}.json`);
    const write = (token: string) =>
      writeFile(
        tokenFile,
        JSON.stringify({
          url: server.url,
          ws: `${server.url.replace(/^http/, "ws")}/ws`,
          token,
          pid: process.pid,
        }),
      );
    await write(randomToken());
    const watcher = watch();
    await until("the refusal", () =>
      watcher.stderr.some((line) => line.includes("refused the token")),
    );
    expect(watcher.stderr.join("")).toContain(
      `${server.url} refused the token in ${tokenFile}`,
    );
    // Logged once, not on every retry.
    await Bun.sleep(300);
    expect(
      watcher.stderr.filter((line) => line.includes("refused the token")),
    ).toHaveLength(1);
    expect(await text()).toBe("");

    // Control: the right token, read on the next attempt.
    await write(String(server.dev.token));
    await until("the write", () => regenerations(watcher.stdout).length === 1);
    expect(await text()).toContain('"GET /users/:id"');
  });

  it("waits for a server that is not up yet, then follows it", async () => {
    const watcher = watch();
    await until("the waiting notice", () =>
      watcher.stdout.some((line) => line.includes("waiting for a dev server")),
    );
    expect(await text()).toBe("");
    const server = await startDevServer({ dir });
    cleanups.push(server.close);
    await until("the write", () => regenerations(watcher.stdout).length === 1);
    expect(await text()).toContain('"GET /users/:id"');
  });

  it("refuses to guess between several servers; --url names one (control: that one is followed)", async () => {
    const a = await startDevServer({ dir });
    cleanups.push(a.close);
    const b = await startDevServer({ dir, routes: ["/only-on-b"] });
    cleanups.push(b.close);
    const guessing = watch();
    expect(await guessing.done).toBe(2);
    expect(guessing.stderr.join("")).toContain(
      "several dev servers are running; name one with --url",
    );
    expect(guessing.stderr.join("")).toContain(a.url);
    expect(guessing.stderr.join("")).toContain(b.url);
    expect(await text()).toBe("");

    const named = watch("--url", `http://localhost:${b.port}`);
    await until("the write", () => regenerations(named.stdout).length === 1);
    expect(await text()).toContain('"GET /only-on-b"');
  });
});

describe("bun-client watch: atomic writes", () => {
  it("a reader polling the file never sees a part of one, and each write is a new inode (control: the reader sees every version)", async () => {
    // A big document, so a non-atomic write would be visible half done.
    const routes = Array.from({ length: 300 }, (_, i) => `/bulk/r${i}/:id`);
    const server = await startDevServer({ dir, routes });
    cleanups.push(server.close);
    const watcher = watch();
    await until(
      "the first write",
      () => regenerations(watcher.stdout).length === 1,
    );
    await until("the channel", () =>
      watcher.stdout.some((line) => line.includes("following")),
    );

    const seen = new Set<string>();
    const partial: number[] = [];
    const reading = { on: true };
    const reader = (async () => {
      while (reading.on) {
        const read = await text();
        if (!read.endsWith(LAST_LINE)) partial.push(read.length);
        else seen.add(/typesHash: ([0-9a-f]+)/.exec(read)?.[1] ?? "");
        await Bun.sleep(0);
      }
    })();

    const inodes = [statSync(out).ino];
    for (let i = 0; i < 5; i++) {
      server.addRoute(`/extra${i}`);
      await until(
        `write ${i + 2}`,
        () => regenerations(watcher.stdout).length === i + 2,
      );
      inodes.push(statSync(out).ino);
    }
    reading.on = false;
    await reader;

    expect(partial).toEqual([]);
    // Every write replaced the file rather than rewriting it in place.
    expect(new Set(inodes).size).toBe(inodes.length);
    // Control: the reader was fast enough to see the versions go by.
    expect(seen.size).toBeGreaterThanOrEqual(3);
    // No temporary file is left beside it.
    expect(await readdir(join(dir, "src"))).toEqual(["api.gen.ts"]);
  });
});

describe("the bin", () => {
  it("stops cleanly on SIGINT, exit 0 (control: it runs until then)", async () => {
    const child = Bun.spawn(
      [process.execPath, BIN, "watch", "--out", "api.gen.ts"],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("waiting for a dev server")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain("waiting for a dev server");
    await Bun.sleep(200);
    // Control: still running.
    expect(child.exitCode).toBeNull();
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain("bun-client watch: stopped");
  });
});
