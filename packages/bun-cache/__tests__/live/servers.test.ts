/**
 * `cacheLiveBus` between processes on a real Redis (`BUN_CACHE_TEST_REDIS_URL`,
 * falling back to `BUN_JOBS_TEST_REDIS_URL`) and a real Postgres
 * (`BUN_CACHE_TEST_POSTGRES_URL`, the same fallback): each spawned
 * `live-worker.ts` serves bun-common's live invalidation on port 0 with its
 * own `redisBus` (or `pgBus`) → `cacheLiveBus` → `connectLiveBus`, and this
 * test is their client, over raw WebSockets and `fetch` (no bun-client).
 *
 * - **The proof**: a publish in one process reaches a socket and an SSE
 *   stream subscribed in the other, numbered in that process's epoch. Its
 *   negative control is permanent: a third process on another channel never
 *   hears it.
 * - **Ordering**: a sequence of publishes in one process arrives in the
 *   other in the same order, its numbers increasing.
 * - **The bus down** (Redis): killing a process's subscriber connection
 *   (`CLIENT KILL`) sends its sockets a `gap`, and delivery resumes once
 *   Bun reconnects; a process whose Redis is unreachable still delivers its
 *   own invalidations to its own subscribers.
 *
 * The proof and the ordering run on both; the rest on Redis. Each run's
 * channels carry the pid and a timestamp (pub/sub ignores the database
 * number, `NOTIFY` the schema); nothing is stored, so nothing is left behind.
 */
