import type { JobsDriver, BunQueue as Queue } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { encodeName, MAX_ENCODED_NAME } from "../lib/drivers/file-names";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  DriverError,
  MAX_JOB_ID_LENGTH,
  MAX_REPEAT_KEY_LENGTH,
  MemoryDriver,
  RESERVED_STATE_PREFIX,
  shortenJobId,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `assertJobId`: what a caller may name a job.
 *
 * The rule is a denylist — it refuses what actually breaks a backend and
 * allows everything else — and it is applied in `BunQueue` before any driver
 * sees the id, so every backend enforces exactly the same thing. That is the
 * point: an id MySQL truncated (merging two jobs into one, after which neither
 * id resolved) must be refused everywhere, not only where it happened to break.
 */

const cleanups: (() => Promise<void>)[] = [];
const servers = await crossProcessBackends({ cleanups });

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/**
 * What one test opened, released as soon as it ends, newest first. Held until
 * `afterAll` instead, every test's drivers kept their connection pools open at
 * once, and the Postgres suite ran out of server connections part-way through.
 */
const perTest: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (perTest.length > 0) {
    await perTest.pop()!();
  }
});

const backends: {
  name: string;
  available: boolean;
  make: () => JobsDriver;
}[] = [
  { name: "memory", available: true, make: () => new MemoryDriver() },
  ...servers.map((server) => ({
    name: server.name,
    available: server.available,
    make: () => createDriver(server.config),
  })),
];

/** A control character, written this way so the source holds no literal one. */
const control = (code: number): string => `a${String.fromCharCode(code)}b`;

/** Every class of id that is refused, with the phrase that must name it. */
const REJECTED: { label: string; id: string; match: RegExp }[] = [
  { label: "empty", id: "", match: /non-empty/ },
  {
    label: "over the length cap",
    id: "a".repeat(MAX_JOB_ID_LENGTH + 1),
    match: /192 characters long; the most is 191/,
  },
  { label: "NUL", id: control(0x00), match: /control characters.*U\+0000/ },
  { label: "a C0 control", id: control(0x07), match: /U\+0007/ },
  { label: "a C1 control", id: control(0x85), match: /U\+0085/ },
  { label: "a leading dot", id: ".hidden", match: /may not begin with "\."/ },
  {
    // Not well-formed UTF-16: a high surrogate with no low one after it. It
    // has no UTF-8 spelling, so backends replace it (and collide) or refuse.
    label: "a lone surrogate",
    id: `a${String.fromCharCode(0xd800)}b`,
    match: /lone surrogate/,
  },
];

/**
 * Ids that must keep working. Several are shapes this package generates
 * itself, so refusing them would be refusing our own ids.
 */
const ACCEPTED = [
  "plain-id",
  // Slashes are allowed on purpose: the management API supports tenant-scoped
  // ids like this and URL-encodes them, and the file driver escapes every
  // character anyway, so a slash was never a path hazard.
  "tenant/7",
  "a\\b",
  "debounce:doc-7:01a0a766-ef3a-7291",
  "report|every:60000|",
  "0 9 * * 1-5@Europe-London",
  "with,commas and spaces",
  "unicode-é-🙂",
  "a".repeat(MAX_JOB_ID_LENGTH),
];

