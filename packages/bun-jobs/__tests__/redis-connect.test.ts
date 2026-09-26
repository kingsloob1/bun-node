import type { QueueRef } from "../lib/index";
import type { TcpProxy } from "./helpers/tcpProxy";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { RedisClient as BunRedis } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  DriverError,
  RedisDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { closedPort, silentServer, startTcpProxy } from "./helpers/tcpProxy";

/**
 * How the Redis driver connects: fast when the server is not there, and
 * patient once it has been.
 *
 * Bun's `RedisClient` retries a refused connect 20 times, backing off from
 * 50 ms to a 2 s cap — 31.2 s measured — before its first `connect()`
 * rejects. The driver used to take that policy unchosen, so a worker pointed
 * at a Redis that was down took half a minute to say so; these check it now
 * says so in about `firstConnectTimeout` (1 s), without giving up the retrying
 * that carries a running driver through a Redis restart.
 *
 * The outage tests never touch the shared server: a TCP proxy stands between
 * the driver and Redis, and it is the proxy that goes away and comes back.
 */

const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Closers, run after each test in reverse order. */
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve()
      .then(cleanup)
      .catch(() => undefined);
  }
});

/** A driver, closed after the test. */
function driverFor(options: ConstructorParameters<typeof RedisDriver>[0]) {
  const driver = new RedisDriver(options);
  cleanups.push(async () => await driver.close());
  return driver;
}

/** A URL on a local port nothing listens on. */
function refusedUrl(): string {
  return `redis://127.0.0.1:${closedPort()}`;
}

