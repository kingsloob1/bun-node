/**
 * The token file (typed-client plan §3.3), as the CLI reads it
 * (`lib/codegen/devServer.ts`): parsing, the pure matching of a URL to a
 * server and the watcher's choice between servers, reading a directory
 * (skipping malformed files and dead processes), the token directory's
 * lookup, and `generate --url` sending the token of the token file that
 * names the endpoint (the user's decision of 2026-11-02: the token file, not
 * a `--header` flag). Each check is paired with its control.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevServer } from "../../lib/codegen/devServer";
import {
  chooseDevServer,
  devServerFor,
  parseTokenFile,
  readDevServers,
  tokenDirectory,
} from "../../lib/codegen/devServer";
import { runCli } from "../../lib/codegen/index";
import { randomToken, startDevServer } from "./fixtures/devServer";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-client-devserver-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const TOKEN = "a-token-of-16-chars";

/** A server as a token file would describe it. */
function server(url: string, extra: Partial<DevServer> = {}): DevServer {
  return {
    url,
    ws: `${url.replace(/^http/, "ws")}/ws`,
    token: TOKEN,
    file: `/tmp/${new URL(url).port}.json`,
    mtimeMs: 0,
    ...extra,
  };
}

describe("parseTokenFile", () => {
  it("reads what devTypes() writes (control: each malformed field is refused)", () => {
    const good = {
      url: "http://127.0.0.1:3000/__bun/types",
      ws: "ws://127.0.0.1:3000/__bun/types/ws",
      token: TOKEN,
      pid: 42,
    };
    expect(parseTokenFile(JSON.stringify(good), "/f.json", 7)).toEqual({
      ...good,
      file: "/f.json",
      mtimeMs: 7,
    });
    // No pid: still a server, never skipped for liveness.
    const { pid: _pid, ...noPid } = good;
    expect(
      parseTokenFile(JSON.stringify(noPid), "/f.json")?.pid,
    ).toBeUndefined();
    for (const bad of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...good, url: "ftp://x/y" }),
      JSON.stringify({ ...good, url: "not a url" }),
      JSON.stringify({ ...good, ws: "http://127.0.0.1:3000/x" }),
      JSON.stringify({ ...good, token: "short" }),
      JSON.stringify({ ...good, token: "has a space in it, long" }),
      JSON.stringify({ ...good, token: 1234567890123456 }),
    ]) {
      expect(parseTokenFile(bad, "/f.json")).toBeUndefined();
    }
  });

  it("reads the named documents a server serves (#768); a malformed list is read as none (control: the file is still a server)", () => {
    const good = {
      url: "http://127.0.0.1:3000/__bun/types",
      ws: "ws://127.0.0.1:3000/__bun/types/ws",
      token: TOKEN,
      documents: ["customer", "back-office"],
    };
    expect(parseTokenFile(JSON.stringify(good), "/f.json")?.documents).toEqual([
      "customer",
      "back-office",
    ]);
    for (const documents of ["customer", [1], ["a.b"], ["ok", null], {}]) {
      const server = parseTokenFile(
        JSON.stringify({ ...good, documents }),
        "/f.json",
      );
      expect(server?.url).toBe(good.url);
      expect(server?.documents).toBeUndefined();
    }
  });
});

