#!/usr/bin/env bun
/**
 * Static-asset benchmark — `useStaticAssets` vs Bun 1.4.1 `{ dir }` routes.
 *
 * Compares three ways to serve a directory of files on Bun:
 *
 *   - `use-static-assets`  bun-common's `BunHttpAdapter.useStaticAssets()`
 *   - `bun-dir`            Bun 1.4.1's native `routes: { "/static/*": { dir } }`
 *   - `bun-file`           a minimal hand-rolled `Bun.file()` handler, as a
 *                          floor for what the route layer alone costs
 *
 * Rounds are **interleaved** (A, B, C, A, B, C, …) rather than run back to
 * back, because throughput on a loaded workstation drifts by ~10% over the
 * span of a full sweep; interleaving makes that drift common-mode instead of
 * attributing it to whichever server happened to run last.
 *
 * Fixtures are generated into a temp directory at startup, so the numbers do
 * not depend on anything in the repo.
 *
 * Run `bun static.ts --help` for options.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunHttpAdapter } from "../packages/bun-common/lib/index";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

interface RunningServer {
  /** Base URL the load generator targets. */
  url: string;
  /** Shuts the server down and releases the port. */
  stop: () => Promise<void> | void;
}

interface Server {
  /** CLI id used by `--servers`. */
  id: string;
  /** Name shown in the results table. */
  label: string;
  /** Starts the server with `root` mounted under `/static`. */
  start: (port: number, root: string) => Promise<RunningServer>;
}