import process from "node:process";
import { RedisClient, SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import {
  redisBackend,
  redisReachError,
  sqlBackends,
} from "../drivers/backends";
import { reportNotConfigured, reportUnreachable } from "../drivers/sqlSuite";
import type { LiveWorkerJob, LiveWorkerReady } from "./live-worker";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

/** One spawned server. */
interface Worker extends LiveWorkerReady {
  /** Its base URL. */
  http: string;
  /** Its live channel's URL. */
  ws: string;
  /** Publishes `tags` there, once (`sequence`: one publish per tag). */
  publish: (tags: string[], sequence?: boolean) => Promise<void>;
  /** Stops it. */
  close: () => Promise<void>;
}

const spawned = new Set<Worker>();
afterAll(async () => {
  await Promise.all([...spawned].map(async (worker) => await worker.close()));
});

/** Spawns a worker for `job`; resolves once it serves. */
async function spawnWorker(job: LiveWorkerJob): Promise<Worker> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      new URL("./live-worker.ts", import.meta.url).pathname,
      JSON.stringify(job),
    ],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffered = "";
  const decoder = new TextDecoder();
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(
        `live-worker exited ${await child.exited}: ${(await stderr).trim()}`,
      );
    }
    buffered += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  const ready = JSON.parse(
    buffered.slice(0, buffered.indexOf("\n")),
  ) as LiveWorkerReady;
  const http = `http://127.0.0.1:${ready.port}`;
  const worker: Worker = {
    ...ready,
    http,
    ws: `ws://127.0.0.1:${ready.port}/__live`,
    publish: async (tags, sequence = false) => {
      const response = await fetch(
        `${http}/control/${sequence ? "sequence" : "publish"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags }),
        },
      );
      expect(response.status).toBe(204);
    },
    close: async () => {
      if (!spawned.delete(worker)) return;
      void child.stdin.end();
      const exited = await Promise.race([
        child.exited,
        Bun.sleep(5_000).then(() => undefined),
      ]);
      if (exited === undefined) child.kill();
    },
  };
  spawned.add(worker);
  return worker;
}

/** A frame as the client sees it. */
interface Frame {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

/** A raw live client. */
async function socketOf(url: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  let next = 0;
  ws.onmessage = (event) =>
    void frames.push(JSON.parse(String(event.data)) as Frame);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`${url} did not open`));
  });
  const request = async (type: string, data: unknown): Promise<Frame> => {
    const id = `r${++next}`;
    ws.send(JSON.stringify({ type, id, data }));
    let reply: Frame | undefined;
    await until(() => {
      reply = frames.find((frame) => frame.id === id);
      return reply !== undefined;
    });
    return reply!;
  };
  const of = (type: string) => frames.filter((frame) => frame.type === type);
  return { ws, frames, request, of };
}

/** Reads an SSE response's events as they arrive. */
function readEvents(response: Response) {
  const list: { event: string; data: Record<string, unknown> }[] = [];
  void (async () => {
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        for (
          let end = buffer.indexOf("\n\n");
          end >= 0;
          end = buffer.indexOf("\n\n")
        ) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) continue;
          const field = (name: string) =>
            block
              .split("\n")
              .find((line) => line.startsWith(`${name}: `))
              ?.slice(name.length + 2) ?? "";
          list.push({
            event: field("event"),
            data: JSON.parse(field("data")) as Record<string, unknown>,
          });
        }
      }
    } catch {
      // Aborted.
    }
  })();
  return { list };
}

const run = `${process.pid}-${Date.now()}`;
let channels = 0;
/** A channel of this run's own: a Redis channel, or a Postgres identifier. */
const channelOf = (kind: "redis" | "postgres" = "redis"): string =>
  kind === "redis"
    ? `bun-cache-test:${run}:live:${++channels}`
    : `bun_cache_test_live_${run.replace("-", "_")}_${++channels}`;

/** Connects once to the Postgres server at `url`; answers the failure, not a boolean. */
async function postgresReachError(url: string): Promise<Error | undefined> {
  const sql = new SQL(url, { connectionTimeout: 3 });
  try {
    await sql`SELECT 1`;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/** The proof and the ordering, on `kind`'s server at `url`. */
function crossProcessSuite(kind: "redis" | "postgres", url: string): void {
  describe(`live invalidation across processes (${kind})`, () => {
    it("a publish in one process reaches the other's socket and SSE stream; a process on another channel never hears it", async () => {
      const channel = channelOf(kind);
      const [a, b, c] = await Promise.all([
        spawnWorker({ kind, url, channel }),
        spawnWorker({ kind, url, channel }),
        spawnWorker({ kind, url, channel: channelOf(kind) }),
      ]);
      const tag = `user:${run}`;
      const sockets = await Promise.all(
        [a, b, c].map(async (worker) => await socketOf(worker.ws)),
      );
      const hellos = await Promise.all(
        sockets.map(
          async (socket) =>
            (await socket.request("subscribe", { tags: [tag] })).data!,
        ),
      );
      const controller = new AbortController();
      const stream = readEvents(
        await fetch(`${b.http}/__live/sse?tag=${encodeURIComponent(tag)}`, {
          signal: controller.signal,
        }),
      );
      await until(() => stream.list.length === 1); // hello
      await a.publish([tag]);
      const [onA, onB] = sockets;
      await until(
        () =>
          onA!.of("invalidate").length === 1 &&
          onB!.of("invalidate").length === 1 &&
          stream.list.length === 2,
      );
      // Each process numbers it in its own epoch.
      expect(onA!.of("invalidate")[0]!.data).toEqual({
        tags: [tag],
        seq: (hellos[0]!.seq as number) + 1,
        epoch: hellos[0]!.epoch,
      });
      expect(onB!.of("invalidate")[0]!.data).toEqual({
        tags: [tag],
        seq: (hellos[1]!.seq as number) + 1,
        epoch: hellos[1]!.epoch,
      });
      expect(hellos[0]!.epoch).not.toBe(hellos[1]!.epoch);
      expect(stream.list[1]).toEqual({
        event: "invalidate",
        data: onB!.of("invalidate")[0]!.data!,
      });
      // The negative control: another channel never hears it.
      await Bun.sleep(300);
      expect(sockets[2]!.of("invalidate")).toEqual([]);
      // And nobody heard it twice.
      expect(onA!.of("invalidate").length).toBe(1);
      expect(onB!.of("invalidate").length).toBe(1);
      expect(sockets.flatMap((s) => s.of("gap"))).toEqual([]);
      controller.abort();
      for (const socket of sockets) socket.ws.close();
      await Promise.all([a, b, c].map(async (worker) => await worker.close()));
    }, 30_000);

    it("keeps one process's order in the other", async () => {
      const channel = channelOf(kind);
      const [a, b] = await Promise.all([
        spawnWorker({ kind, url, channel }),
        spawnWorker({ kind, url, channel }),
      ]);
      const tags = Array.from({ length: 50 }, (_, i) => `o:${run}:${i}`);
      const socket = await socketOf(b.ws);
      await socket.request("subscribe", { tags });
      await a.publish(tags, true);
      await until(() => socket.of("invalidate").length === tags.length);
      const frames = socket.of("invalidate");
      expect(frames.map((f) => (f.data!.tags as string[])[0])).toEqual(tags);
      const seqs = frames.map((f) => f.data!.seq as number);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(socket.of("gap")).toEqual([]);
      socket.ws.close();
      await Promise.all([a, b].map(async (worker) => await worker.close()));
    }, 30_000);
  });
}

const backend = redisBackend();
const url = backend.url;
const reach = url === undefined ? undefined : await redisReachError(url);

if (url === undefined) {
  reportNotConfigured("redis", backend.variable);
} else if (reach !== undefined) {
  reportUnreachable("redis", backend.variable, reach);
} else {
  crossProcessSuite("redis", url);
  describe("live invalidation across processes (redis): the bus down", () => {
    it("sends a gap when a process's subscriber connection drops, and delivers again once it is back", async () => {
      const channel = channelOf();
      const [a, b] = await Promise.all([
        spawnWorker({ url, channel }),
        spawnWorker({ url, channel }),
      ]);
      const tag = `k:${run}`;
      const socket = await socketOf(b.ws);
      const hello = (await socket.request("subscribe", { tags: [tag] })).data!;
      const helper = new RedisClient(url);
      try {
        const list = (await helper.send("CLIENT", [
          "LIST",
          "TYPE",
          "pubsub",
        ])) as string;
        const line = list
          .split("\n")
          .find((each) => each.includes(` name=${b.connectionName} `));
        const id = /\bid=(\d+)/.exec(line ?? "")?.[1];
        expect(id).toBeDefined();
        await helper.send("CLIENT", ["KILL", "ID", id!]);
      } finally {
        helper.close();
      }
      await until(() => socket.of("gap").length === 1, 10_000);
      const gap = socket.of("gap")[0]!.data!;
      expect(gap.epoch).toBe(hello.epoch);
      expect(gap.seq as number).toBeGreaterThan(hello.seq as number);
      // Back: a publish reaches it again (published until one arrives, since
      // the gap is sent as Bun reconnects, before its SUBSCRIBE is through).
      const deadline = Date.now() + 10_000;
      while (socket.of("invalidate").length === 0) {
        if (Date.now() > deadline) throw new Error("never delivered again");
        await a.publish([tag]);
        await Bun.sleep(100);
      }
      expect(socket.of("invalidate")[0]!.data!.seq as number).toBeGreaterThan(
        gap.seq as number,
      );
      socket.ws.close();
      await Promise.all([a, b].map(async (worker) => await worker.close()));
    }, 40_000);

    it("delivers a process's own invalidations to its own subscribers while its bus is unreachable", async () => {
      // Port 1: nothing listens there.
      const down = await spawnWorker({
        url: "redis://127.0.0.1:1",
        channel: channelOf(),
        waitReady: false,
      });
      const tag = `d:${run}`;
      const socket = await socketOf(down.ws);
      await socket.request("subscribe", { tags: [tag] });
      await down.publish([tag]);
      await until(() => socket.of("invalidate").length === 1);
      await down.publish([tag]);
      await until(() => socket.of("invalidate").length === 2);
      socket.ws.close();
      await down.close();
    }, 30_000);
  });
}

const postgres = sqlBackends().find((each) => each.name === "postgres")!;
const postgresReach =
  postgres.url === undefined
    ? undefined
    : await postgresReachError(postgres.url);
if (postgres.url === undefined) {
  reportNotConfigured("postgres", postgres.variable);
} else if (postgresReach !== undefined) {
  reportUnreachable("postgres", postgres.variable, postgresReach);
} else {
  crossProcessSuite("postgres", postgres.url);
}
