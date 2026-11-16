/**
 * The many-addresses anomaly across processes (layers.md L12, on S4's
 * shared state): three `Bun.spawn`ed enforcement points
 * (`__tests__/fixtures/ep-process.ts`) share one store — a SQLite file
 * (always), Redis and Postgres (when their URLs are set; unset skips
 * visibly, set but unreachable fails). One API key is used from seven
 * addresses, round-robin across the processes, with a limit of five: no
 * process alone sees more than three, so only the shared distinct count
 * can find it. The sixth address is refused (`ban`), the key's later
 * requests too, and `onKeyCompromised` is told once across the fleet. The
 * negative control runs the same traffic on three processes with their own
 * SQLite files: nobody sees more than three, nothing is found.
 *
 * A heavy job: run it through the heavy-run wrapper.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import type { SecurityPolicy } from "../../lib/index";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ep-process.ts");
const PREFIX = `bun_security_ak_${process.pid}_${Date.now() % 1_000_000}`;
const REDIS_URL =
  process.env.BUN_SECURITY_TEST_REDIS_URL ||
  process.env.BUN_CACHE_TEST_REDIS_URL ||
  process.env.BUN_JOBS_TEST_REDIS_URL ||
  undefined;
const POSTGRES_URL =
  process.env.BUN_SECURITY_TEST_POSTGRES_URL ||
  process.env.BUN_CACHE_TEST_POSTGRES_URL ||
  process.env.BUN_JOBS_TEST_POSTGRES_URL ||
  undefined;
const work = mkdtempSync(join(tmpdir(), "bun-security-ak-"));
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(async () => {
  for (const child of spawned) if (child.exitCode === null) child.kill();
  rmSync(work, { recursive: true, force: true });
  // Only what this run created: its own prefix.
  if (REDIS_URL !== undefined) {
    const client = new RedisClient(REDIS_URL);
    try {
      let cursor = "0";
      do {
        const [next, keys] = (await client.send("SCAN", [
          cursor,
          "MATCH",
          `${PREFIX}_redis*`,
          "COUNT",
          "1000",
        ])) as [string, string[]];
        cursor = next;
        if (keys.length > 0) await client.send("DEL", keys);
      } while (cursor !== "0");
    } finally {
      client.close();
    }
  }
  if (POSTGRES_URL !== undefined) {
    const sql = new SQL(POSTGRES_URL);
    try {
      for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${PREFIX}_postgres_${table}`);
      }
    } finally {
      await sql.close();
    }
  }
});

/** One spawned enforcement point. */
interface Point {
  /** Sends a request and resolves its answer. */
  ask: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Closes it and waits for it to exit. */
  close: () => Promise<void>;
}

/** Starts an enforcement point and waits for it to be ready. */
async function point(config: Record<string, unknown>): Promise<Point> {
  let next = 0;
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const child = Bun.spawn({
    cmd: [process.execPath, FIXTURE, JSON.stringify(config)],
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: Record<string, unknown>) {
      if (message.ready === true) {
        ready();
        return;
      }
      waiting.get(message.id as number)?.(message);
      waiting.delete(message.id as number);
    },
  });
  spawned.push(child);
  await Promise.race([
    started,
    child.exited.then((code) => {
      throw new Error(
        `the enforcement point exited with ${code} before it was ready`,
      );
    }),
  ]);
  const ask = (request: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.send({ ...request, id });
    });
  return {
    ask,
    close: async () => {
      await ask({ op: "close" });
      await child.exited;
    },
  };
}

const POLICY: SecurityPolicy = {
  apiKeys: { manyAddresses: { limit: 5, window: "1h", action: "ban" } },
};

/** The traffic: one key from seven addresses, round-robin over the points; the actions. */
async function drive(points: readonly Point[]): Promise<string[]> {
  const actions: string[] = [];
  for (let i = 0; i < 7; i++) {
    const answer = await points[i % points.length]?.ask({
      op: "apiKey",
      client: `45.7.0.${i + 1}`,
      apiKey: "key_fleet",
    });
    actions.push(String(answer?.action));
  }
  return actions;
}

/** What onKeyCompromised was told across the points. */
async function told(points: readonly Point[]): Promise<string[]> {
  const answers = await Promise.all(
    points.map((p) => p.ask({ op: "compromised" })),
  );
  return answers.flatMap((answer) => answer.compromised as string[]);
}

/** Three points on one backend's configuration. */
const three = (config: Record<string, unknown>) =>
  Promise.all([0, 1, 2].map(() => point(config)));

describe("the many-addresses anomaly across processes", () => {
  it("SQLite: found only through the shared count; refused from the sixth address; told once", async () => {
    const path = join(work, "shared.sqlite");
    const points = await three({
      backend: "sqlite",
      path,
      prefix: PREFIX,
      policy: POLICY,
      store: {},
    });
    try {
      const actions = await drive(points);
      expect(actions.slice(0, 5)).toEqual([
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
      ]);
      expect(actions[5]).toBe("ban");
      expect(await told(points)).toEqual(["key_fleet:apiKey.manyAddresses"]);
    } finally {
      await Promise.all(points.map((p) => p.close()));
    }
  }, 60_000);

  it("negative control: three processes with stores of their own never find it", async () => {
    const points = await Promise.all(
      [0, 1, 2].map((i) =>
        point({
          backend: "sqlite",
          path: join(work, `own-${i}.sqlite`),
          prefix: PREFIX,
          policy: POLICY,
          store: {},
        }),
      ),
    );
    try {
      expect(await drive(points)).toEqual([
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
      ]);
      expect(await told(points)).toEqual([]);
    } finally {
      await Promise.all(points.map((p) => p.close()));
    }
  }, 60_000);

  for (const [name, backend, url] of [
    ["Redis", "redis", REDIS_URL],
    ["Postgres", "postgres", POSTGRES_URL],
  ] as const) {
    if (url === undefined) {
      describe.skip(`${name}: not configured (BUN_CACHE_TEST_${backend.toUpperCase()}_URL)`, () => {
        it("skipped", () => {});
      });
      continue;
    }
    it(`${name}: found only through the shared count; refused from the sixth address; told once`, async () => {
      const prefix = `${PREFIX}_${backend}${backend === "postgres" ? "_" : ""}`;
      const points = await three({
        backend,
        url,
        prefix,
        policy: POLICY,
        store: {},
      });
      try {
        const actions = await drive(points);
        expect(actions.slice(0, 5)).toEqual([
          "allow",
          "allow",
          "allow",
          "allow",
          "allow",
        ]);
        expect(actions[5]).toBe("ban");
        expect(await told(points)).toEqual(["key_fleet:apiKey.manyAddresses"]);
      } finally {
        await Promise.all(points.map((p) => p.close()));
      }
    }, 60_000);
  }
});
