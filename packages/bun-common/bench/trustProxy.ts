/* eslint-disable antfu/no-top-level-await, n/no-top-level-await, no-console */
/**
 * `trustProxy`'s per-request cost (real-IP follow-up): a request served
 * through `BunHttpAdapter`'s own request path (`serveNativeRequest`, what its
 * `Bun.serve` handler calls), with no socket, under four settings, reading
 * nothing, `req.ip`, `req.protocol`, `req.host`, or all three.
 *
 *   cd packages/bun-common/bench
 *   bun trustProxy.ts                   # print the table
 *   bun trustProxy.ts --compare         # fail on a regression (below)
 *   bun trustProxy.ts --save-baseline   # record baselines/trustProxy.json
 *   TP_REQUESTS=2000 bun trustProxy.ts  # a smoke run
 *
 * The settings: `off` (the default), `hop1` (`trustProxy: 1`), `cidr` (four
 * private and CGNAT ranges), `cloudflare` (`behindCloudflare()`: its 22
 * published ranges plus `clientIpHeader: "cf-connecting-ip"`) and `counted`
 * (`cidr`'s ranges, compiled, behind a function counting its calls). Every
 * request carries the forwarding headers, and its socket peer is a trusted
 * proxy (a Cloudflare edge address for `cloudflare`), so the trusted paths do
 * their whole walk. The reads: nothing, `req.ip`, `req.protocol`, `req.host`,
 * all three, or `repeat` (`req.ip`, `req.ips`, `req.ip`, `req.ips`, as a
 * logger, a rate limiter and a handler might).
 *
 * The `walks/req` column counts the `X-Forwarded-For` walks per request on
 * `counted`: its trust function's calls for hop 1, which only a walk asks
 * about (`protocol` and `host` ask about the peer, hop 0, alone) and every
 * walk asks once, the peer being trusted. `-` for the other settings.
 *
 * The peer is reported by a stand-in server whose `requestIP()` builds a
 * fresh address object per call, as Bun's does, and counts the calls: the
 * `requestIP/req` column is exact, whatever the machine.
 *
 * `--compare` fails when a cell's `requestIP()` calls or walks per request
 * grew (both exact), or when a trusted setting's overhead over `off` for the same reads (ns per
 * request) more than doubled against the baseline's, with 2 µs of slack: a
 * ratio to `off` measured in the same run, so a busy machine slows both
 * sides. Like every benchmark here it runs through the heavy-run wrapper,
 * alone (`HEAVY_EXCLUSIVE=1`).
 */
import type { BunServer } from "../lib/types/general";
import { loadavg } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { behindCloudflare, compileTrustProxy } from "../lib/trustProxy";

const BASELINE = join(import.meta.dir, "baselines/trustProxy.json");
const REQUESTS = Number(process.env.TP_REQUESTS ?? 20_000);
const ROUNDS = Number(process.env.TP_ROUNDS ?? 5);

const SETTINGS = ["off", "hop1", "cidr", "cloudflare", "counted"] as const;
type Setting = (typeof SETTINGS)[number];
const READS = ["none", "ip", "protocol", "host", "all", "repeat"] as const;
type Read = (typeof READS)[number];

/** One measured cell. */
interface Cell {
  /** The `trustProxy` setting. */
  setting: Setting;
  /** What the handler reads. */
  read: Read;
  /** Nanoseconds per request, the median of the rounds. */
  nsPerRequest: number;
  /** `server.requestIP()` calls per request. */
  requestIPPerRequest: number;
  /** `X-Forwarded-For` walks per request, counted on `counted` only; absent elsewhere. */
  walksPerRequest?: number;
}

/** The four private and CGNAT ranges of `cidr` and `counted`. */
const CIDR = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

/** The calls `counted`'s trust function answered for hop 1: one per walk. */
let walks = 0;

/** `cidr`'s ranges, compiled, counting the walks that reach hop 1. */
const countedTrust = (() => {
  const inner = compileTrustProxy(CIDR);
  return (address: string, hop: number): boolean => {
    if (hop === 1) walks++;
    return inner(address, hop);
  };
})();