/** How long `work` takes to reject, and what it rejected with. */
async function rejection(
  work: Promise<unknown>,
): Promise<{ ms: number; error: unknown }> {
  const started = performance.now();
  try {
    await work;
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
  throw new Error("expected a rejection, and the work resolved");
}

/** Asserts `error` is the driver's connect failure, naming the endpoint. */
function expectConnectError(error: unknown, endpoint: string): void {
  expect(error).toBeInstanceOf(DriverError);
  const driverError = error as DriverError;
  expect(driverError.driver).toBe("redis");
  expect(driverError.operation).toBe("connect");
  expect(driverError.message).toBe("redis driver failed during connect");
  expect(String((driverError.cause as Error).message)).toContain(
    `no connection to ${endpoint}`,
  );
}

describe("redis connect: an unreachable server fails fast", () => {
  it("connect() rejects in about a second on a refused port, not ~31s", async () => {
    const port = closedPort();
    const driver = driverFor({ url: `redis://127.0.0.1:${port}` });

    const { ms, error } = await rejection(driver.connect());

    expectConnectError(error, `127.0.0.1:${port}`);
    // Bounded by firstConnectTimeout, and Bun retries the refusal inside it
    // rather than failing on the first one: a Redis a moment late still wins.
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(3_000);
  });

  it("the first operation, without connect(), fails as fast", async () => {
    const driver = driverFor({ url: refusedUrl() });
    const { ms, error } = await rejection(driver.listQueues("ns"));
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeLessThan(3_000);
  });

  it("a connection attempt that hangs is bounded too, not just a refusal", async () => {
    const silent = silentServer();
    cleanups.push(silent.stop);
    const driver = driverFor({ url: `redis://127.0.0.1:${silent.port}` });

    const { ms, error } = await rejection(driver.connect());
    expectConnectError(error, `127.0.0.1:${silent.port}`);
    // Bun's own connectionTimeout is 10s; the first-connect bound wins.
    expect(ms).toBeLessThan(3_000);
  });

  it("BunQueueWorker.run() rejects within the bound, and can run again", async () => {
    const driver = driverFor({ url: refusedUrl() });
    const worker = new BunQueueWorker("q", async () => null, {
      driver,
      namespace: testNamespace("ff"),
      logger: noopLogger,
    });
    cleanups.push(async () => await worker.close({ force: true }));

    const first = await rejection(worker.run());
    expect(first.error).toBeInstanceOf(DriverError);
    expect(first.ms).toBeLessThan(3_000);

    // A failed first connect leaves nothing stuck: the next try is bounded too.
    const second = await rejection(worker.run());
    expect(second.error).toBeInstanceOf(DriverError);
    expect(second.ms).toBeLessThan(3_000);
  });

  it("BunQueue.add() rejects within the bound", async () => {
    const driver = driverFor({ url: refusedUrl() });
    const queue = new BunQueue("q", {
      driver,
      namespace: testNamespace("ff"),
      logger: noopLogger,
    });
    cleanups.push(async () => await queue.close());

    const { ms, error } = await rejection(queue.add("x", {}));
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeLessThan(3_000);
  });

  it("ping() answers false within the bound", async () => {
    const driver = driverFor({ url: refusedUrl() });
    const started = performance.now();
    expect(await driver.ping()).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("redis connect: the options reach the client", () => {
  it("firstConnectTimeout sets the bound", async () => {
    const driver = driverFor({ url: refusedUrl(), firstConnectTimeout: 2_000 });
    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThan(4_000);
  });

  it("maxRetries is passed to Bun: 0 fails at the first refusal", async () => {
    const driver = driverFor({ url: refusedUrl(), maxRetries: 0 });
    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    // Well inside the 1s bound: Bun gave up itself, not the driver.
    expect(ms).toBeLessThan(500);
  });

  it("maxRetries sets Bun's budget once the bound is lifted", async () => {
    // firstConnectTimeout 0 leaves the first connect to Bun's policy, so what
    // is measured is the retry budget: 50 + 100 + 200 ms of backoff for three.
    const driver = driverFor({
      url: refusedUrl(),
      firstConnectTimeout: 0,
      maxRetries: 3,
    });
    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(2_000);
  });

  it("connectionTimeout is passed to Bun, and a timed-out attempt is not retried", async () => {
    const silent = silentServer();
    cleanups.push(silent.stop);
    const driver = driverFor({
      url: `redis://127.0.0.1:${silent.port}`,
      firstConnectTimeout: 0,
      connectionTimeout: 300,
    });

    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    // Bun's default is 10s. And one attempt only, despite 20 retries allowed.
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1_500);
  });

  it("the options survive a DriverConfig, which is what a spawned runner gets", async () => {
    const config = JSON.parse(
      JSON.stringify({
        type: "redis",
        url: refusedUrl(),
        firstConnectTimeout: 0,
        maxRetries: 0,
        connectionTimeout: 300,
        autoReconnect: false,
      }),
    ) as Parameters<typeof createDriver>[0];
    const driver = createDriver(config);
    cleanups.push(async () => await driver.close());

    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeLessThan(500);
  });

  it("rejects a firstConnectTimeout that is not a number of ms", () => {
    for (const bad of [-1, Number.NaN]) {
      expect(
        () => new RedisDriver({ url: refusedUrl(), firstConnectTimeout: bad }),
      ).toThrow(ConfigError);
    }
  });

  it("a supplied client keeps its own policy: no bound, no close", async () => {
    // Its own budget is three retries (~350ms). The driver's options would say
    // 100ms and no retries; neither is applied to a client that is not its own.
    const client = new BunRedis(refusedUrl(), { maxRetries: 3 });
    cleanups.push(() => client.close());
    const handlers = [client.onconnect, client.onclose];
    const driver = driverFor({
      url: refusedUrl(),
      client,
      firstConnectTimeout: 100,
      maxRetries: 0,
    });

    const { ms, error } = await rejection(driver.connect());
    expect(error).toBeInstanceOf(DriverError);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect([client.onconnect, client.onclose]).toEqual(handlers);
  });
});

/** The test server's host, port and database, for a proxy in front of it. */
function upstream(): { host: string; port: number; db: string } {
  const parsed = new globalThis.URL(URL!);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    db: parsed.pathname.replace(/^\//, "") || "0",
  };
}

/** A proxy in front of the test server, stopped after the test. */
function proxied(): { proxy: TcpProxy; url: string } {
  const { host, port, db } = upstream();
  const proxy = startTcpProxy(host, port);
  cleanups.push(proxy.stop);
  return { proxy, url: `redis://127.0.0.1:${proxy.port}/${db}` };
}

describe.skipIf(!URL)("redis connect: a drop after connecting recovers", () => {
  /**
   * A worker and a producer on one driver behind the proxy, plus a direct
   * driver that adds jobs whatever the proxy is doing.
   */
  async function pipeline(options: { maxRetries?: number } = {}) {
    const { proxy, url } = proxied();
    const namespace = testNamespace("ffr");
    const driver = driverFor({ url, ...options });
    const direct = driverFor({ url: URL! });
    cleanups.push(async () => await direct.purge(namespace));

    const processed: string[] = [];
    const worker = new BunQueueWorker<{ n: number }>(
      "flow",
      async (job) => {
        processed.push(job.name);
        return null;
      },
      {
        driver,
        namespace,
        logger: noopLogger,
        publish: true,
        pollInterval: 20,
        maxBlock: 200,
      },
    );
    // A cut surfaces as loop errors while it lasts; they are expected here.
    worker.on("error", () => {});
    cleanups.push(async () => await worker.close({ force: true }));

    const producer = new BunQueue("flow", {
      driver: direct,
      namespace,
      logger: noopLogger,
    });
    cleanups.push(async () => await producer.close());

    // Listens through the proxied driver, so its pub/sub connection is cut too.
    const listener = new BunQueue("flow", {
      driver,
      namespace,
      logger: noopLogger,
      subscribe: true,
    });
    cleanups.push(async () => await listener.close());
    const completed: string[] = [];
    listener.on("completed", (job) => completed.push(job.name));
    // Subscribes now, before anything is added, rather than on first use.
    await listener.connect();

    // The same events heard over a connection the proxy never touches, so a
    // failure says which side lost them: the worker's publish, or the
    // proxied subscription.
    const control = new BunQueue("flow", {
      driver: direct,
      namespace,
      logger: noopLogger,
      subscribe: true,
    });
    cleanups.push(async () => await control.close());
    const heardDirectly: string[] = [];
    control.on("completed", (job) => heardDirectly.push(job.name));
    await control.connect();

    void worker.run().catch(() => {});
    return { proxy, driver, processed, completed, heardDirectly, producer };
  }

  it("jobs and events flow again after a short outage (Bun reconnects)", async () => {
    const { proxy, processed, completed, producer } = await pipeline();

    await producer.add("before", { n: 1 });
    await waitFor(
      () => processed.includes("before") && completed.includes("before"),
      { timeout: 5_000, message: () => `before: ${processed} / ${completed}` },
    );

    const accepted = proxy.accepted;
    proxy.cut();
    await producer.add("during", { n: 2 });
    await Bun.sleep(1_500);
    expect(processed).not.toContain("during");
    proxy.restore();

    await producer.add("after", { n: 3 });
    await waitFor(
      () => processed.includes("during") && processed.includes("after"),
      { timeout: 10_000, message: () => `processed: ${processed}` },
    );
    // Events too: Bun reconnects the pub/sub connection but does not
    // resubscribe it; the driver does, so the producer still hears them.
    await waitFor(() => completed.includes("after"), {
      timeout: 5_000,
      message: () => `completed: ${completed}`,
    });
    expect(completed.filter((name) => name === "after")).toHaveLength(1);
    // The recovery went through the proxy again: new connections were made.
    expect(proxy.accepted).toBeGreaterThan(accepted);
  }, 30_000);

  it("an outage longer than the retry budget still recovers once Redis is back", async () => {
    // Two retries is ~150ms of backoff, so a 1.5s cut outlasts it and Bun
    // gives up on every connection. Before, that left the command connection
    // dead for good; now the next operation starts a fresh round.
    const { proxy, processed, completed, heardDirectly, producer } =
      await pipeline({ maxRetries: 2 });

    await producer.add("before", { n: 1 });
    await waitFor(() => completed.includes("before"), { timeout: 5_000 });

    proxy.cut();
    await Bun.sleep(1_500);
    proxy.restore();

    await producer.add("after", { n: 2 });
    await waitFor(() => processed.includes("after"), {
      timeout: 10_000,
      message: () => `processed: ${processed}`,
    });
    await waitFor(() => completed.includes("after"), {
      timeout: 5_000,
      message: () =>
        `completed: ${completed}; heard directly: ${heardDirectly}`,
    });
  }, 30_000);

  it("an operation during an outage waits for the reconnect, not the first-connect bound", async () => {
    const { proxy, url } = proxied();
    const driver = driverFor({ url });
    const ns = testNamespace("ffw");
    cleanups.push(async () => await driver.purge(ns));
    await driver.connect();

    proxy.cut();
    // Once the client has seen the drop: a command already on the wire when
    // the connection goes is rejected by Bun, not retried, which is a
    // different case (the worker loop's retry covers it).
    // The proxy terminates the socket locally, so the close lands in
    // microseconds; 200ms is a wide margin, not a guess at a server.
    await Bun.sleep(200);
    const listing = driver.listQueues(ns).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await Bun.sleep(1_500);
    proxy.restore();

    // Past the 1s bound, and it still succeeds: a connection that has
    // connected is retried under the policy, not failed fast.
    expect(await listing).toEqual({ value: [] });
  }, 15_000);
});

describe.skipIf(!URL)(
  "redis connect: the extra connections are bounded too",
  () => {
    /**
     * A supplied client connected through the proxy, then cut. The driver never
     * reconnects a supplied client itself, so what fails here is the extra
     * connection it duplicates from it — which is the driver's own.
     */
    async function cutClient() {
      const { proxy, url } = proxied();
      const client = new BunRedis(url);
      cleanups.push(() => client.close());
      await client.connect();
      const driver = driverFor({ url, client });
      await driver.connect();
      proxy.cut();
      await Bun.sleep(50);
      return driver;
    }

    it("the blocking connection: a wait fails in about a second, not after the retries", async () => {
      const driver = await cutClient();
      const q: QueueRef = { ns: testNamespace("ffb"), queue: "q" };

      // Before, the duplicate came back unconnected and its connect retried for
      // ~31s behind a wait that returned as if nothing were wrong.
      const { ms, error } = await rejection(driver.waitForJob(q, 10_000));
      expect(error).toBeInstanceOf(DriverError);
      expect(ms).toBeLessThan(3_000);
    }, 15_000);

    it("the pub/sub connection: a subscription fails in about a second", async () => {
      const driver = await cutClient();

      const { ms, error } = await rejection(
        driver.subscribe(testNamespace("ffs"), "queue", "q", () => {}),
      );
      expect(error).toBeInstanceOf(DriverError);
      expect(ms).toBeLessThan(3_000);
    }, 15_000);
  },
);
