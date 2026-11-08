/* eslint-disable antfu/no-top-level-await, n/no-top-level-await, no-console */
/**
 * SSE fan-out benchmark guard (bun-native-routes plan §16.9, §16.11 PR-sse2):
 * events/s delivered to N clients each reading M events, for bun-common's
 * `res.sse()` against two rivals: the raw `Bun.serve` stream with the same
 * byte-length queue (the ceiling) and bun-common's own `res.write()` (what an
 * app writes by hand). One fresh server process per cell; the clients are raw
 * TCP sockets in another process (`fetch` queues past 256 per process).
 *
 *   cd packages/bun-common/bench
 *   bun sse.ts                    # print the table
 *   bun sse.ts --compare          # fail if res.sse() regressed or was overtaken
 *   bun sse.ts --save-baseline    # record baselines/sse.json, after a deliberate change
 *   SSE_SHAPES=10x100 bun sse.ts  # a smoke run (clients x events), nothing compared
 *
 * Like every benchmark here it runs through the heavy-run wrapper, alone, and
 * a comparison or a baseline needs the maintainer's yes first (CLAUDE.md).
 * `--compare` fails when `res.sse()` falls more than 35% behind its own
 * baseline, or when `res.write()` delivers more than 10% more events/s than
 * it (the overtaken check, which a busy machine cannot fake: it slows both;
 * a margin since S10 put `res.write()` on the same queue).
 */
import { join } from "node:path";
import process from "node:process";

const SELF = import.meta.path;
const BASELINE = join(import.meta.dir, "baselines/sse.json");
const TARGETS = ["raw-hwm", "common-write", "common-sse"] as const;
/**
 * How far `res.write()` may lead `res.sse()` before it counts as overtaking:
 * since S10 both stream on a 64 KiB byte-length queue, they are near ties
 * (measured 2026-11-08: from 14% behind to 1% ahead), and a strict
 * comparison would fail on noise.
 */
const OVERTAKE_MARGIN = 0.1;
type Target = (typeof TARGETS)[number];

/** One measured cell. */
interface Cell {
  /** The server's target. */
  target: Target;
  /** Clients. */
  n: number;
  /** Events each client reads. */
  m: number;
  /** Events delivered per second, across every client. */
  eventsPerSec: number;
}

// ---------------------------------------------------------------------------
// The server: `bun sse.ts --serve <target>`
// ---------------------------------------------------------------------------

async function serve(target: Target): Promise<void> {
  const { BunHttpAdapter, encodeSseEvent } = await import("../lib/index");
  const event = encodeSseEvent({ data: "x".repeat(50) }); // 58 bytes
  const sinks = new Set<(bytes: Uint8Array) => void>();
  const broadcast = async (m: number): Promise<void> => {
    for (let sent = 0; sent < m; sent += 100) {
      for (let i = 0; i < Math.min(100, m - sent); i++) {
        for (const sink of sinks) sink(event);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  if (target === "raw-hwm") {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/go") {
          await broadcast(Number(new URL(req.url).searchParams.get("m")));
          return new Response("ok");
        }
        let sink: (bytes: Uint8Array) => void = () => {};
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                sink = (bytes) => controller.enqueue(bytes);
                sinks.add(sink);
                controller.enqueue(encodeSseEvent({ comment: "ok" }));
              },
              cancel: () => void sinks.delete(sink),
            },
            new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    console.log(`PORT ${server.port}`);
    return;
  }
  const app = new BunHttpAdapter(0, { server: { idleTimeout: 0 } });
  app.post("/go", async (req, res) => {
    await broadcast(Number(req.query.m));
    res.send("ok");
  });
  app.get("/e", (_req, res) => {
    if (target === "common-write") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(": ok\n\n");
      const sink = (bytes: Uint8Array): void => void res.write(bytes);
      sinks.add(sink);
      res.on("close", () => sinks.delete(sink));
      return;
    }
    const stream = res.sse({ heartbeatMs: 0 });
    const sink = (bytes: Uint8Array): void => void stream.send(bytes);
    sinks.add(sink);
    stream.onClose(() => sinks.delete(sink));
  });
  await app.listen(0);
  console.log(`PORT ${app.listeningPort}`);
}

// ---------------------------------------------------------------------------
// The clients: `bun sse.ts --clients <port> <n> <m>`
// ---------------------------------------------------------------------------

