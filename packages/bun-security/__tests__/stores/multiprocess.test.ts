/**
 * Topology (b) with real processes (plan §11.4): `Bun.spawn`ed enforcement
 * points (`__tests__/fixtures/ep-process.ts`) sharing Redis or Postgres
 * (through their buses) or one SQLite file (polled). A ban written by one is enforced by the
 * others within the stream's window (Redis, target 1 s) or the poll's
 * (SQLite); a shared limit is exact and a hybrid one holds within its
 * bound, driven round-robin; with Redis behind a proxy the test stops,
 * each process degrades to its local share and comes back to the shared
 * count when the store does. On all three, `state.scope`: a per-service
 * ban reaches the service's other process and no other service, a shared
 * one every shared service and no per-service one.
 *
 * Redis needs `BUN_SECURITY_TEST_REDIS_URL` (or bun-cache's, or bun-jobs'):
 * unset skips visibly, set but unreachable fails. SQLite always runs. Each
 * run uses its own key and table prefix and removes it. A heavy job: run it
 * through the heavy-run wrapper.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import type { Socket, TCPSocketListener } from "bun";
import type { SecurityPolicy } from "../../lib/index";
import {
  credentialStuffing,
  distributedGuessing,
} from "../../lib/testing/index";
import type { CacheStoreOptions } from "../../lib/stores/index";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ep-process.ts");
const PREFIX = `bun_security_mp_${process.pid}_${Date.now() % 1_000_000}`;
const POSTGRES_URL =
  process.env.BUN_SECURITY_TEST_POSTGRES_URL ||
  process.env.BUN_CACHE_TEST_POSTGRES_URL ||
  process.env.BUN_JOBS_TEST_POSTGRES_URL ||
  undefined;
const REDIS_URL =
  process.env.BUN_SECURITY_TEST_REDIS_URL ||
  process.env.BUN_CACHE_TEST_REDIS_URL ||
  process.env.BUN_JOBS_TEST_REDIS_URL ||
  undefined;

/** One spawned enforcement point. */
interface Point {
  /** Sends a request and resolves its answer. */
  ask: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Closes it and waits for it to exit. */
  close: () => Promise<void>;
}

/** Every process a test spawned, killed (by its own PID) if still running. */
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const child of spawned) {
    if (child.exitCode === null) child.kill();
  }
});

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
      const id = message.id as number;
      waiting.get(id)?.(message);
      waiting.delete(id);
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

/** Starts `n` points on one configuration. */
function points(n: number, config: Record<string, unknown>): Promise<Point[]> {
  return Promise.all(Array.from({ length: n }, () => point(config)));
}

/** Waits until every point reports `ban` among its bans; answers how long it took. */
async function propagation(
  list: readonly Point[],
  ban: string,
): Promise<number> {
  const start = performance.now();
  for (;;) {
    const answers = await Promise.all(list.map((p) => p.ask({ op: "bans" })));
    if (answers.every((answer) => (answer.bans as string[]).includes(ban))) {
      return performance.now() - start;
    }
    if (performance.now() - start > 15_000) throw new Error("not propagated");
    await Bun.sleep(10);
  }
}