describe("devServerFor", () => {
  const servers = [server("http://127.0.0.1:3000/__bun/types")];

  it("matches the endpoint and its documents, under any loopback name (control: another port, scheme, host or path does not)", () => {
    for (const url of [
      "http://127.0.0.1:3000/__bun/types",
      "http://127.0.0.1:3000/__bun/types/",
      "http://127.0.0.1:3000/__bun/types/openapi.json",
      "http://localhost:3000/__bun/types",
      "http://[::1]:3000/__bun/types?x=1",
      "http://127.0.0.2:3000/__bun/types",
    ]) {
      expect(devServerFor(url, servers, "endpoint")).toBe(servers[0]);
    }
    for (const url of [
      "http://127.0.0.1:3001/__bun/types",
      "https://127.0.0.1:3000/__bun/types",
      "http://192.0.2.1:3000/__bun/types",
      "http://example.com:3000/__bun/types",
      // The app's own routes never get the token.
      "http://127.0.0.1:3000/openapi.json",
      "http://127.0.0.1:3000/__bun/typesx",
      "http://127.0.0.1:3000/",
      "not a url",
    ]) {
      expect(devServerFor(url, servers, "endpoint")).toBeUndefined();
    }
  });

  it("with scope origin, any path on the server's origin (control: another origin does not)", () => {
    expect(devServerFor("http://localhost:3000", servers, "origin")).toBe(
      servers[0],
    );
    expect(devServerFor("http://127.0.0.1:3000/app", servers, "origin")).toBe(
      servers[0],
    );
    expect(
      devServerFor("http://127.0.0.1:4000/__bun/types", servers, "origin"),
    ).toBeUndefined();
  });

  it("reads a default port from the scheme", () => {
    const plain = [server("http://dev.test/__bun/types")];
    expect(
      devServerFor("http://dev.test:80/__bun/types", plain, "endpoint"),
    ).toBe(plain[0]);
    expect(
      devServerFor("http://dev.test:8080/__bun/types", plain, "endpoint"),
    ).toBeUndefined();
  });
});

describe("chooseDevServer", () => {
  const a = server("http://127.0.0.1:3000/__bun/types");
  const b = server("http://127.0.0.1:4000/__bun/types");

  it("takes the only server, or none (control: two are several)", () => {
    expect(chooseDevServer([a])).toEqual({ kind: "one", server: a });
    expect(chooseDevServer([])).toEqual({ kind: "none" });
    expect(chooseDevServer([a, b])).toEqual({
      kind: "several",
      servers: [a, b],
    });
  });

  it("follows --url, and the server followed last while it runs", () => {
    expect(chooseDevServer([a, b], { url: "http://localhost:4000" })).toEqual({
      kind: "one",
      server: b,
    });
    expect(chooseDevServer([a], { url: "http://localhost:4000" })).toEqual({
      kind: "none",
    });
    expect(chooseDevServer([a, b], { last: b.url })).toEqual({
      kind: "one",
      server: b,
    });
    // The one followed last is gone, and two others run: no guess.
    expect(chooseDevServer([a, b], { last: "http://127.0.0.1:9/x" }).kind).toBe(
      "several",
    );
    // It is gone and one other runs: that one (a restart on a new port).
    expect(chooseDevServer([a], { last: b.url })).toEqual({
      kind: "one",
      server: a,
    });
  });
});

