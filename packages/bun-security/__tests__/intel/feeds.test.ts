/**
 * Range feeds and the refresh job (layers.md L5), against a local
 * `Bun.serve` fake: nothing leaves the machine. A good copy is swapped in;
 * a truncated, empty, oversized, failed or unreadable one is refused and
 * the last good copy kept (T-L5-1); `304` keeps the copy; the copy
 * survives a restart through `dir`; `start()` fetches on the interval.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ipIntel } from "../../lib/intel/intel";
import {
  rangeFeed,
  TOR_BULK_EXIT_LIST_URL,
  torExitFeed,
} from "../../lib/intel/ranges";
import { fakeClock } from "../helpers";

/** What the fake answers for each path, changeable per test. */
const routes = new Map<string, () => Response>();
/** Every request the fake saw: path and `if-none-match`. */
const seen: { path: string; etag: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let base: string;
const work = mkdtempSync(join(tmpdir(), "bun-security-feeds-"));

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push({ path, etag: request.headers.get("if-none-match") });
      return routes.get(path)?.() ?? new Response("missing", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

/** `n` Tor-style exit addresses, one per line, with a comment. */
function exitList(n: number, first = 1): string {
  const lines = ["# exit list"];
  for (let i = 0; i < n; i++)
    lines.push(
      `198.51.${Math.floor((first + i) / 250)}.${((first + i) % 250) + 1}`,
    );
  return `${lines.join("\n")}\n`;
}

/** An intel with one Tor feed at `path` on the fake, a still clock. */
async function torIntel(
  path: string,
  extra: Partial<Parameters<typeof torExitFeed>[0]> = {},
  dir?: string,
) {
  const clock = fakeClock();
  const intel = await ipIntel({
    feeds: [torExitFeed({ url: `${base}${path}`, ...extra })],
    now: clock.now,
    logger: () => {},
    ...(dir === undefined ? {} : { dir }),
  });
  return { intel, clock };
}

describe("rangeFeed", () => {
  it("checks its settings", () => {
    expect(() => rangeFeed({ id: "bad id", url: "https://x.test/" })).toThrow(
      ConfigError,
    );
    expect(() => rangeFeed({ id: "a", url: "ftp://x.test/" })).toThrow(
      /http: or https:/,
    );
    expect(() => rangeFeed({ id: "a", url: "not a url" })).toThrow(/not a URL/);
    expect(() =>
      rangeFeed({ id: "a", url: "https://x.test/", interval: "10ms" }),
    ).toThrow(/at least a second/);
    expect(() =>
      rangeFeed({ id: "a", url: "https://x.test/", minEntries: 0 }),
    ).toThrow(/minEntries/);
    expect(() =>
      rangeFeed({ id: "a", url: "https://x.test/", format: "xml" as never }),
    ).toThrow(/format/);
    const feed = rangeFeed({
      id: "aws",
      class: "hosting",
      url: "https://x.test/r.json",
      format: "json",
      interval: "1d",
      retry: "1d",
    });
    expect(feed).toMatchObject({
      id: "aws",
      class: "hosting",
      interval: 86_400_000,
      retry: 86_400_000,
      minEntries: 1,
    });
  });

  it("reads lines with comments, JSON documents of any shape, and a parser of one's own", () => {
    const lines = rangeFeed({ id: "l", url: "https://x.test/" });
    expect(lines.parse("# c\n203.0.113.1\n\n 198.51.100.0/24 # x\n")).toEqual([
      "203.0.113.1",
      "198.51.100.0/24",
    ]);
    const json = rangeFeed({ id: "j", url: "https://x.test/", format: "json" });
    // AWS's, Google's and Azure's shapes, side by side.
    const document = {
      syncToken: "1700000000",
      prefixes: [
        { ip_prefix: "3.5.140.0/22", region: "ap-northeast-2" },
        { ipv4Prefix: "34.1.208.0/20" },
      ],
      ipv6_prefixes: [{ ipv6_prefix: "2600:1f00::/24" }],
      values: [
        {
          properties: {
            addressPrefixes: ["4.145.74.52/30", "2603:1000:4::/56"],
          },
        },
      ],
      version: "1.2.3",
    };
    expect(json.parse(JSON.stringify(document))).toEqual([
      "3.5.140.0/22",
      "34.1.208.0/20",
      "2600:1f00::/24",
      "4.145.74.52/30",
      "2603:1000:4::/56",
    ]);
    const custom = rangeFeed({
      id: "c",
      url: "https://x.test/",
      format: (body) => body.split(","),
    });
    expect(custom.parse("1.1.1.1,2.2.2.2")).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  it("torExitFeed defaults to class tor, hourly, at least 100 entries; the list's URL is a constant you pass", () => {
    const feed = torExitFeed({ url: TOR_BULK_EXIT_LIST_URL });
    expect(feed).toMatchObject({
      id: "tor",
      class: "tor",
      interval: 3_600_000,
      minEntries: 100,
      url: TOR_BULK_EXIT_LIST_URL,
    });
  });
});

describe("the refresh job", () => {
  it("takes a good copy, and the class answers", async () => {
    routes.set("/tor-good", () => new Response(exitList(150)));
    const { intel } = await torIntel("/tor-good");
    expect(intel.lookup("198.51.0.2").classes).toEqual([]);
    expect(await intel.refresh()).toEqual([
      { id: "tor", ok: true, entries: 150 },
    ]);
    expect(intel.lookup("198.51.0.2").classes).toEqual(["tor"]);
    expect(intel.lookup("203.0.113.1").classes).toEqual([]);
    expect(intel.status().feeds[0]).toMatchObject({
      entries: 150,
      source: "fetch",
      error: undefined,
    });
    expect(intel.status().classes).toEqual({ tor: 150 });
  });

  it("T-L5-1: refuses a truncated list (fewer than the minimum) and keeps the last good one", async () => {
    let body = exitList(150);
    routes.set("/tor-truncated", () => new Response(body));
    const { intel, clock } = await torIntel("/tor-truncated");
    await intel.refresh();
    body = exitList(12);
    clock.advance(3_600_000);
    expect(await intel.refresh()).toEqual([
      {
        id: "tor",
        ok: false,
        entries: 150,
        error: "12 ranges, fewer than minEntries 100",
      },
    ]);
    expect(intel.lookup("198.51.0.120").classes).toEqual(["tor"]);
    body = "";
    clock.advance(3_600_000);
    expect((await intel.refresh())[0]).toMatchObject({
      ok: false,
      entries: 150,
    });
    expect(intel.status().feeds[0]?.error).toBe(
      "0 ranges, fewer than minEntries 100",
    );
  });

  it("keeps the last good copy on an error status, a refused connection, an unreadable body and a body too large", async () => {
    let answer: () => Response = () => new Response(exitList(150));
    routes.set("/tor-flaky", () => answer());
    const { intel, clock } = await torIntel("/tor-flaky", { maxBytes: 8000 });
    await intel.refresh();
    const failures: [() => Response, RegExp][] = [
      [() => new Response("down", { status: 503 }), /answered 503/],
      [
        () => new Response(exitList(150, 1).repeat(10)),
        /more than maxBytes 8000/,
      ],
      [
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(exitList(150).repeat(10)),
                );
                controller.close();
              },
            }),
          ),
        /more than maxBytes 8000/,
      ],
    ];
    for (const [failing, reason] of failures) {
      answer = failing;
      clock.advance(3_600_000);
      const [result] = await intel.refresh();
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(reason);
      expect(intel.lookup("198.51.0.2").classes).toEqual(["tor"]);
    }
    const json = await ipIntel({
      feeds: [
        rangeFeed({
          id: "j",
          class: "hosting",
          url: `${base}/not-json`,
          format: "json",
        }),
      ],
      logger: () => {},
    });
    routes.set("/not-json", () => new Response("{"));
    expect((await json.refresh())[0]?.error).toMatch(/^unreadable/);
    const refused = await ipIntel({
      feeds: [rangeFeed({ id: "r", url: "http://127.0.0.1:1/never" })],
      logger: () => {},
    });
    expect((await refused.refresh())[0]?.error).toMatch(/^fetch failed/);
  });

  it("asks with the copy's ETag, and keeps the copy on a 304", async () => {
    routes.set(
      "/tor-etag",
      () => new Response(exitList(150), { headers: { etag: '"v1"' } }),
    );
    const { intel, clock } = await torIntel("/tor-etag");
    await intel.refresh();
    routes.set("/tor-etag", () => new Response(null, { status: 304 }));
    clock.advance(3_600_000);
    expect(await intel.refresh()).toEqual([
      { id: "tor", ok: true, entries: 150 },
    ]);
    expect(
      seen.filter((r) => r.path === "/tor-etag").map((r) => r.etag),
    ).toEqual([null, '"v1"']);
  });

  it("fetches only what is due, retrying a failure sooner, unless forced", async () => {
    let status = 200;
    routes.set("/tor-due", () =>
      status === 200
        ? new Response(exitList(150))
        : new Response("", { status }),
    );
    const { intel, clock } = await torIntel("/tor-due", { retry: "5m" });
    expect(await intel.refresh()).toHaveLength(1);
    expect(await intel.refresh()).toHaveLength(0);
    expect(await intel.refresh({ force: true })).toHaveLength(1);
    status = 500;
    clock.advance(3_600_000);
    expect((await intel.refresh())[0]?.ok).toBe(false);
    clock.advance(4 * 60_000);
    expect(await intel.refresh()).toHaveLength(0);
    clock.advance(60_000);
    expect(await intel.refresh()).toHaveLength(1);
  });

  it("keeps the good copy in `dir` and reads it back at the next start; a bad copy there is refused", async () => {
    const dir = join(work, "ranges");
    routes.set("/tor-disk", () => new Response(exitList(150)));
    const first = await torIntel("/tor-disk", {}, dir);
    await first.intel.refresh();
    // A restart with the feed down: the class answers from the disk copy.
    routes.set("/tor-disk", () => new Response("", { status: 500 }));
    const second = await torIntel("/tor-disk", {}, dir);
    expect(second.intel.lookup("198.51.0.2").classes).toEqual(["tor"]);
    expect(second.intel.status().feeds[0]).toMatchObject({
      source: "disk",
      entries: 150,
    });
    // A truncated copy on disk is refused like a truncated download.
    writeFileSync(join(dir, "tor.ranges"), "198.51.0.2\n");
    const third = await torIntel("/tor-disk", {}, dir);
    expect(third.intel.lookup("198.51.0.2").classes).toEqual([]);
    expect(third.intel.status().feeds[0]?.error).toMatch(
      /fewer than minEntries 100/,
    );
  });

  it("start() fetches in the background, and stop() stops it", async () => {
    let fetched = 0;
    let second: () => void = () => {};
    const twice = new Promise<void>((resolve) => {
      second = resolve;
    });
    routes.set("/tor-start", () => {
      fetched++;
      if (fetched === 2) second();
      return new Response(exitList(150));
    });
    const intel = await ipIntel({
      feeds: [
        torExitFeed({ url: `${base}/tor-start`, interval: "1s", retry: "1s" }),
      ],
      logger: () => {},
    });
    intel.start();
    await Promise.race([twice, Bun.sleep(5_000)]);
    // Let the second refresh finish before stopping.
    await Bun.sleep(100);
    intel.stop();
    expect(fetched).toBeGreaterThanOrEqual(2);
    const stopped = fetched;
    await Bun.sleep(1_300);
    expect(fetched).toBe(stopped);
    expect(intel.lookup("198.51.0.2").classes).toEqual(["tor"]);
  }, 10_000);

  it("refuses two feeds with one id", async () => {
    const feed = rangeFeed({ id: "a", url: "https://x.test/" });
    await expect(ipIntel({ feeds: [feed, feed] })).rejects.toThrow(
      /two feeds named "a"/,
    );
  });
});