/** The adapter options for a setting. */
function optionsFor(
  setting: Setting,
): ConstructorParameters<typeof BunHttpAdapter>[1] {
  const quiet = { logger: () => {} };
  switch (setting) {
    case "off":
      return quiet;
    case "hop1":
      return { ...quiet, trustProxy: 1 };
    case "cidr":
      return { ...quiet, trustProxy: CIDR };
    case "cloudflare":
      return { ...quiet, ...behindCloudflare() };
    case "counted":
      return { ...quiet, trustProxy: countedTrust };
  }
}

/** The socket peer: a trusted proxy for each setting. */
const PEER: Record<Setting, string> = {
  off: "10.0.0.4",
  hop1: "10.0.0.4",
  cidr: "10.0.0.4",
  cloudflare: "172.68.10.20",
  counted: "10.0.0.4",
};

/** The forwarding headers every request carries. */
const HEADERS = {
  "x-forwarded-for": "203.0.113.9, 10.0.0.7",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "app.example",
  "cf-connecting-ip": "203.0.113.9",
};

/** An adapter that serves a native request through its own request path. */
class BenchAdapter extends BunHttpAdapter {
  /** Serves `request` as `Bun.serve` would, with `server` as the socket's. */
  serve(request: Request, server: BunServer<never>) {
    return this.serveNativeRequest(request, server);
  }
}

/** A stand-in server reporting `address` as the peer, counting `requestIP()`. */
function peerServer(address: string): {
  server: BunServer<never>;
  calls: () => number;
} {
  let calls = 0;
  const family = address.includes(":") ? "IPv6" : "IPv4";
  const server = {
    requestIP: () => {
      calls++;
      return { address, port: 40000, family };
    },
    upgrade: () => false,
    timeout: () => {},
  } as unknown as BunServer<never>;
  return { server, calls: () => calls };
}

/** Builds the route for `read`. */
function adapterFor(setting: Setting, read: Read): BenchAdapter {
  const app = new BenchAdapter(0, optionsFor(setting));
  let sink = "";
  app.get("/r", (req, res) => {
    switch (read) {
      case "ip":
        sink = req.ip;
        break;
      case "protocol":
        sink = req.protocol;
        break;
      case "host":
        sink = req.host;
        break;
      case "all":
        sink = req.ip + req.protocol + req.host;
        break;
      case "repeat":
        sink =
          req.ip + req.ips.join(",") + req.ip + req.ips.join(",").slice(0, 1);
        break;
      case "none":
        break;
    }
    void res.end(sink.length > 1000 ? sink : "ok");
  });
  return app;
}

/** Times `n` requests on one cell; resolves with ns, requestIP calls and walks per request. */
async function time(
  app: BenchAdapter,
  setting: Setting,
  n: number,
): Promise<{ ns: number; calls: number; walks: number }> {
  const { server, calls } = peerServer(PEER[setting]);
  const before = calls();
  const walksBefore = walks;
  const start = Bun.nanoseconds();
  for (let i = 0; i < n; i++) {
    const served = app.serve(
      new Request("http://origin.test/r", { headers: HEADERS }),
      server,
    );
    const response = served instanceof Promise ? await served : served;
    if (response?.status !== 200) {
      throw new Error(`${setting}: answered ${response?.status}`);
    }
  }
  return {
    ns: (Bun.nanoseconds() - start) / n,
    calls: (calls() - before) / n,
    walks: (walks - walksBefore) / n,
  };
}