describe("readDevServers and tokenDirectory", () => {
  /** Writes a token file into `directory`. */
  async function writeTokenFile(
    directory: string,
    name: string,
    content: object | string,
    mtime?: number,
  ): Promise<string> {
    await mkdir(directory, { recursive: true });
    const file = join(directory, name);
    await writeFile(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    if (mtime !== undefined) await utimes(file, mtime, mtime);
    return file;
  }

  it("reads every token file of a directory, newest first, skipping malformed ones and dead processes (control: the live ones are read)", async () => {
    const directory = join(dir, "tokens");
    const entry = (port: number, pid?: number) => ({
      url: `http://127.0.0.1:${port}/__bun/types`,
      ws: `ws://127.0.0.1:${port}/__bun/types/ws`,
      token: TOKEN,
      ...(pid === undefined ? {} : { pid }),
    });
    // A pid known to be gone: a process that has exited.
    const exited = Bun.spawnSync([process.execPath, "-e", "0"]).pid;
    const older = await writeTokenFile(
      directory,
      "3000.json",
      entry(3000, process.pid),
      1000,
    );
    const newer = await writeTokenFile(
      directory,
      "4000.json",
      entry(4000),
      2000,
    );
    await writeTokenFile(directory, "5000.json", entry(5000, exited));
    await writeTokenFile(directory, "6000.json", "{ broken");
    await writeTokenFile(directory, "notes.txt", entry(7000));
    const servers = await readDevServers(directory);
    expect(servers.map((each) => each.file)).toEqual([newer, older]);
    // Control: the dead process's file is read when liveness says so.
    const all = await readDevServers(directory, () => true);
    expect(all.map((each) => new URL(each.url).port).sort()).toEqual([
      "3000",
      "4000",
      "5000",
    ]);
    // One file names one server; a missing path, none.
    expect(await readDevServers(older)).toHaveLength(1);
    expect(await readDevServers(join(dir, "absent"))).toEqual([]);
  });

  it("finds the nearest node_modules/.cache/bun-types up the tree (control: none yet is the working directory's)", async () => {
    const nested = join(dir, "packages", "web", "src");
    await mkdir(nested, { recursive: true });
    expect(tokenDirectory(nested)).toBe(
      join(nested, "node_modules", ".cache", "bun-types"),
    );
    const rootTokens = join(dir, "node_modules", ".cache", "bun-types");
    await mkdir(rootTokens, { recursive: true });
    expect(tokenDirectory(nested)).toBe(rootTokens);
    const nearer = join(
      dir,
      "packages",
      "web",
      "node_modules",
      ".cache",
      "bun-types",
    );
    await mkdir(nearer, { recursive: true });
    expect(tokenDirectory(nested)).toBe(nearer);
  });
});

describe("generate --url and the token file", () => {
  /** Runs `generate` in `cwd`. */
  async function generate(cwd: string, ...argv: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["generate", ...argv], {
      cwd,
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    });
    return { code, stdout, stderr };
  }

  it("sends the token of the token file naming the endpoint (control: elsewhere, no token file, it is refused)", async () => {
    const dev = await startDevServer({ dir });
    try {
      const token = String(dev.dev.token);
      const hash = (
        (await (
          await fetch(dev.url, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as { hash: string }
      ).hash;
      const read = await generate(dir, "--url", dev.url);
      expect(read.code).toBe(0);
      expect(read.stdout).toContain(`typesHash: ${hash}`);
      expect(read.stdout).toContain('"GET /users/:id"');
      // Under `localhost`, and for the OpenAPI document alone, too.
      const viaLocalhost = await generate(
        dir,
        "--url",
        `http://localhost:${dev.port}${new URL(dev.url).pathname}/openapi.json`,
      );
      expect(viaLocalhost.code).toBe(0);

      // Control: from a directory with no token file the request carries
      // no token, and the endpoint answers as if it did not exist.
      const elsewhere = await mkdtemp(join(tmpdir(), "bun-client-elsewhere-"));
      try {
        const refused = await generate(elsewhere, "--url", dev.url);
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain("answered 404");
        expect(refused.stderr).not.toContain("token in");
        // --token-file points at the server's directory from anywhere.
        const pointed = await generate(
          elsewhere,
          "--url",
          dev.url,
          "--token-file",
          join(dir, "node_modules", ".cache", "bun-types"),
        );
        expect(pointed.code).toBe(0);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    } finally {
      await dev.close();
    }
  });

  it("names the token file when its token is refused (a stale file), and never sends it to the app's own routes", async () => {
    const dev = await startDevServer({ dir, tokenFile: false });
    let seen: unknown = "not called";
    dev.app.get("/openapi.json", (req, res) => {
      seen = req.headersObj.get("authorization");
      res.json({
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        paths: {},
      });
    });
    try {
      const tokens = join(dir, "node_modules", ".cache", "bun-types");
      await mkdir(tokens, { recursive: true });
      const file = join(tokens, `${dev.port}.json`);
      await writeFile(
        file,
        JSON.stringify({
          url: dev.url,
          ws: `${dev.url.replace(/^http/, "ws")}/ws`,
          token: randomToken(),
          pid: process.pid,
        }),
      );
      const stale = await generate(dir, "--url", dev.url);
      expect(stale.code).toBe(2);
      expect(stale.stderr).toContain(
        `answered 404 Not Found (the token in ${file} was sent: a stale token file?)`,
      );
      // The app's own document route on the same origin: no token sent.
      const own = await generate(
        dir,
        "--url",
        `http://127.0.0.1:${dev.port}/openapi.json`,
      );
      expect(own.code).toBe(0);
      expect(seen).not.toBe("not called");
      expect(seen ?? "none").toBe("none");
    } finally {
      await dev.close();
    }
  });
});