/** Every job in the queue, in any state. */
async function total(queue: Queue<{ v: number }>): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`job ids: ${backend.name}`, () => {
    /** A queue on this backend, torn down afterwards. */
    function setup(): Queue<{ v: number }> {
      const driver = backend.make();
      const namespace = testNamespace("jobid");
      const queue = new BunQueue<{ v: number }>("orders", {
        namespace,
        driver,
        logger: noopLogger,
      });

      perTest.push(async () => {
        await queue.close().catch(() => undefined);
        // Exactly the namespace this test made, never a prefix sweep.
        await driver.purge(namespace).catch(() => undefined);
        await driver.close().catch(() => undefined);
      });

      return queue;
    }

    it("refuses every bad id at add(), writing nothing", async () => {
      const queue = setup();

      for (const { label, id, match } of REJECTED) {
        const error: unknown = await queue
          .add("reindex", { v: 1 }, { jobId: id })
          .catch((thrown: unknown) => thrown);

        expect(error, label).toBeInstanceOf(ConfigError);
        expect((error as Error).message, label).toMatch(match);
      }

      // Refused before the driver, so nothing landed anywhere.
      expect(await total(queue)).toBe(0);
    });

    it("refuses every bad id on a flow child too", async () => {
      const queue = setup();

      for (const { label, id, match } of REJECTED) {
        const error: unknown = await queue
          .addFlow({
            name: "parent",
            data: { v: 1 },
            children: [{ name: "child", data: { v: 2 }, opts: { jobId: id } }],
          })
          .catch((thrown: unknown) => thrown);

        expect(error, label).toBeInstanceOf(ConfigError);
        expect((error as Error).message, label).toMatch(match);
      }

      expect(await total(queue)).toBe(0);
    });

    it("refuses a bad debounce or throttle window id", async () => {
      const queue = setup();

      for (const kind of ["debounce", "throttle"] as const) {
        for (const { label, id, match } of REJECTED) {
          const error: unknown = await queue
            .add("reindex", { v: 1 }, { [kind]: { id, ttl: 10_000 } })
            .catch((thrown: unknown) => thrown);

          expect(error, `${kind} ${label}`).toBeInstanceOf(ConfigError);
          // The empty case keeps its own, older message.
          expect((error as Error).message, `${kind} ${label}`).toMatch(
            id === "" ? /is required/ : match,
          );
        }
      }
    });

    it("accepts the shapes this package itself generates", async () => {
      const queue = setup();

      for (const id of ACCEPTED) {
        const job = await queue.add("reindex", { v: 1 }, { jobId: id });
        expect(job.id, id).toBe(id);

        // And it round-trips: an id that stored but could not be read back is
        // exactly the MySQL truncation this cap exists to prevent.
        expect((await queue.getJob(id))?.id, id).toBe(id);
      }
    });

    it("refuses every bad repeat key at add(), before anything is written", async () => {
      const queue = setup();
      const cases = [
        ...REJECTED,
        {
          // Legal as an id, one too long as a key: it is stored as `k:<key>`.
          label: "over the repeat-key cap",
          id: "a".repeat(MAX_REPEAT_KEY_LENGTH + 1),
          match: /190 characters long; the most is 189/,
        },
      ];

      for (const { label, id, match } of cases) {
        const error: unknown = await queue
          .add("reindex", { v: 1 }, { repeat: { every: 60_000, key: id } })
          .catch((thrown: unknown) => thrown);

        expect(error, label).toBeInstanceOf(ConfigError);
        expect((error as Error).message, label).toMatch(match);
      }

      // Neither a series nor a first occurrence was left behind.
      expect(await queue.listRepeatables()).toEqual([]);
      expect(await total(queue)).toBe(0);
    });

    it("checks every entry of addBulk before writing any", async () => {
      const queue = setup();
      // Good entries ahead of the bad one: a plain job, and a series, which
      // sends the batch down the one-at-a-time path.
      const good = [
        { name: "reindex", data: { v: 1 }, opts: { jobId: "first" } },
        {
          name: "reindex",
          data: { v: 2 },
          opts: { repeat: { every: 60_000, key: "fine" } },
        },
      ];
      const bad = [
        { label: "a bad jobId", opts: { jobId: ".hidden" }, match: /"\."/ },
        {
          label: "a bad repeat.key",
          opts: { repeat: { every: 60_000, key: ".hidden" } },
          match: /repeat\.key may not begin/,
        },
        {
          label: "a repeat.key over its cap",
          opts: {
            repeat: {
              every: 60_000,
              key: "a".repeat(MAX_REPEAT_KEY_LENGTH + 1),
            },
          },
          match: /the most is 189/,
        },
      ];

      for (const { label, opts, match } of bad) {
        for (const entries of [
          [...good, { name: "reindex", data: { v: 3 }, opts }],
          // Without the series too: the bulk insert path.
          [good[0]!, { name: "reindex", data: { v: 3 }, opts }],
        ]) {
          const error: unknown = await queue
            .addBulk(entries)
            .catch((thrown: unknown) => thrown);

          expect(error, label).toBeInstanceOf(ConfigError);
          expect((error as Error).message, label).toMatch(match);
        }
      }

      // Refused before the first entry was written, not at the bad one.
      expect(await queue.listRepeatables()).toEqual([]);
      expect(await total(queue)).toBe(0);
    });

    it("removes the series listed under the key it was given", async () => {
      const queue = setup();

      // `nightly` is stored as `k:nightly`, which is also exactly what the
      // second series is *listed* as. Removing by the listed key must reach
      // the series listed that way, not the one stored that way.
      await queue.add(
        "a",
        { v: 1 },
        { repeat: { every: 60_000, key: "nightly" } },
      );
      await queue.add(
        "b",
        { v: 2 },
        { repeat: { every: 60_000, key: "k:nightly" } },
      );
      const listed = async () =>
        (await queue.listRepeatables()).map((r) => r.key).sort();
      expect(await listed()).toEqual(["k:nightly", "nightly"]);

      expect(await queue.removeRepeatable("k:nightly")).toBe(true);
      expect(await listed()).toEqual(["nightly"]);
      expect(await queue.removeRepeatable("nightly")).toBe(true);
      expect(await listed()).toEqual([]);
    });

    it("keeps two longest repeat keys apart, and removes each", async () => {
      const queue = setup();
      // Uppercase, so the file driver's encoding (two bytes a letter) takes
      // them far past a file name, and at the cap, so `q:<queue>:repeat:k:<key>`
      // is far past MySQL's 191-character key — which used to truncate both to
      // one row. They differ only in the last character.
      const head = "R".repeat(MAX_REPEAT_KEY_LENGTH - 1);
      const keys = [`${head}A`, `${head}B`];

      for (const [index, key] of keys.entries()) {
        await queue.add("r", { v: index }, { repeat: { every: 60_000, key } });
      }

      const listed = (await queue.listRepeatables()).map((r) => r.key).sort();
      expect(listed).toEqual(keys);
      // Each series scheduled its own first occurrence.
      expect(await total(queue)).toBe(2);

      for (const key of keys) {
        expect(await queue.removeRepeatable(key), key).toBe(true);
      }
      expect(await queue.listRepeatables()).toEqual([]);
      expect(await total(queue)).toBe(0);
    });

    it("debounces long window ids, one window each", async () => {
      const queue = setup();
      // 186 characters overflowed MySQL's key once `q:<queue>:state:__win:debounce:`
      // was added; 150 uppercase letters overflowed the file driver's name.
      const ids = [
        `${"d".repeat(185)}1`,
        `${"d".repeat(185)}2`,
        "D".repeat(150),
      ];

      for (const id of ids) {
        const options = { debounce: { id, ttl: 60_000 } };
        const first = await queue.add("reindex", { v: 1 }, options);
        const second = await queue.add("reindex", { v: 2 }, options);

        expect(second.id, id).toBe(first.id);
        expect(second.wasAdded, id).toBe(false);
      }

      expect(await total(queue)).toBe(ids.length);
    });

    it("files a dead letter for a legal id near the file-name budget", async () => {
      const queue = setup();
      // 100 uppercase letters: 200 bytes as a file name, inside the 201 the
      // file driver allows. The dead letter's id is derived from it, and used
      // to be too long to store — losing the letter on the failure path.
      const id = "J".repeat(100);
      await queue.add("doomed", { v: 1 }, { jobId: id, deadLetter: "dlq" });

      const worker = new BunQueueWorker<{ v: number }, unknown>(
        "orders",
        async () => {
          throw new Error("no");
        },
        {
          namespace: queue.ref.ns,
          driver: queue.driver,
          logger: noopLogger,
          pollInterval: 20,
        },
      );
      void worker.run();

      const dlq = new BunQueue<{ v: number }>("dlq", {
        namespace: queue.ref.ns,
        driver: queue.driver,
        logger: noopLogger,
      });
      perTest.push(async () => {
        await worker.close().catch(() => undefined);
        await dlq.close().catch(() => undefined);
      });

      await waitFor(async () => (await total(dlq)) === 1, { timeout: 10_000 });

      const letters = await dlq.list(["waiting", "delayed"]);
      expect(letters).toHaveLength(1);
      expect(letters[0]!.id.length).toBeLessThanOrEqual(MAX_JOB_ID_LENGTH);
      expect(encodeName(letters[0]!.id).length).toBeLessThanOrEqual(
        MAX_ENCODED_NAME,
      );
    });

    it("refuses a reserved name however the write is dressed up", async () => {
      const queue = setup();
      const name = `${RESERVED_STATE_PREFIX}mine`;

      // The old bypass was a public flag; a symbol of the caller's own does
      // not pass either. Only the library's private token does.
      for (const options of [
        undefined,
        { internal: true } as unknown as { internal?: symbol },
        { internal: Symbol("bun-jobs: reserved queue-state write") },
      ]) {
        const error: unknown = await queue.driver.setQueueState!(
          queue.ref,
          name,
          {},
          null,
          options,
        ).catch((thrown: unknown) => thrown);

        expect(error, String(options?.internal)).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toMatch(/reserved by bun-jobs/);
      }

      expect(await queue.driver.getQueueState!(queue.ref, name)).toBeNull();
    });
  });
}

