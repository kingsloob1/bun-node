/**
 * Live invalidation across processes — `cacheLiveBus` from
 * `@kingsleyweb/bun-cache/live` carries bun-common's live invalidations
 * (`@kingsleyweb/bun-common/live`) between processes, so a client watching
 * one process hears a change made through another.
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 \
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app \
 *   bun 10-live/two-processes.ts
 * ```
 *
 * - Three servers, each this file run again with `child` as its first
 *   argument: A and B on one bus channel, C on another. Each serves a tiny
 *   users API over one shared SQLite file (the data every process reads), with
 *   `liveInvalidation()` mounted first and `PATCH /users/:id` declaring
 *   `cache: { invalidates: ["user:{id}"] }`.
 * - A client subscribes to `user:1` on B (and on C), over the live channel's
 *   raw frames (bun-client's `live()` does this for a query client). A
 *   `PATCH` through A is published on A's bus; B numbers it in its own epoch
 *   and sends it to its subscriber, who refetches from B and reads the new
 *   name. C, on another channel, never hears it: the control.
 * - Each child connects with `connectLiveBus(cacheLiveBus(bus))` and waits for
 *   `ready` before it serves, so the demonstration cannot start before the
 *   subscription holds; `liveInvalidation(app, { authorize, bus })` is the
 *   one-line form when nothing needs to wait or close.
 * - Redis runs with `EXAMPLE_REDIS_URL` (or `BUN_CACHE_TEST_REDIS_URL`),
 *   Postgres with `EXAMPLE_POSTGRES_URL` (or `BUN_CACHE_TEST_POSTGRES_URL`);
 *   each sits out by name when unset. The channels carry this run's pid, and
 *   pub/sub and `NOTIFY` store nothing, so nothing is left behind; the SQLite
 *   file's directory is deleted at the end.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { connectLiveBus, liveInvalidation } from "@kingsleyweb/bun-common/live";
import { pgBus, redisBus } from "@kingsleyweb/bun-cache";
import { cacheLiveBus } from "@kingsleyweb/bun-cache/live";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** Where a child's bus is. */
interface Bus {
  /** `redis` or `postgres`. */
  kind: "redis" | "postgres";
  /** The server's URL. */
  url: string;
  /** The channel. */
  channel: string;
}

/* ------------------------------------------------------------------ */
// A server: `bun two-processes.ts child <bus JSON> <SQLite file>`.
if (process.argv[2] === "child") {
  const target = JSON.parse(process.argv[3]) as Bus;
  const db = new Database(process.argv[4]);
  db.run("PRAGMA busy_timeout = 5000");
  const bus =
    target.kind === "redis"
      ? redisBus({ url: target.url, channel: target.channel })
      : pgBus({ url: target.url, channel: target.channel });
  const connection = connectLiveBus(cacheLiveBus(bus));
  await connection.ready;

  const app = new BunHttpAdapter(0, { logger: noopLogger });
  app.use(liveInvalidation(app, { authorize: (_req, _res, next) => next() }));
  app.get("/users/:id", (req, res) => {
    const row = db
      .query<{ name: string }, [string]>("SELECT name FROM users WHERE id = ?")
      .get(req.params.id);
    if (row === null) res.status(404).json({ error: "no such user" });
    else res.json({ id: req.params.id, name: row.name });
  });
  app
    .patch("/users/:id", (req, res) => {
      const { name } = req.body as { name: string };
      db.run("UPDATE users SET name = ? WHERE id = ?", [name, req.params.id]);
      res.json({ id: req.params.id, name });
    })
    .describe({ cache: { invalidates: ["user:{id}"] } }); // published on a 2xx
  const server = (await app.listen(0)) as { port: number };
  await Bun.write(Bun.stdout, `${JSON.stringify({ port: server.port })}\n`);
  await Bun.stdin.text(); // until the parent closes our stdin
  await connection.close();
  await bus.close();
  await app.close();
  db.close();
  process.exit(0);
}