/** The median of `values`. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function measure(): Promise<Cell[]> {
  const apps = new Map<string, BenchAdapter>();
  for (const setting of SETTINGS) {
    for (const read of READS) {
      const app = adapterFor(setting, read);
      apps.set(`${setting}:${read}`, app);
      // Warm up: the JIT, the route cache, the compiled trust function.
      await time(app, setting, Math.min(2_000, REQUESTS));
    }
  }
  const samples = new Map<string, number[]>();
  const callsPer = new Map<string, number>();
  const walksPer = new Map<string, number>();
  for (let round = 0; round < ROUNDS; round++) {
    // Rotate the order each round, so no cell always runs first or last.
    const keys = [...apps.keys()];
    const order = keys
      .slice(round % keys.length)
      .concat(keys.slice(0, round % keys.length));
    for (const key of order) {
      const setting = key.split(":")[0] as Setting;
      const timed = await time(apps.get(key)!, setting, REQUESTS);
      samples.set(key, [...(samples.get(key) ?? []), timed.ns]);
      callsPer.set(key, timed.calls);
      walksPer.set(key, timed.walks);
    }
  }
  return [...apps.keys()].map((key) => {
    const [setting, read] = key.split(":") as [Setting, Read];
    return {
      setting,
      read,
      nsPerRequest: Math.round(median(samples.get(key)!)),
      requestIPPerRequest: callsPer.get(key)!,
      ...(setting === "counted" ? { walksPerRequest: walksPer.get(key)! } : {}),
    };
  });
}

function print(cells: Cell[]): void {
  console.log(
    `${"setting".padEnd(11)}${"read".padEnd(10)}${"ns/req".padStart(9)}${"vs off".padStart(9)}${"requestIP/req".padStart(15)}${"walks/req".padStart(11)}`,
  );
  for (const cell of cells) {
    const off = cells.find((c) => c.setting === "off" && c.read === cell.read);
    const delta =
      off === undefined ? "" : `+${cell.nsPerRequest - off.nsPerRequest}`;
    console.log(
      `${cell.setting.padEnd(11)}${cell.read.padEnd(10)}${String(cell.nsPerRequest).padStart(9)}${(cell.setting === "off" ? "" : delta).padStart(9)}${String(cell.requestIPPerRequest).padStart(15)}${String(cell.walksPerRequest ?? "-").padStart(11)}`,
    );
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  console.log(
    `Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${REQUESTS} requests x ${ROUNDS} rounds per cell`,
  );
  const loadStart = loadavg()[0]!;
  const cells = await measure();
  const loadEnd = loadavg()[0]!;
  console.log(
    `1-minute load ${loadStart.toFixed(2)} at the start, ${loadEnd.toFixed(2)} at the end`,
  );
  print(cells);
  if (args.includes("--save-baseline")) {
    await Bun.write(
      BASELINE,
      `${JSON.stringify({ bun: Bun.revision, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), requests: REQUESTS, rounds: ROUNDS, load: [Number(loadStart.toFixed(2)), Number(loadEnd.toFixed(2))], cells }, null, 2)}\n`,
    );
    console.log(`baseline written: ${BASELINE}`);
    return 0;
  }
  if (!args.includes("--compare")) return 0;
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) {
    console.log("no baseline recorded (baselines/trustProxy.json)");
    return 1;
  }
  const baseline = (await file.json()) as { cells: Cell[] };
  const failures: string[] = [];
  const overhead = (set: Cell[], cell: Cell): number | undefined => {
    const off = set.find((c) => c.setting === "off" && c.read === cell.read);
    return off === undefined ? undefined : cell.nsPerRequest - off.nsPerRequest;
  };
  for (const cell of cells) {
    const before = baseline.cells.find(
      (c) => c.setting === cell.setting && c.read === cell.read,
    );
    if (before === undefined) continue;
    if (cell.requestIPPerRequest > before.requestIPPerRequest) {
      failures.push(
        `${cell.setting}/${cell.read}: ${cell.requestIPPerRequest} requestIP() calls per request, baseline ${before.requestIPPerRequest}`,
      );
    }
    if (
      cell.walksPerRequest !== undefined &&
      before.walksPerRequest !== undefined &&
      cell.walksPerRequest > before.walksPerRequest
    ) {
      failures.push(
        `${cell.setting}/${cell.read}: ${cell.walksPerRequest} walks per request, baseline ${before.walksPerRequest}`,
      );
    }
    if (cell.setting === "off") continue;
    const now = overhead(cells, cell);
    const then = overhead(baseline.cells, before);
    if (now !== undefined && then !== undefined && now > 2 * then + 2_000) {
      failures.push(
        `${cell.setting}/${cell.read}: +${now} ns over off, baseline +${then}`,
      );
    }
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(await main());