describe("derived ids are shortened, never refused", () => {
  it("keeps a derived id inside the cap, deterministically", () => {
    // The shape a dead letter derives: <queue>:<a job id at the cap>:<stamp>.
    const atCap = "a".repeat(MAX_JOB_ID_LENGTH);
    const derived = `orders:${atCap}:1789548510000`;
    const shortened = shortenJobId(derived);

    expect(derived.length).toBeGreaterThan(MAX_JOB_ID_LENGTH);
    expect(shortened.length).toBeLessThanOrEqual(MAX_JOB_ID_LENGTH);
    // Two workers deriving the same occurrence must reach the same id, or the
    // add stops being idempotent and the occurrence runs twice.
    expect(shortenJobId(derived)).toBe(shortened);
  });

  it("keeps ids apart that differ only after the truncation point", () => {
    const head = `orders:${"a".repeat(MAX_JOB_ID_LENGTH)}`;

    // Plain truncation would merge these two: they share everything but the
    // timestamp on the end. This is the MySQL failure, in miniature.
    expect(shortenJobId(`${head}:1`)).not.toBe(shortenJobId(`${head}:2`));
  });

  it("leaves an id that already fits completely alone", () => {
    expect(shortenJobId("orders:plain:1")).toBe("orders:plain:1");
  });
});