async function clients(port: number, n: number, m: number): Promise<void> {
  const state = Array.from({ length: n }, () => ({
    pairs: 0,
    last: 0,
    ready: false,
    target: Infinity,
    done: false,
  }));
  let ready = 0;
  let done = 0;
  let onReady = (): void => {};
  let onDone = (): void => {};
  await Promise.all(
    state.map(
      async (c) =>
        void (await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(socket) {
              socket.write("GET /e HTTP/1.1\r\nHost: x\r\n\r\n");
            },
            data(_socket, buffer) {
              let previous = c.last;
              for (const byte of buffer) {
                if (byte === 10 && previous === 10) c.pairs++;
                previous = byte;
              }
              c.last = previous;
              if (!c.ready) {
                c.ready = true;
                if (++ready === n) onReady();
              }
              if (!c.done && c.pairs >= c.target) {
                c.done = true;
                if (++done === n) onDone();
              }
            },
          },
        })),
    ),
  );
  if (ready < n) await new Promise<void>((resolve) => (onReady = resolve));
  await Bun.sleep(100);
  for (const c of state) c.target = c.pairs + m;
  const allDone = new Promise<void>((resolve) => (onDone = resolve));
  const start = performance.now();
  const go = fetch(`http://127.0.0.1:${port}/go?m=${m}`, { method: "POST" });
  await allDone;
  const ms = performance.now() - start;
  await go;
  console.log(
    JSON.stringify({ eventsPerSec: Math.round((n * m) / (ms / 1000)) }),
  );
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

async function cell(target: Target, n: number, m: number): Promise<Cell> {
  const server = Bun.spawn(["bun", SELF, "--serve", target], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const reader = server.stdout.getReader();
    let text = "";
    while (!/PORT \d+/.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${target}: the server exited (${text})`);
      text += new TextDecoder().decode(value);
    }
    const port = /PORT (\d+)/.exec(text)![1];
    const client = Bun.spawn(
      ["bun", SELF, "--clients", port, String(n), String(m)],
      { stdout: "pipe", stderr: "inherit" },
    );
    const out = await Promise.race([
      new Response(client.stdout).text(),
      Bun.sleep(120_000).then(() => ""),
    ]);
    client.kill();
    if (out.trim() === "") throw new Error(`${target} n=${n}: timed out`);
    const { eventsPerSec } = JSON.parse(out) as { eventsPerSec: number };
    return { target, n, m, eventsPerSec };
  } finally {
    server.kill();
    await server.exited;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const shapes: [number, number][] = process.env.SSE_SHAPES
    ? process.env.SSE_SHAPES.split(",").map(
        (shape) => shape.split("x").map(Number) as [number, number],
      )
    : [
        [100, 1000],
        [1000, 100],
      ];
  const cells: Cell[] = [];
  for (const [n, m] of shapes) {
    for (const target of TARGETS) {
      const measured = await cell(target, n, m);
      cells.push(measured);
      console.log(
        `${target.padEnd(13)} n=${String(n).padEnd(5)} m=${String(m).padEnd(5)} ${String(measured.eventsPerSec).padStart(10)} ev/s`,
      );
    }
  }
  if (args.includes("--save-baseline")) {
    await Bun.write(
      BASELINE,
      `${JSON.stringify({ bun: Bun.revision, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), cells }, null, 2)}\n`,
    );
    console.log(`baseline written: ${BASELINE}`);
    return 0;
  }
  if (!args.includes("--compare")) return 0;
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) {
    console.log(
      "no baseline recorded (baselines/sse.json): nothing to compare",
    );
    return 1;
  }
  const baseline = (await file.json()) as { cells: Cell[] };
  const failures: string[] = [];
  for (const [n] of shapes) {
    const ours = cells.find((c) => c.target === "common-sse" && c.n === n);
    const rival = cells.find((c) => c.target === "common-write" && c.n === n);
    const before = baseline.cells.find(
      (c) => c.target === "common-sse" && c.n === n,
    );
    if (ours === undefined) continue;
    // Since S10 res.write() streams on the same byte-length queue, so the two
    // are near ties: overtaken means ahead by more than OVERTAKE_MARGIN.
    if (
      rival !== undefined &&
      rival.eventsPerSec > ours.eventsPerSec * (1 + OVERTAKE_MARGIN)
    ) {
      failures.push(
        `n=${n}: res.write() overtook res.sse() by more than ${OVERTAKE_MARGIN * 100}%`,
      );
    }
    if (
      before !== undefined &&
      ours.eventsPerSec < before.eventsPerSec * 0.65
    ) {
      failures.push(
        `n=${n}: res.sse() ${ours.eventsPerSec} ev/s, more than 35% behind its baseline ${before.eventsPerSec}`,
      );
    }
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

const mode = process.argv[2];
if (mode === "--serve") {
  await serve(process.argv[3] as Target);
} else if (mode === "--clients") {
  const [port, n, m] = process.argv.slice(3).map(Number);
  await clients(port, n, m);
  process.exit(0);
} else {
  process.exit(await main());
}