/** One measured figure for one server against one fixture. */
interface Sample {
  server: string;
  fixture: string;
  reqPerSec: number;
  latencyAvg: number;
  throughputMB: number;
  non2xx: number;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function printHelp(): void {
  console.log(`
Static-asset benchmark (Bun ${Bun.version})

Usage: bun static.ts [options]

Options:
  -c, --connections <n>   Concurrent connections        (default: 50)
  -d, --duration <s>      Seconds per measured run      (default: 4)
  -w, --warmup <s>        Warmup seconds (discarded)    (default: 2)
  -n, --rounds <n>        Interleaved A/B rounds        (default: 3)
  -f, --fixtures <names>  small|medium|large|all        (default: all)
  -s, --servers <ids>     use-static-assets|bun-dir|bun-file|all
      --port <n>          Base port                     (default: 43000)
      --json              Emit raw JSON samples
  -h, --help              Show this help
`);
}

const { values } = parseArgs({
  options: {
    connections: { type: "string", short: "c", default: "50" },
    duration: { type: "string", short: "d", default: "4" },
    warmup: { type: "string", short: "w", default: "2" },
    rounds: { type: "string", short: "n", default: "3" },
    fixtures: { type: "string", short: "f", default: "all" },
    servers: { type: "string", short: "s", default: "all" },
    port: { type: "string", default: "43000" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  connections: Math.max(1, toInt(values.connections, 50)),
  duration: Math.max(1, toInt(values.duration, 4)),
  warmup: Math.max(0, toInt(values.warmup, 2)),
  rounds: Math.max(1, toInt(values.rounds, 3)),
  basePort: toInt(values.port, 43000),
  json: !!values.json,
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Files served during the benchmark, keyed by fixture name. */
const FIXTURES: { name: string; file: string; bytes: number }[] = [
  { name: "small", file: "index.html", bytes: 512 },
  { name: "medium", file: "app.js", bytes: 64 * 1024 },
  { name: "large", file: "bundle.css", bytes: 1024 * 1024 },
];

const selectedFixtures =
  values.fixtures === "all"
    ? FIXTURES
    : FIXTURES.filter((f) =>
        String(values.fixtures)
          .split(",")
          .map((s) => s.trim())
          .includes(f.name),
      );

/** Writes the fixture files into a fresh temp directory and returns its path. */
function createFixtureRoot(): string {
  const root = join(tmpdir(), `bun-node-static-bench-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const fixture of FIXTURES) {
    // Deterministic, incompressible-enough filler; content is irrelevant, only
    // the byte count matters for the transfer cost.
    writeFileSync(join(root, fixture.file), "a".repeat(fixture.bytes));
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

const useStaticAssetsServer: Server = {
  id: "use-static-assets",
  label: "useStaticAssets (bun-common)",
  async start(port, root) {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });
    adapter.useStaticAssets(root, { prefix: "/static" });
    await adapter.listen(port);
    return {
      url: `http://127.0.0.1:${adapter.listeningPort}`,
      stop: () => adapter.close(),
    };
  },
};

const bunDirServer: Server = {
  id: "bun-dir",
  label: "Bun.serve { dir } (1.4+)",
  async start(port, root) {
    const server = Bun.serve({
      port,
      routes: {
        // Bun serves the tree itself: sendfile, Content-Type, ETag,
        // Last-Modified, 304 and Range all handled natively.
        "/static/*": { dir: root } as never,
      },
      fetch: () => new Response("not found", { status: 404 }),
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
};

const bunFileServer: Server = {
  id: "bun-file",
  label: "Bun.file in fetch (floor)",
  async start(port, root) {
    const server = Bun.serve({
      port,
      async fetch(request) {
        const url = request.url;
        const start = url.indexOf("/", url.indexOf("//") + 2);
        const query = url.indexOf("?", start);
        const pathname = query < 0 ? url.slice(start) : url.slice(start, query);
        if (!pathname.startsWith("/static/")) {
          return new Response("not found", { status: 404 });
        }
        const file = Bun.file(join(root, pathname.slice("/static".length)));
        if (!(await file.exists())) {
          return new Response("not found", { status: 404 });
        }
        return new Response(file);
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
};

const SERVERS: Record<string, Server> = {
  "use-static-assets": useStaticAssetsServer,
  "bun-dir": bunDirServer,
  "bun-file": bunFileServer,
};

const selectedServerIds =
  values.servers === "all"
    ? Object.keys(SERVERS)
    : String(values.servers)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

async function loadAutocannon(): Promise<any> {
  try {
    const mod = (await import("autocannon")) as { default?: any };
    return mod.default ?? mod;
  } catch {
    console.error(
      "Could not load `autocannon`. Run `bun install` inside benchmarks/.",
    );
    process.exit(1);
  }
}

let autocannon: any;

/** Asserts a server actually serves the fixture before it is timed. */
async function checkServed(url: string, file: string): Promise<string | null> {
  const response = await fetch(`${url}/static/${file}`);
  if (response.status !== 200) {
    return `GET /static/${file} → ${response.status}`;
  }
  await response.arrayBuffer();
  return null;
}

async function main(): Promise<void> {
  autocannon = await loadAutocannon();

  const targets: Server[] = [];
  for (const id of selectedServerIds) {
    const server = SERVERS[id];
    if (!server) {
      console.error(`Unknown server: "${id}"`);
      process.exit(1);
    }
    targets.push(server);
  }

  const root = createFixtureRoot();

  console.log("Static-asset benchmark");
  console.log(`  Bun ${Bun.version}  ·  ${navigator.hardwareConcurrency} CPUs`);
  console.log(
    `  servers: ${targets.map((t) => t.id).join(", ")}` +
      `  ·  fixtures: ${selectedFixtures.map((f) => f.name).join(", ")}` +
      `  ·  ${config.rounds} interleaved rounds`,
  );

  const samples: Sample[] = [];
  let portCursor = config.basePort;

  for (let round = 0; round < config.rounds; round++) {
    for (const server of targets) {
      const port = portCursor;
      portCursor += 10;

      const running = await server.start(port, root);
      try {
        for (const fixture of selectedFixtures) {
          // A server that 404s would post a huge, meaningless req/s.
          const problem = await checkServed(running.url, fixture.file);
          if (problem) {
            console.error(`\n  ! ${server.label}: ${problem} — excluded`);
            continue;
          }

          const target = `${running.url}/static/${fixture.file}`;
          if (config.warmup > 0) {
            await autocannon({
              url: target,
              connections: config.connections,
              duration: config.warmup,
            });
          }
          const result = await autocannon({
            url: target,
            connections: config.connections,
            duration: config.duration,
          });

          samples.push({
            server: server.label,
            fixture: fixture.name,
            reqPerSec: result.requests.average,
            latencyAvg: result.latency.average,
            throughputMB: result.throughput.average / (1024 * 1024),
            non2xx: result.non2xx ?? 0,
          });
          process.stdout.write(".");
        }
      } finally {
        await running.stop();
        await Bun.sleep(150);
      }
    }
  }
  process.stdout.write("\n");

  rmSync(root, { recursive: true, force: true });

  if (config.json) {
    console.log(JSON.stringify(samples, null, 2));
    return;
  }

  for (const fixture of selectedFixtures) {
    const rows = targets
      .map((server) => {
        const mine = samples.filter(
          (s) => s.server === server.label && s.fixture === fixture.name,
        );
        if (!mine.length) {
          return undefined;
        }
        // Median across rounds — one preempted round cannot swing the verdict.
        const sorted = [...mine].sort((a, b) => a.reqPerSec - b.reqPerSec);
        const median = sorted[Math.floor(sorted.length / 2)];
        return {
          label: server.label,
          reqPerSec: median.reqPerSec,
          latencyAvg: median.latencyAvg,
          throughputMB: median.throughputMB,
          runs: mine.map((s) => Math.round(s.reqPerSec)),
        };
      })
      .filter((row) => !!row)
      .sort((a, b) => b.reqPerSec - a.reqPerSec);

    const best = rows[0]?.reqPerSec ?? 0;
    const bytes = FIXTURES.find((f) => f.name === fixture.name)?.bytes ?? 0;

    console.log(
      `\n  Fixture: ${fixture.name} (${bytes.toLocaleString("en-US")} bytes)` +
        `  —  ${config.connections} conns, ${config.duration}s, median of ${config.rounds}`,
    );
    const rule = `  ${"-".repeat(94)}`;
    console.log(rule);
    console.log(
      `  ${"Server".padEnd(30)}${"Req/s".padStart(11)}${"Latency".padStart(11)}${"Throughput".padStart(14)}${"vs best".padStart(11)}   rounds`,
    );
    console.log(rule);
    for (const row of rows) {
      const ratio = best > 0 ? best / row.reqPerSec : 1;
      console.log(
        `  ${row.label.padEnd(30)}${Math.round(row.reqPerSec).toLocaleString("en-US").padStart(11)}${`${row.latencyAvg.toFixed(2)} ms`.padStart(11)}${`${row.throughputMB.toFixed(1)} MB/s`.padStart(14)}${(ratio <= 1.001 ? "1.00x (best)" : `${ratio.toFixed(2)}x`).padStart(11)}   ${row.runs.join(", ")}`,
      );
    }
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