describe("the file driver's encoded-length guard", () => {
  it("refuses an id whose encoded name cannot fit, naming the sizes", async () => {
    const tmp = await makeTmpDir("names");
    const driver = createDriver({ type: "file", root: tmp.path });
    const namespace = testNamespace("names");
    const queue = new BunQueue<{ v: number }>("orders", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.push(async () => {
      await queue.close().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await tmp.cleanup();
    });

    // Legal by every shared rule — 120 characters, no denied character — but
    // each one encodes to nine bytes, so the file name would be ~1,080. The
    // character cap alone does not bound a file name.
    const id = "漢".repeat(120);
    expect(id.length).toBeLessThanOrEqual(MAX_JOB_ID_LENGTH);

    const error: unknown = await queue
      .add("reindex", { v: 1 }, { jobId: id })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DriverError);
    expect((error as Error).message).toMatch(
      /file driver failed during addJob/,
    );
    expect((error as { cause?: Error }).cause?.message).toMatch(
      /encodes to \d+ bytes as a file name, and the most is \d+ \(255 minus/,
    );

    // And an ordinary id of the same character length is still fine.
    const plain = "a".repeat(120);
    expect((await queue.add("reindex", { v: 1 }, { jobId: plain })).id).toBe(
      plain,
    );
  });

  it("refuses a caller's state name that cannot be a file name, before writing", async () => {
    const tmp = await makeTmpDir("state-names");
    const driver = createDriver({ type: "file", root: tmp.path });
    const q = { ns: testNamespace("state-names"), queue: "orders" };
    perTest.push(async () => {
      await driver.close().catch(() => undefined);
      await tmp.cleanup();
    });
    await driver.ensureQueue(q);

    const name = "漢".repeat(60);
    const error: unknown = await driver.setQueueState!(q, name, {}, null).catch(
      (thrown: unknown) => thrown,
    );

    // The sizes, from the driver — not a bare `ENAMETOOLONG` from the
    // filesystem, which is what used to escape.
    expect(error).toBeInstanceOf(DriverError);
    expect((error as { cause?: Error }).cause?.message).toMatch(
      /the name encodes to \d+ bytes as a file name, and the most is 201/,
    );
    expect(await driver.getQueueState!(q, name)).toBeNull();
    expect(await driver.listQueueState!(q, { prefix: "", limit: 10 })).toEqual(
      [],
    );
  });

  it("reports a failed atomic write as a DriverError, not the cleanup's error", async () => {
    const tmp = await makeTmpDir("atomic");
    const driver = createDriver({ type: "file", root: tmp.path });
    const q = { ns: testNamespace("atomic"), queue: "orders" };
    perTest.push(async () => {
      await driver.close().catch(() => undefined);
      await tmp.cleanup();
    });
    await driver.ensureQueue(q);

    // A worker id is a segment (up to 200 characters), and each uppercase
    // letter encodes to two bytes: past `NAME_MAX`, so the temp file is never
    // created. Removing it then failed too, and that error — a raw
    // `ENAMETOOLONG` — replaced the `DriverError` explaining the write.
    const now = Date.now();
    const error: unknown = await driver.registerWorker!(q, {
      id: "W".repeat(200),
      queue: q.queue,
      host: "h",
      pid: 1,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: now,
      heartbeatAt: now,
      expiresAt: now + 60_000,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DriverError);
    expect((error as Error).message).toMatch(/writeAtomic/);
  });
});

/** The servers whose id columns are `VARCHAR(191)`, when their URL is set. */
const boundedServers = [
  { name: "mysql", url: process.env.BUN_JOBS_TEST_MYSQL_URL },
  { name: "mariadb", url: process.env.BUN_JOBS_TEST_MARIADB_URL },
];

for (const server of boundedServers) {
  describe.skipIf(!server.url)(
    `${server.name} refuses an over-width name`,
    () => {
      /** A queue on this server, torn down afterwards. */
      function setup(namespace: string, queueName = "orders") {
        const driver = createDriver({ type: "sql", url: server.url! });
        const queue = new BunQueue<{ v: number }>(queueName, {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.push(async () => {
          await queue.close().catch(() => undefined);
          await driver.purge(namespace).catch(() => undefined);
          await driver.close().catch(() => undefined);
        });
        return queue;
      }

      it("refuses a namespace or queue name past 191 as configuration, never truncating", async () => {
        // 192–200 characters pass the shared segment check (its cap is 200) but
        // overflow VARCHAR(191), which MySQL used to truncate — merging rows.
        // No retry makes such a name fit, so it is a `ConfigError`.
        const cases = [
          {
            queue: setup(`n${"a".repeat(199)}`),
            match: /namespace ".*" is 200 characters/,
          },
          {
            queue: setup(testNamespace("wide"), `q${"b".repeat(194)}`),
            match: /queue name ".*" is 195 characters/,
          },
        ];

        for (const { queue, match } of cases) {
          const error: unknown = await queue
            .add("reindex", { v: 1 })
            .catch((thrown: unknown) => thrown);

          expect(error).toBeInstanceOf(ConfigError);
          expect((error as Error).message).toMatch(match);
          expect((error as Error).message).toMatch(
            /stores it in a column of 191/,
          );
        }
      });

      it("refuses a kv key past 191 rather than truncating it, and keeps long state names apart", async () => {
        const driver = createDriver({ type: "sql", url: server.url! });
        const namespace = testNamespace("kv");
        perTest.push(async () => {
          await driver.purge(namespace).catch(() => undefined);
          await driver.close().catch(() => undefined);
        });
        await driver.connect();

        // A runner's state lives under `<key>:state`: a 190-character key
        // (a legal segment) makes a 196-character kv key, which MySQL used to
        // cut to 191 — so two such runners shared one row.
        const runner = "r".repeat(190);
        const error: unknown = await driver
          .setState(namespace, runner, { a: 1 })
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toMatch(
          /kv key ".*" is 196 characters, and \w+ stores it in a column of 191/,
        );
        expect(await driver.listRunners(namespace)).toEqual([]);

        // A queue-state name is fitted into the key instead, so two that
        // differ only in their last character stay two entries.
        const q = { ns: namespace, queue: "orders" };
        await driver.ensureQueue(q);
        const head = "s".repeat(188);

        for (const [index, suffix] of ["A", "B"].entries()) {
          await driver.setQueueState!(q, `${head}${suffix}`, { index }, null);
        }

        expect((await driver.getQueueState!(q, `${head}A`))?.value).toEqual({
          index: 0,
        });
        expect((await driver.getQueueState!(q, `${head}B`))?.value).toEqual({
          index: 1,
        });
      });
    },
  );
}

describe("reserved queue-state names", () => {
  /** A memory-backed queue, torn down afterwards. */
  function setup(): Queue<{ v: number }> {
    const driver = new MemoryDriver();
    const namespace = testNamespace("reserved");
    const queue = new BunQueue<{ v: number }>("orders", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.push(async () => {
      await queue.close().catch(() => undefined);
      await driver.purge(namespace).catch(() => undefined);
      await driver.close().catch(() => undefined);
    });
    return queue;
  }

  it("leaves an application's own `debounce:`-named entry alone", async () => {
    const queue = setup();
    const mine = "debounce:my-own-setting";

    // The exact name the sweep used to believe it owned, and deleted.
    await queue.driver.setQueueState!(
      queue.ref,
      mine,
      { hello: "world" },
      null,
    );

    // A real window that *has* closed, so the sweep has work of its own.
    await queue.add("reindex", { v: 1 }, { throttle: { id: "gone", ttl: 1 } });
    await Bun.sleep(30);
    expect(await queue.cleanWindows()).toBe(1);

    expect((await queue.driver.getQueueState!(queue.ref, mine))?.value).toEqual(
      { hello: "world" },
    );
  });

  it("refuses a caller's write under the reserved prefix", async () => {
    const queue = setup();

    const error: unknown = await queue.driver.setQueueState!(
      queue.ref,
      `${RESERVED_STATE_PREFIX}mine`,
      {},
      null,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/reserved by bun-jobs/);
  });

  it("still debounces into one job", async () => {
    const queue = setup();
    const options = { debounce: { id: "doc", ttl: 10_000 } };

    const first = await queue.add("reindex", { v: 1 }, options);
    const second = await queue.add("reindex", { v: 2 }, options);

    expect(second.id).toBe(first.id);
    expect(second.wasAdded).toBe(false);
    expect(await total(queue)).toBe(1);
  });
});

describe("caller repeat keys are namespaced", () => {
  /** A memory-backed queue, torn down afterwards. */
  function setup(): Queue<{ v: number }> {
    const driver = new MemoryDriver();
    const namespace = testNamespace("repeatkey");
    const queue = new BunQueue<{ v: number }>("orders", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.push(async () => {
      await queue.close().catch(() => undefined);
      await driver.purge(namespace).catch(() => undefined);
      await driver.close().catch(() => undefined);
    });
    return queue;
  }

  it("cannot take over a generated series", async () => {
    const queue = setup();

    await queue.add("report", { v: 1 }, { repeat: { every: 60_000 } });
    const generated = (await queue.listRepeatables())[0]!.key;
    expect(generated).toBe("report|every:60000|");

    // The impersonation: exactly the generated key, supplied by a caller.
    await queue.add(
      "other",
      { v: 2 },
      { repeat: { every: 1_000, key: generated } },
    );

    const keys = (await queue.listRepeatables()).map((r) => r.key).sort();
    expect(keys).toHaveLength(2);
    expect(keys).toContain(generated);
    expect(keys).toContain(`k:${generated}`);
  });

  it("hides the prefix for an ordinary key, everywhere it would surface", async () => {
    const queue = setup();

    const job = await queue.add(
      "digest",
      { v: 1 },
      { repeat: { every: 60_000, key: "nightly" } },
    );

    // "nightly" contains no `|`, so it can never equal a generated key and the
    // prefix is hidden. Storage still namespaces it.
    expect(job.repeatKey).toBe("nightly");
    expect((await queue.listRepeatables())[0]!.key).toBe("nightly");
    // The occurrence id follows the displayed key, not the stored one.
    expect(job.id.startsWith("repeat:nightly:")).toBe(true);

    // The caller's own spelling still removes it.
    expect(await queue.removeRepeatable("nightly")).toBe(true);
    expect(await queue.listRepeatables()).toHaveLength(0);
  });

  it("keeps the prefix visible for a pipe-shaped key, which cannot be hidden", async () => {
    const queue = setup();

    await queue.add("digest", { v: 1 }, { repeat: { every: 60_000 } });
    const generated = (await queue.listRepeatables())[0]!.key;
    expect(generated).toBe("digest|every:60000|");

    // Hiding this one's prefix would make the two series display identically —
    // and derive the *same* occurrence id, silently merging two unrelated
    // series into one job. So it stays visible.
    const impostor = await queue.add(
      "other",
      { v: 2 },
      { repeat: { every: 60_000, key: generated } },
    );

    expect(impostor.repeatKey).toBe(`k:${generated}`);
    expect(impostor.id.startsWith(`repeat:k:${generated}:`)).toBe(true);
    expect(impostor.id).not.toBe(
      (await queue.getJob(`repeat:${generated}:${impostor.runAt}`))?.id,
    );
  });
});