/** A forwarding TCP proxy to `host:port` that the test can stop and start again. */
function proxy(host: string, port: number) {
  let listener: TCPSocketListener<{ upstream?: Socket<unknown> }> | undefined;
  const open = new Set<Socket<unknown>>();
  let listenPort = 0;
  const start = async (): Promise<number> => {
    listener = Bun.listen<{
      upstream?: Socket<unknown>;
      pending?: Uint8Array[];
    }>({
      hostname: "127.0.0.1",
      port: listenPort,
      socket: {
        open(client) {
          open.add(client);
          client.data = { pending: [] };
          void Bun.connect({
            hostname: host,
            port,
            socket: {
              open(upstream) {
                open.add(upstream);
                client.data.upstream = upstream;
                for (const chunk of client.data.pending ?? [])
                  upstream.write(chunk);
                client.data.pending = undefined;
              },
              data(_upstream, data) {
                client.write(data);
              },
              close() {
                client.end();
              },
              error() {
                client.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, data) {
          if (client.data.upstream) client.data.upstream.write(data);
          else client.data.pending?.push(new Uint8Array(data));
        },
        close(client) {
          client.data.upstream?.end();
          open.delete(client);
        },
        error(client) {
          client.data.upstream?.end();
        },
      },
    });
    listenPort = listener.port;
    return listenPort;
  };
  const stop = () => {
    listener?.stop(true);
    listener = undefined;
    for (const socket of open) socket.terminate();
    open.clear();
  };
  return { start, stop };
}

/** The store options of a run: short intervals, a short circuit. */
const storeOptions: CacheStoreOptions = {
  timeout: "300ms",
  circuit: { failures: 2, cooldown: "1s" },
  syncInterval: "100ms",
  pollInterval: "250ms",
  reconcileInterval: "2s",
};

/** The actions of `n` requests from `client` to `path`, round-robin. */
async function drive(
  list: readonly Point[],
  n: number,
  client: string,
  path = "/",
): Promise<string[]> {
  const actions: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = list[i % list.length];
    if (p === undefined) throw new Error("no point");
    actions.push(
      (await p.ask({ op: "evaluate", client, path })).action as string,
    );
  }
  return actions;
}

/**
 * `state.scope` across processes: services a (two processes) and b keep
 * their bans to themselves, c and d share. A ban written by a's first
 * process reaches a's second and none of b, c, d; one written by c reaches
 * d (the control that propagation works in this run) and neither a nor b.
 */
async function scopeCase(
  config: (policy: SecurityPolicy) => Record<string, unknown>,
  window: number,
): Promise<void> {
  const own = (service: string): SecurityPolicy => ({
    service,
    state: { scope: "service" },
  });
  const shared = (service: string): SecurityPolicy => ({ service });
  const [a1, a2, b, c, d] = await Promise.all([
    point(config(own("a"))),
    point(config(own("a"))),
    point(config(own("b"))),
    point(config(shared("c"))),
    point(config(shared("d"))),
  ]);
  if (!a1 || !a2 || !b || !c || !d) throw new Error("five");
  const list = [a1, a2, b, c, d];
  const bans = async (p: Point) =>
    (await p.ask({ op: "bans" })).bans as string[];
  try {
    await a1.ask({ op: "ban", ip: "203.0.113.90" });
    await c.ask({ op: "ban", ip: "203.0.113.91" });
    await propagation([a2], "ip:203.0.113.90");
    await propagation([d], "ip:203.0.113.91");
    // Past the window the other services still have not taken them.
    await Bun.sleep(window);
    for (const p of list) await p.ask({ op: "flush" });
    expect(await bans(a2)).toEqual(["ip:203.0.113.90"]);
    expect(await bans(b)).toEqual([]);
    expect(await bans(c)).toEqual(["ip:203.0.113.91"]);
    expect(await bans(d)).toEqual(["ip:203.0.113.91"]);
    expect(await bans(a1)).toEqual(["ip:203.0.113.90"]);
    const refused = await b.ask({ op: "evaluate", client: "203.0.113.90" });
    expect(refused.action).toBe("allow");
  } finally {
    for (const p of list) await p.close();
  }
}

/** The secret every process of the login cases shares. */
const SECRET = "multi-process-secret-of-at-least-32-bytes";

/** The login cases' policy: the address limits off, so only the account defences act. */
const LOGIN_POLICY: SecurityPolicy = {
  service: "auth",
  presets: {
    "login.account": false,
    "login.ip": false,
    "login.ip-failures": false,
    "login.ip-failures-ban": false,
  },
};

/**
 * T-L11-1 across processes on one store: credential stuffing (one address
 * failing 30 usernames, spread over three processes) bans the address in
 * every process; password spraying (twelve addresses failing one username)
 * challenges and tags `step-up` on any process. The control: three
 * processes each on a store of their own see a third each, and act on
 * nothing.
 */
async function loginCases(
  config: (policy: SecurityPolicy, prefix: string) => Record<string, unknown>,
  prefix: string,
): Promise<void> {
  const run = async (prefixes: readonly string[]) => {
    const list = await Promise.all(
      prefixes.map((own) =>
        point({ ...config(LOGIN_POLICY, own), secret: SECRET }),
      ),
    );
    try {
      for (let i = 0; i < 30; i++) {
        await list[i % 3]?.ask({
          op: "login",
          username: `user${i}@example.org`,
          client: "203.0.113.90",
          outcome: "failure",
        });
      }
      for (const p of list) await p.ask({ op: "flush" });
      for (let i = 0; i < 12; i++) {
        await list[i % 3]?.ask({
          op: "login",
          username: "victim@example.org",
          client: `198.51.100.${i + 1}`,
          outcome: "failure",
        });
      }
      const deadline = performance.now() + 5_000;
      let banned: boolean[] = [];
      while (performance.now() < deadline) {
        for (const p of list) await p.ask({ op: "flush" });
        banned = await Promise.all(
          list.map(async (p) =>
            ((await p.ask({ op: "bans" })).actions as string[]).includes(
              "ip:203.0.113.90:ban",
            ),
          ),
        );
        if (banned.every(Boolean)) break;
        await Bun.sleep(50);
      }
      const spray = await list[2]?.ask({
        op: "login",
        username: "victim@example.org",
        client: "198.51.100.200",
        outcome: "none",
      });
      return { banned, spray };
    } finally {
      for (const p of list) await p.close();
    }
  };
  const shared = await run([prefix, prefix, prefix]);
  expect(shared.banned).toEqual([true, true, true]);
  expect(shared.spray?.tags).toEqual(["step-up"]);
  expect(shared.spray?.action).toBe("block");
  const apart = await run([`${prefix}1`, `${prefix}2`, `${prefix}3`]);
  expect(apart.banned).toEqual([false, false, false]);
  expect(apart.spray?.tags).toEqual([]);
  expect(apart.spray?.action).toBe("allow");
}

/**
 * T-L11-1 driven by T2's simulators (PR-T1): `credentialStuffing` from one
 * address and `distributedGuessing` on one account, their requests sent
 * round-robin to three processes as failed sign-ins. Shared, the stuffer is
 * banned on every process and the guessed account's next sign-in is
 * stepped up; on three stores apart (the negative control), nothing is
 * found, as no process alone sees enough.
 */
async function attackCase(
  config: (policy: SecurityPolicy, prefix: string) => Record<string, unknown>,
  prefix: string,
): Promise<void> {
  const stuffing = credentialStuffing({ count: 30, client: "203.0.113.91" });
  const guessing = distributedGuessing({
    username: "victim@example.org",
    count: 12,
    base: "198.51",
  });
  /** The username a simulated sign-in names. */
  const userOf = (body: string | undefined) =>
    (JSON.parse(body ?? "{}") as { username?: string }).username ?? "";
  const run = async (prefixes: readonly string[]) => {
    const list = await Promise.all(
      prefixes.map((own) =>
        point({ ...config(LOGIN_POLICY, own), secret: SECRET }),
      ),
    );
    try {
      let i = 0;
      for (const request of [...stuffing.requests, ...guessing.requests]) {
        await list[i++ % 3]?.ask({
          op: "login",
          username: userOf(request.body),
          client: request.client,
          outcome: "failure",
        });
      }
      let banned: boolean[] = [];
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        for (const p of list) await p.ask({ op: "flush" });
        banned = await Promise.all(
          list.map(async (p) =>
            ((await p.ask({ op: "bans" })).actions as string[]).includes(
              "ip:203.0.113.91:ban",
            ),
          ),
        );
        if (banned.every(Boolean)) break;
        await Bun.sleep(50);
      }
      const next = await list[1]?.ask({
        op: "login",
        username: "victim@example.org",
        client: "192.0.2.250",
        outcome: "none",
      });
      return { banned, next };
    } finally {
      for (const p of list) await p.close();
    }
  };
  const shared = await run([prefix, prefix, prefix]);
  expect(shared.banned).toEqual([true, true, true]);
  expect(shared.next?.tags).toEqual(["step-up"]);
  const apart = await run([`${prefix}1`, `${prefix}2`, `${prefix}3`]);
  expect(apart.banned).toEqual([false, false, false]);
  expect(apart.next?.tags).toEqual([]);
}

/** The failure-rate cases' policy: the rule enforced, the other login rules off. */
const FAILURE_RATE_POLICY: SecurityPolicy = {
  service: "auth",
  presets: {
    "login.account": false,
    "login.ip": false,
    "login.ip-failures": false,
    "login.ip-failures-ban": false,
    "per-ip": false,
    "login.failure-rate": "enforce",
  },
  profiles: {
    login: {
      distinctUsernames: false,
      distinctAddresses: false,
      failureRate: { minFailures: 30 },
    },
  },
};

/**
 * The global failure-rate rule across processes on one store (T2's
 * finding): a spray from a fresh address per attempt, 45 failures dealt
 * round-robin to three processes. Each saw 15, under the rule's 30; only
 * their shared count trips it, and then every process refuses the next new
 * device. The control: three processes each on a store of their own see 15
 * each, and refuse nothing.
 */
async function failureRateCases(
  config: (policy: SecurityPolicy, prefix: string) => Record<string, unknown>,
  prefix: string,
): Promise<void> {
  const run = async (prefixes: readonly string[]) => {
    const list = await Promise.all(
      prefixes.map((own) =>
        point({ ...config(FAILURE_RATE_POLICY, own), secret: SECRET }),
      ),
    );
    try {
      for (let i = 0; i < 45; i++) {
        await list[i % 3]?.ask({
          op: "login",
          username: `sprayed${i}@victims.test`,
          client: `5.1.${Math.floor(i / 200)}.${(i % 200) + 1}`,
          outcome: "failure",
        });
      }
      for (const p of list) await p.ask({ op: "flush" });
      return await Promise.all(
        list.map(
          async (p, at) =>
            (
              await p.ask({
                op: "login",
                username: `next${at}@victims.test`,
                client: `5.2.0.${at + 1}`,
                outcome: "none",
              })
            ).action as string,
        ),
      );
    } finally {
      for (const p of list) await p.close();
    }
  };
  expect(await run([prefix, prefix, prefix])).toEqual([
    "block",
    "block",
    "block",
  ]);
  expect(await run([`${prefix}1`, `${prefix}2`, `${prefix}3`])).toEqual([
    "allow",
    "allow",
    "allow",
  ]);
}

const sqliteDir = mkdtempSync(join(tmpdir(), "bun-security-mp-"));
afterAll(() => {
  rmSync(sqliteDir, { recursive: true, force: true });
});

describe("multi-process, one SQLite file (polled)", () => {
  const config = (policy: SecurityPolicy) => ({
    backend: "sqlite",
    path: join(sqliteDir, "state.sqlite"),
    prefix: `${PREFIX}_`,
    policy,
    store: storeOptions,
  });

  it("T-L11-1: credential stuffing and password spraying across processes on one store", async () => {
    await loginCases(
      (policy, prefix) => ({ ...config(policy), prefix }),
      `${PREFIX}_login_`,
    );
  }, 60_000);

  it("T-L11-1 driven by T2's simulators: stuffing and distributed guessing across processes", async () => {
    await attackCase(
      (policy, prefix) => ({ ...config(policy), prefix }),
      `${PREFIX}_attack_`,
    );
  }, 60_000);

  it("the global failure-rate rule: a spray from fresh addresses trips it on the processes' shared count", async () => {
    await failureRateCases(
      (policy, prefix) => ({ ...config(policy), prefix }),
      `${PREFIX}_fr_`,
    );
  }, 60_000);

  it("a ban written by one process is enforced by the others within the poll", async () => {
    const list = await points(3, config({}));
    try {
      await list[0]?.ask({ op: "ban", ip: "203.0.113.70" });
      const took = await propagation(list, "ip:203.0.113.70");
      // The poll is 250 ms; a generous bound for a loaded machine.
      expect(took).toBeLessThan(3_000);
      const refused = await list[2]?.ask({
        op: "evaluate",
        client: "203.0.113.70",
      });
      expect(refused?.action).toBe("ban");
    } finally {
      for (const p of list) await p.close();
    }
  }, 30_000);

  it("state.scope: per-service bans stay in their service, shared ones reach shared services only", async () => {
    await scopeCase(
      (policy) => ({ ...config(policy), prefix: `${PREFIX}_scope_` }),
      1_000,
    );
  }, 60_000);

  it("a shared limit is exact across the processes", async () => {
    const list = await points(
      3,
      config({ limits: [{ id: "per-ip", limit: 12, window: "1m" }] }),
    );
    try {
      const actions = await drive(list, 18, "198.51.100.70");
      expect(actions.filter((a) => a === "allow")).toHaveLength(12);
    } finally {
      for (const p of list) await p.close();
    }
  }, 30_000);
});

if (REDIS_URL === undefined) {
  describe.skip("multi-process, Redis: not configured (BUN_CACHE_TEST_REDIS_URL)", () => {
    it("skipped", () => {});
  });
} else {
  const redisUrl = REDIS_URL;
  describe("multi-process, Redis (its bus)", () => {
    afterAll(async () => {
      const client = new RedisClient(redisUrl);
      try {
        let cursor = "0";
        do {
          const [next, keys] = (await client.send("SCAN", [
            cursor,
            "MATCH",
            `${PREFIX}*`,
            "COUNT",
            "1000",
          ])) as [string, string[]];
          cursor = next;
          if (keys.length > 0) await client.send("DEL", keys);
        } while (cursor !== "0");
      } finally {
        client.close();
      }
    });

    const config = (
      policy: SecurityPolicy,
      url = redisUrl,
      prefix = PREFIX,
    ) => ({
      backend: "redis",
      url,
      prefix,
      policy,
      store: storeOptions,
    });

    it("is reachable", async () => {
      const client = new RedisClient(redisUrl, { connectionTimeout: 3_000 });
      try {
        await client.send("PING", []);
      } catch (error) {
        throw new Error(
          `Redis is set (BUN_CACHE_TEST_REDIS_URL) but unreachable: ${String(error)}`,
          { cause: error },
        );
      } finally {
        client.close();
      }
    });

    it("a ban written by one process is enforced by the others within 1 s, and its lift too", async () => {
      const list = await points(3, config({}, redisUrl, `${PREFIX}b`));
      try {
        await list[1]?.ask({ op: "ban", ip: "203.0.113.71" });
        const took = await propagation(list, "ip:203.0.113.71");
        expect(took).toBeLessThan(1_000);
        await list[2]?.ask({ op: "unban", ban: "ip:203.0.113.71" });
        const start = performance.now();
        for (;;) {
          const answers = await Promise.all(
            list.map((p) => p.ask({ op: "bans" })),
          );
          if (answers.every((a) => (a.bans as string[]).length === 0)) break;
          if (performance.now() - start > 5_000)
            throw new Error("lift not propagated");
          await Bun.sleep(10);
        }
        expect(performance.now() - start).toBeLessThan(1_000);
      } finally {
        for (const p of list) await p.close();
      }
    }, 30_000);

    it("state.scope: per-service bans stay in their service, shared ones reach shared services only", async () => {
      await scopeCase(
        (policy) => config(policy, redisUrl, `${PREFIX}s`),
        1_000,
      );
    }, 60_000);

    it("T-L11-1: credential stuffing and password spraying across processes on one store", async () => {
      await loginCases(
        (policy, prefix) => config(policy, redisUrl, prefix),
        `${PREFIX}g`,
      );
    }, 60_000);

    it("the global failure-rate rule: a spray from fresh addresses trips it on the processes' shared count", async () => {
      await failureRateCases(
        (policy, prefix) => config(policy, redisUrl, prefix),
        `${PREFIX}fr`,
      );
    }, 60_000);

    it("a hybrid limit holds within its bound, a shared one exactly, driven round-robin", async () => {
      const list = await points(
        3,
        config(
          {
            limits: [
              {
                id: "hybrid",
                limit: 30,
                window: "1m",
                state: "hybrid",
                routes: ["/h"],
              },
              { id: "shared", limit: 30, window: "1m", routes: ["/s"] },
            ],
          },
          redisUrl,
          `${PREFIX}l`,
        ),
      );
      try {
        // ~100 requests a second for ~1 s: rate × sync (0.1 s) × 3 processes = 30 over.
        const hybrid: string[] = [];
        const start = performance.now();
        for (let i = 0; i < 90; i++) {
          const p = list[i % 3];
          const answer = await p?.ask({
            op: "evaluate",
            client: "198.51.100.71",
            path: "/h",
          });
          hybrid.push(answer?.action as string);
          const due = start + (i + 1) * 10;
          const wait = due - performance.now();
          if (wait > 0) await Bun.sleep(wait);
        }
        const allowed = hybrid.filter((a) => a === "allow").length;
        expect(allowed).toBeGreaterThanOrEqual(30);
        expect(allowed).toBeLessThanOrEqual(60);
        const shared = await drive(list, 45, "198.51.100.71", "/s");
        expect(shared.filter((a) => a === "allow")).toHaveLength(30);
      } finally {
        for (const p of list) await p.close();
      }
    }, 30_000);

    it("when the store stops, each process counts at its local share, and returns to the shared count", async () => {
      const target = new URL(redisUrl);
      const forward = proxy(target.hostname, Number(target.port || 6379));
      const port = await forward.start();
      const proxied = new URL(redisUrl);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(port);
      const list = await points(
        3,
        config(
          {
            state: { nodes: 3 },
            limits: [{ id: "per-ip", limit: 9, window: "1m" }],
          },
          proxied.toString(),
          `${PREFIX}d`,
        ),
      );
      try {
        // Shared: 9 in all.
        const shared = await drive(list, 12, "198.51.100.72");
        expect(shared.filter((a) => a === "allow")).toHaveLength(9);
        forward.stop();
        // Down: each process at 9 ÷ 3 = 3.
        const down = await drive(list, 15, "198.51.100.73");
        expect(down.filter((a) => a === "allow")).toHaveLength(9);
        for (const p of list) {
          const status = (await p.ask({ op: "status" })).store as {
            healthy: boolean;
          };
          expect(status.healthy).toBe(false);
        }
        await forward.start();
        // After the circuit's cooldown, a probe succeeds and the count is shared again.
        await Bun.sleep(1_500);
        const deadline = performance.now() + 10_000;
        let back: string[] = [];
        while (performance.now() < deadline) {
          back = await drive(list, 3, "198.51.100.74");
          const statuses = await Promise.all(
            list.map((p) => p.ask({ op: "status" })),
          );
          if (statuses.every((s) => (s.store as { healthy: boolean }).healthy))
            break;
          await Bun.sleep(200);
        }
        const again = await drive(list, 12, "198.51.100.75");
        expect(again.filter((a) => a === "allow")).toHaveLength(9);
        expect(back.length).toBe(3);
      } finally {
        for (const p of list) await p.close();
        forward.stop();
      }
    }, 60_000);
  });
}

if (POSTGRES_URL === undefined) {
  describe.skip("multi-process, Postgres: not configured (BUN_CACHE_TEST_POSTGRES_URL)", () => {
    it("skipped", () => {});
  });
} else {
  const postgresUrl = POSTGRES_URL;
  const prefix = `${PREFIX}_pg_`;
  describe("multi-process, Postgres (its bus)", () => {
    /** Every table prefix this block used, dropped after it. */
    const used = new Set<string>([prefix]);
    afterAll(async () => {
      const sql = new SQL(postgresUrl);
      try {
        for (const own of used) {
          for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
            await sql.unsafe(`DROP TABLE IF EXISTS ${own}${table}`);
          }
        }
      } finally {
        await sql.close();
      }
    });

    const config = (
      policy: SecurityPolicy,
      url = postgresUrl,
      own = prefix,
    ) => {
      used.add(own);
      return {
        backend: "postgres",
        url,
        prefix: own,
        policy,
        store: storeOptions,
      };
    };

    it("is reachable", async () => {
      const sql = new SQL({ url: postgresUrl, connectionTimeout: 5 });
      try {
        expect(
          Number(
            ((await sql.unsafe("SELECT 1 AS one")) as { one: number }[])[0]
              ?.one,
          ),
        ).toBe(1);
      } finally {
        await sql.close();
      }
    });

    it("T-L11-1: credential stuffing and password spraying across processes on one store", async () => {
      await loginCases(
        (policy, own) => config(policy, postgresUrl, own),
        `${prefix}l`,
      );
      for (const n of ["", "1", "2", "3"]) used.add(`${prefix}l${n}`);
    }, 60_000);

    it("T-L11-1 driven by T2's simulators: stuffing and distributed guessing across processes", async () => {
      await attackCase(
        (policy, own) => config(policy, postgresUrl, own),
        `${prefix}k`,
      );
      for (const n of ["", "1", "2", "3"]) used.add(`${prefix}k${n}`);
    }, 60_000);

    it("a shared limit is exact across the processes, a hybrid one within its bound", async () => {
      const list = await points(
        3,
        config(
          {
            limits: [
              {
                id: "hybrid",
                limit: 30,
                window: "1m",
                state: "hybrid",
                routes: ["/h"],
              },
              { id: "shared", limit: 30, window: "1m", routes: ["/s"] },
            ],
          },
          postgresUrl,
          `${prefix}m`,
        ),
      );
      try {
        const shared = await drive(list, 45, "198.51.100.81", "/s");
        expect(shared.filter((a) => a === "allow")).toHaveLength(30);
        // The hybrid bound (topologies.md §3.2): overshoot at most about rate × syncMs × nodes,
        // the rate measured as the processes answered (syncInterval 100 ms here, 3 processes).
        const started = performance.now();
        const hybrid = await drive(list, 90, "198.51.100.82", "/h");
        const seconds = (performance.now() - started) / 1000;
        const allowed = hybrid.filter((a) => a === "allow").length;
        const bound = 30 + Math.ceil((90 / seconds) * 0.1 * 3);
        expect(allowed).toBeGreaterThanOrEqual(30);
        expect(allowed).toBeLessThanOrEqual(bound);
        // Negative control: the shared limit, on the same traffic, has no overshoot at all.
        expect(shared.filter((a) => a === "allow").length).toBeLessThan(
          allowed + 1,
        );
      } finally {
        for (const p of list) await p.close();
      }
    }, 60_000);

    it("when the store stops, each process counts at its local share, and returns to the shared count", async () => {
      const target = new URL(postgresUrl);
      const forward = proxy(target.hostname, Number(target.port || 5432));
      const port = await forward.start();
      const proxied = new URL(postgresUrl);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(port);
      const list = await points(
        3,
        config(
          {
            state: { nodes: 3 },
            limits: [{ id: "per-ip", limit: 9, window: "1m" }],
          },
          proxied.toString(),
          `${prefix}d`,
        ),
      );
      try {
        const shared = await drive(list, 12, "198.51.100.83");
        expect(shared.filter((a) => a === "allow")).toHaveLength(9);
        forward.stop();
        // Down: each process at 9 ÷ 3 = 3.
        const down = await drive(list, 15, "198.51.100.84");
        expect(down.filter((a) => a === "allow")).toHaveLength(9);
        const healthy = async () =>
          (await Promise.all(list.map((p) => p.ask({ op: "status" })))).map(
            (status) => (status.store as { healthy: boolean }).healthy,
          );
        expect(await healthy()).toEqual([false, false, false]);
        await forward.start();
        // Back once each circuit's probe succeeds: a condition, with a deadline.
        const deadline = performance.now() + 15_000;
        for (;;) {
          await drive(list, 3, "198.51.100.85");
          if ((await healthy()).every(Boolean)) break;
          if (performance.now() > deadline)
            throw new Error("the store did not come back");
          await Bun.sleep(100);
        }
        const again = await drive(list, 12, "198.51.100.86");
        expect(again.filter((a) => a === "allow")).toHaveLength(9);
      } finally {
        for (const p of list) await p.close();
        forward.stop();
      }
    }, 60_000);

    it("a ban reaches the other processes, and state.scope keeps per-service bans in their service", async () => {
      await scopeCase(config, 1_000);
    }, 60_000);
  });
}
