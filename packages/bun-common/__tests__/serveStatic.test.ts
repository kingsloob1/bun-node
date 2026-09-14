import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

/** Root of the fixture tree served by the adapters under test. */
let root: string;

/** Adapters started per option-set, torn down in `afterAll`. */
const started: BunHttpAdapter[] = [];

/**
 * Boots an adapter serving {@link root} under `/static` with the given options
 * and returns its base URL.
 */
async function serve(
  options: Parameters<BunHttpAdapter["useStaticAssets"]>[1] = {},
): Promise<string> {
  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
  });
  adapter.useStaticAssets(root, { prefix: "/static", ...options });
  // Port 0 — the OS assigns, so parallel suites never collide.
  await adapter.listen(0);
  started.push(adapter);
  return `http://127.0.0.1:${adapter.listeningPort}`;
}

beforeAll(() => {
  root = join(tmpdir(), `bun-common-serve-static-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "MixedCase.TXT"), "mixed-case-body");
  writeFileSync(join(root, "with space.txt"), "spaced");
  writeFileSync(join(root, "about.html"), "about-page");
  writeFileSync(join(root, ".secret"), "dotfile-body");
  writeFileSync(join(root, "nested", "index.html"), "nested-index");
  writeFileSync(join(root, "big.bin"), "x".repeat(5000));
});

afterAll(async () => {
  for (const adapter of started) {
    await adapter.close();
  }
  rmSync(root, { recursive: true, force: true });
});

describe("useStaticAssets: file resolution", () => {
  it("serves a file preserving path case", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/MixedCase.TXT`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mixed-case-body");
  });

  it("percent-decodes the path", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/with%20space.txt`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("spaced");
  });

  it("answers 404 — not 500 — for a missing file", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/nope.txt`);

    expect(response.status).toBe(404);
  });

  it("falls through to the next handler when fallthrough is set", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });
    adapter.useStaticAssets(root, { prefix: "/static", fallthrough: true });
    adapter.get("/static/*", (_req, res) => {
      res.status(200).send("fell-through");
    });
    await adapter.listen(0);
    started.push(adapter);

    const response = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/static/nope.txt`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fell-through");
  });

  it("serves index.html for a directory", async () => {
    const base = await serve();

    const rootDir = await fetch(`${base}/static/`);
    expect(rootDir.status).toBe(200);
    expect(await rootDir.text()).toBe("<h1>home</h1>");

    const nested = await fetch(`${base}/static/nested`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("nested-index");
  });

  it("honours index: false", async () => {
    const base = await serve({ index: false });
    const response = await fetch(`${base}/static/`);

    expect(response.status).toBe(404);
  });

  it("applies extension fallbacks", async () => {
    const base = await serve({ extensions: ["html"] });
    const response = await fetch(`${base}/static/about`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("about-page");
  });
});

describe("useStaticAssets: dotfiles", () => {
  it("ignores dotfiles by default", async () => {
    const base = await serve();
    expect((await fetch(`${base}/static/.secret`)).status).toBe(404);
  });

  it("denies dotfiles with 403 when configured", async () => {
    const base = await serve({ dotfiles: "deny" });
    expect((await fetch(`${base}/static/.secret`)).status).toBe(403);
  });

  it("serves dotfiles when allowed", async () => {
    const base = await serve({ dotfiles: "allow" });
    const response = await fetch(`${base}/static/.secret`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dotfile-body");
  });
});

describe("useStaticAssets: validators and caching headers", () => {
  it("emits ETag and Last-Modified by default", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("omits the ETag when etag: false", async () => {
    const base = await serve({ etag: false });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("omits Last-Modified when lastModified: false", async () => {
    const base = await serve({ lastModified: false });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("last-modified")).toBeNull();
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const base = await serve();
    const first = await fetch(`${base}/static/index.html`);
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();

    const second = await fetch(`${base}/static/index.html`, {
      headers: { "If-None-Match": tag as string },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("derives Cache-Control from maxAge and immutable", async () => {
    const base = await serve({ maxAge: "1d", immutable: true });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=86400, immutable",
    );
  });

  it("sends no Cache-Control when maxAge is unset", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("invokes setHeaders", async () => {
    const base = await serve({
      setHeaders: (res: any) => res.setHeader("X-Custom", "yes"),
    });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("x-custom")).toBe("yes");
  });
});

describe("useStaticAssets: range requests", () => {
  it("serves a byte range as 206", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/big.bin`, {
      headers: { Range: "bytes=0-99" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-99/5000");
    expect((await response.text()).length).toBe(100);
  });

  it("advertises Accept-Ranges on a full response", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/big.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });
});

describe("useStaticAssets: traversal containment", () => {
  /** Sends a raw request line so `..` survives client-side normalisation. */
  function raw(port: number, target: string): Promise<string> {
    return new Promise((resolve) => {
      let buffer = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open: (socket) =>
            void socket.write(
              `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
            ),
          data: (_socket, chunk) => {
            buffer += new TextDecoder().decode(chunk);
          },
          close: () => resolve(buffer),
          error: () => resolve(buffer),
        },
      });
    });
  }

  it("refuses encoded and literal traversal", async () => {
    const outside = join(tmpdir(), `bun-common-outside-${process.pid}.txt`);
    writeFileSync(outside, "secret-marker");

    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });
    adapter.useStaticAssets(root, { prefix: "/static" });
    await adapter.listen(0);
    started.push(adapter);
    const port = adapter.listeningPort as number;

    for (const target of [
      "/static/../../../../etc/passwd",
      `/static/%2e%2e/${outside.split("/").pop()}`,
      "/static/..%2f..%2fetc%2fpasswd",
    ]) {
      const raw404 = await raw(port, target);
      expect(raw404).not.toContain("secret-marker");
      expect(raw404).not.toContain("root:x:");
    }

    rmSync(outside, { force: true });
  });
});

describe("useStaticAssets: metadata cache", () => {
  it("reflects a file rewritten after the TTL expires", async () => {
    const file = join(root, "volatile.txt");
    writeFileSync(file, "first");

    const base = await serve({ metadataCacheTtl: 1 });
    expect(await (await fetch(`${base}/static/volatile.txt`)).text()).toBe(
      "first",
    );

    writeFileSync(file, "second-value");
    await Bun.sleep(20);

    const response = await fetch(`${base}/static/volatile.txt`);
    expect(await response.text()).toBe("second-value");
    expect(response.headers.get("content-length")).toBe("12");
  });

  it("serves correctly with the cache disabled", async () => {
    const base = await serve({ metadataCacheTtl: 0 });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home</h1>");
  });
});