/** One running server. */
interface Server {
  /** Its base URL. */
  http: string;
  /** Its live channel. */
  ws: string;
  /** Stops it. */
  stop: () => Promise<void>;
}

/** Starts a server on `bus`, over the SQLite file `file`. */
async function startServer(bus: Bus, file: string): Promise<Server> {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "child", JSON.stringify(bus), file],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("a server exited before it served");
    buffered += decoder.decode(chunk.value);
  }
  const { port } = JSON.parse(buffered) as { port: number };
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/__live`,
    stop: async () => {
      await child.stdin.end();
      await child.exited;
    },
  };
}

/** A live frame as the client sees it. */
interface Frame {
  /** The frame's type (`hello`, `invalidate`, …). */
  type: string;
  /** Its data. */
  data?: Record<string, unknown>;
}

/** A live subscriber: the frames it received. */
async function subscribe(url: string, tags: string[]) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  ws.onmessage = (event) =>
    void frames.push(JSON.parse(String(event.data)) as Frame);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.send(JSON.stringify({ type: "subscribe", id: "s", data: { tags } }));
  await waitFor("the subscription's hello", () =>
    frames.some((frame) => frame.type === "hello"),
  );
  return {
    invalidated: () =>
      frames
        .filter((frame) => frame.type === "invalidate")
        .flatMap((frame) => frame.data?.tags as string[]),
    close: () => ws.close(),
  };
}

/** The demonstration on one bus server. */
async function demonstrate(kind: Bus["kind"], url: string): Promise<void> {
  step(`${kind}: A and B on one channel, C on another`);
  const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-live-"));
  const file = join(dir, "users.db");
  const db = new Database(file);
  db.run("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.run("INSERT INTO users VALUES ('1', 'Ada')");
  db.close();
  const channel = (n: number): string =>
    kind === "redis"
      ? `bun-cache-example:${process.pid}:live:${n}`
      : `bun_cache_example_${process.pid}_live_${n}`;
  const [a, b, c] = await Promise.all([
    startServer({ kind, url, channel: channel(1) }, file),
    startServer({ kind, url, channel: channel(1) }, file),
    startServer({ kind, url, channel: channel(2) }, file),
  ]);
  try {
    const onB = await subscribe(b.ws, ["user:1"]);
    const onC = await subscribe(c.ws, ["user:1"]);

    const patched = await fetch(`${a.http}/users/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Ada (${kind})` }),
    });
    checkEqual("the PATCH through A succeeded", patched.status, 200);

    await waitFor("B's subscriber to hear it", () =>
      onB.invalidated().includes("user:1"),
    );
    checkEqual("B's subscriber heard user:1", onB.invalidated(), ["user:1"]);
    // What its client does next: refetch, from B.
    const fresh = (await (await fetch(`${b.http}/users/1`)).json()) as {
      name: string;
    };
    show("refetched from B", fresh);
    checkEqual("and reads A's change", fresh.name, `Ada (${kind})`);

    await Bun.sleep(300);
    check(
      "C, on another channel, never heard it (the control)",
      onC.invalidated().length === 0,
      onC.invalidated(),
    );
    onB.close();
    onC.close();
  } finally {
    await Promise.all([a, b, c].map(async (server) => server.stop()));
    await rm(dir, { recursive: true, force: true });
  }
}

title("Live invalidation across processes: cacheLiveBus");

const redisUrl =
  process.env.EXAMPLE_REDIS_URL ?? process.env.BUN_CACHE_TEST_REDIS_URL;
if (redisUrl) await demonstrate("redis", redisUrl);
else {
  step("redis");
  show("sat out: set EXAMPLE_REDIS_URL to run it");
}

const postgresUrl =
  process.env.EXAMPLE_POSTGRES_URL ?? process.env.BUN_CACHE_TEST_POSTGRES_URL;
if (postgresUrl) await demonstrate("postgres", postgresUrl);
else {
  step("postgres");
  show("sat out: set EXAMPLE_POSTGRES_URL to run it");
}

summary();
