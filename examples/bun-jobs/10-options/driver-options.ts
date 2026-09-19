/**
 * Option tour: the drivers — every option of every backend, and the helpers
 * they are built from.
 *
 * ```bash
 * bun 10-options/driver-options.ts
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs \
 * EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 * EXAMPLE_MONGODB_URL=mongodb://localhost/jobs \
 *   bun 10-options/driver-options.ts
 * ```
 *
 * Not driven by `EXAMPLE_DRIVER`: it always covers memory, file and SQLite,
 * and each server backend whose URL variable is set — a section whose URL is
 * missing prints a note and is skipped.
 *
 * Covered:
 *
 * - the connection helpers: `toConnectionUrl` (every `ConnectionOptions`
 *   field), `resolveConnectionUrl`, `databaseFromUrl`, `resolveNames`,
 *   `detectAdapter`, `dialectFor`, `SQL_TABLES`, `MONGO_COLLECTIONS`,
 *   `RedisKeys`;
 * - the contract every driver shares: `capabilities`, `ping`, `listQueues`,
 *   `listRunners`, `purge` (one namespace, and nothing outside it);
 * - `FileDriverOptions`: `root`, `pollInterval`, `eventRetentionMs`;
 * - `SqlDriverOptions`: `url`, `connection`, `adapter`, `notify`,
 *   `syncSchema` (a boolean and options), `tablePrefix`, `tables`, `sql`,
 *   `pollInterval`, `eventRetentionMs` — and `cleanEvents`;
 * - `RedisDriverOptions`: `url`, `connection`, `keyPrefix`, `cluster`,
 *   `client`, `maxBlockSeconds`;
 * - `MongoDriverOptions`: `url`, `connection`, `database`,
 *   `collectionPrefix`, `collections`, `clientOptions`, `client`,
 *   `pollInterval`, `syncSchema`, `eventRetentionMs`;
 * - `createDriver` with every `DriverConfig` shape, and `resolveDriver`'s
 *   ownership flag: a driver built from a config is closed by whoever built
 *   it; an instance handed in never is;
 * - the JSON-safe tuning options a config carries, each checked *after a trip
 *   through JSON* (what a spawned runner receives): `pollInterval` and
 *   `eventRetentionMs` for file, SQL and MongoDB, `maxBlockSeconds` for Redis,
 *   `clientOptions` for MongoDB;
 * - `capabilities.multiHost` is `false` for SQLite — a file, shareable by the
 *   processes of one host only — and `true` for every server engine;
 * - reading an unknown runner (`getLock`, `getState`, `listHistory`, queued
 *   triggers, `peekQueuedTrigger`) registers nothing, on every driver;
 * - `peekQueuedTrigger` returns the head a pop would take next — `force`
 *   included — without removing it, and `null` once the queue is empty;
 * - Redis: a wake token taken by an abandoned wait reaches the next wait.
 *
 * Every table and collection this creates starts with `bun_jobs_example_`,
 * and every Redis key with `examples:`. They are left in place (empty) so a
 * rerun reuses them.
 */
import type {
  DriverCapabilities,
  DriverConfig,
  DriverEvent,
  JobsDriver,
  SqlDriverOptions,
} from "@kingsleyweb/bun-jobs";
import { join } from "node:path";
import process from "node:process";
import {
  BunJobs,
  BunQueue,
  createDriver,
  databaseFromUrl,
  detectAdapter,
  dialectFor,
  FileDriver,
  MemoryDriver,
  MONGO_COLLECTIONS,
  MongoDriver,
  newId,
  newToken,
  RedisDriver,
  RedisKeys,
  resolveConnectionUrl,
  resolveDriver,
  resolveNames,
  runnerEvent,
  runnerKey,
  SQL_TABLES,
  SqlDriver,
  toConnectionUrl,
} from "@kingsleyweb/bun-jobs";
import { RedisClient, SQL } from "bun";
import { Database } from "bun:sqlite";
import { MongoClient } from "mongodb";
import { EXAMPLE_PREFIX, tempDir, URL_VARIABLES } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: driver options");

/** Generous, because other suites may share this machine. */
const WAIT = { timeout: 30_000, interval: 10 };

/** A run-unique suffix, so a persistent backend never sees an earlier run. */
const RUN = Date.now().toString(36);

/** Tables and collections this tour creates on a server: its own prefix. */
const SERVER_PREFIX = `${EXAMPLE_PREFIX}opts_`;

/** How many stored events one backend holds for one runner. */
type StoredEvents = (ns: string, target: string) => Promise<number>;

/** A namespace for one check on one backend. */
function ns(label: string, what: string): string {
  return `opts-${label}-${what}-${RUN}`;
}

/**
 * A config after a trip through JSON — what a spawned runner actually
 * receives. Anything a config carries has to survive this.
 */
function viaJson<T extends DriverConfig>(config: T): T {
  return JSON.parse(JSON.stringify(config)) as T;
}

/** Publishes one runner event, the smallest thing a driver stores. */
async function publishOne(
  driver: JobsDriver,
  namespace: string,
  target: string,
): Promise<void> {
  await driver.publish(
    runnerEvent(
      { ns: namespace, target, type: "started", origin: newToken() },
      { runId: newId() },
    ),
  );
}

/**
 * The contract every driver shares: what it says it can do, whether it is
 * reachable, what it lists, and that `purge` removes one namespace only.
 */
async function checkContract(
  label: string,
  driver: JobsDriver,
  capabilities: DriverCapabilities,
): Promise<void> {
  checkEqual(`${label}: capabilities`, driver.capabilities, capabilities);
  check(`${label}: ping() is true`, await driver.ping());

  const here = ns(label, "contract");
  const elsewhere = ns(label, "untouched");

  const queues = ["alpha", "beta"].map((name) => {
    return new BunQueue(name, { namespace: here, driver });
  });
  for (const queue of queues) await queue.add("job", {});
  const kept = new BunQueue("kept", { namespace: elsewhere, driver });
  await kept.add("job", {});

  // A runner exists as soon as it holds its lock.
  await driver.acquireLock(
    here,
    runnerKey("nightly"),
    newToken(),
    60_000,
    Date.now(),
  );

  checkEqual(`${label}: listQueues()`, (await driver.listQueues(here)).sort(), [
    "alpha",
    "beta",
  ]);
  checkEqual(`${label}: listRunners()`, await driver.listRunners(here), [
    "nightly",
  ]);

  // Asking about a runner nobody registered must not bring it into being.
  // The memory driver used to: every read went through a lookup that created
  // the runner's state, so a mere `info()` of a mistyped id put it in
  // `listRunners()` for good. Every driver now answers a read without writing
  // — and so does popping an unknown runner's empty trigger queue, which on
  // the file and SQL drivers used to create the runner's state.
  const ghost = runnerKey("ghost");
  const reads = {
    lock: await driver.getLock(here, ghost, Date.now()),
    state: await driver.getState(here, ghost),
    history: await driver.listHistory(here, ghost, 5),
    queued: await driver.countQueuedTriggers(here, ghost),
    peeked: await driver.peekQueuedTrigger(here, ghost),
    popped: await driver.popQueuedTrigger(here, ghost),
  };
  checkEqual(`${label}: reads of an unknown runner answer empty`, reads, {
    lock: null,
    state: {},
    history: [],
    queued: 0,
    peeked: null,
    popped: null,
  });
  checkEqual(
    `${label}: …and register nothing — listRunners() is unchanged`,
    await driver.listRunners(here),
    ["nightly"],
  );

  // A queued trigger records whether it was forced past a pause, so the
  // process that later drains it can tell. A record without the field — one
  // an earlier version wrote — reads as not forced.
  const nightly = runnerKey("nightly");
  const trigger = {
    source: "manual",
    requestedAt: Date.now(),
    requestedBy: newToken(),
  } as const;
  await driver.pushQueuedTrigger(
    here,
    nightly,
    { ...trigger, id: "forced", force: true },
    10,
  );
  await driver.pushQueuedTrigger(
    here,
    nightly,
    { ...trigger, id: "older" },
    10,
  );
  // `peekQueuedTrigger` reads the head — the trigger a pop would take next —
  // without taking it: a paused runner looks before it commits, running a
  // forced head and leaving an ordinary one in place, in order.
  const peeked = [
    await driver.peekQueuedTrigger(here, nightly),
    await driver.peekQueuedTrigger(here, nightly),
  ];
  checkEqual(
    `${label}: peekQueuedTrigger() returns the head, force and all, and removes nothing`,
    {
      peeked: peeked.map((head) => [head?.id, head?.force === true]),
      queued: await driver.countQueuedTriggers(here, nightly),
    },
    {
      peeked: [
        ["forced", true],
        ["forced", true],
      ],
      queued: 2,
    },
  );
  const drained = [
    await driver.popQueuedTrigger(here, nightly),
    await driver.popQueuedTrigger(here, nightly),
  ];
  checkEqual(
    `${label}: …the pop that follows takes that same record`,
    drained[0],
    peeked[0],
  );
  checkEqual(
    `${label}: peekQueuedTrigger() of an emptied queue answers null`,
    await driver.peekQueuedTrigger(here, nightly),
    null,
  );
  checkEqual(
    `${label}: a queued trigger keeps force: true; one without it reads as not forced`,
    drained.map((popped) => [popped?.id, popped?.force === true]),
    [
      ["forced", true],
      ["older", false],
    ],
  );

  await driver.purge(here);
  checkEqual(
    `${label}: purge() empties the namespace`,
    {
      queues: await driver.listQueues(here),
      runners: await driver.listRunners(here),
    },
    { queues: [], runners: [] },
  );
  checkEqual(
    `${label}: …and leaves every other namespace alone`,
    await driver.listQueues(elsewhere),
    ["kept"],
  );

  await Promise.all([...queues, kept].map((queue) => queue.close()));
  await driver.purge(elsewhere);
}

/**
 * `pollInterval` on a backend that reads events back from storage: a
 * subscriber reads on that interval, so a slow one has not seen an event
 * published just after it subscribed until the interval has passed.
 */
async function checkPollInterval(
  label: string,
  make: (pollInterval: number) => JobsDriver,
): Promise<void> {
  for (const pollInterval of [2_000, 20]) {
    const driver = make(pollInterval);
    const namespace = ns(label, `poll${pollInterval}`);
    await driver.connect();

    const received: DriverEvent[] = [];
    const subscribedAt = Date.now();
    const unsubscribe = await driver.subscribe(
      namespace,
      "runner",
      "poll",
      (event) => {
        received.push(event);
      },
    );
    await publishOne(driver, namespace, "poll");

    if (pollInterval === 2_000) {
      await Bun.sleep(400); // an observation window well inside the interval
      checkEqual(
        `${label}: pollInterval 2000 — nothing read within 400ms`,
        received.length,
        0,
      );
    }

    await waitFor(
      `${label}: the event to be read`,
      () => received.length === 1,
      WAIT,
    );
    const tookMs = Date.now() - subscribedAt;

    if (pollInterval === 2_000) {
      check(
        `${label}: …and read once the interval passed`,
        tookMs >= 1_500,
        tookMs,
      );
    } else {
      check(
        `${label}: pollInterval 20 — read promptly`,
        tookMs < 1_500,
        tookMs,
      );
    }

    await unsubscribe();
    await driver.purge(namespace);
    await driver.close();
  }
}

/**
 * `eventRetentionMs`: a stored event older than the window is pruned by a
 * later publish; `0` keeps everything until `cleanEvents` is called.
 */
async function checkEventRetention(
  label: string,
  make: (eventRetentionMs: number) => JobsDriver,
  stored: StoredEvents,
): Promise<void> {
  const pruning = make(1_000);
  const pruned = ns(label, "retention");
  await pruning.connect();

  await publishOne(pruning, pruned, "old");
  check(`${label}: an event is stored`, (await stored(pruned, "old")) > 0);
  // Older than the one-second window, and past the one-second sweep interval.
  await Bun.sleep(1_100);
  await publishOne(pruning, pruned, "fresh");

  await waitFor(
    `${label}: the stale event to be pruned`,
    async () => (await stored(pruned, "old")) === 0,
    WAIT,
  );
  check(
    `${label}: eventRetentionMs 1000 — a later publish pruned the stale event`,
    true,
  );
  check(
    `${label}: …and kept the fresh one`,
    (await stored(pruned, "fresh")) > 0,
  );
  await pruning.purge(pruned);
  await pruning.close();

  const keeping = make(0);
  const kept = ns(label, "keep");
  await keeping.connect();

  await publishOne(keeping, kept, "old");
  await Bun.sleep(1_100);
  await publishOne(keeping, kept, "fresh");
  await Bun.sleep(300); // an observation window for a prune that must not happen
  check(
    `${label}: eventRetentionMs 0 — nothing is pruned`,
    (await stored(kept, "old")) > 0,
  );

  const removed = await keeping.cleanEvents!(kept, Date.now() + 1);
  check(
    `${label}: cleanEvents() prunes on demand, and says how much`,
    removed >= 1 && (await stored(kept, "old")) === 0,
    removed,
  );
  await keeping.purge(kept);
  await keeping.close();
}

/* ------------------------------------------------------------------ */
step("Connection helpers: toConnectionUrl and every ConnectionOptions field");

checkEqual(
  "host, port, user, password (encoded), database, hosts, params",
  toConnectionUrl(
    {
      host: "db1",
      port: 5433,
      user: "job user",
      password: "p@ss/word",
      database: "jobs",
      hosts: [{ host: "db2" }, { host: "db3", port: 6000 }],
      params: { sslmode: "require", connect_timeout: 5, keepalives: true },
    },
    { scheme: "postgres", port: 5432 },
  ),
  "postgres://job%20user:p%40ss%2Fword@db1:5433,db2:5432,db3:6000/jobs?sslmode=require&connect_timeout=5&keepalives=true",
);
checkEqual(
  "tls with a scheme of its own, and a numbered database",
  toConnectionUrl(
    { tls: true, database: 13 },
    { scheme: "redis", tlsScheme: "rediss", host: "127.0.0.1", port: 6379 },
  ),
  "rediss://127.0.0.1:6379/13",
);
checkEqual(
  "tls without one becomes ?tls=true",
  toConnectionUrl({ host: "db", tls: true }, { scheme: "mysql", port: 3306 }),
  "mysql://db:3306/?tls=true",
);
checkEqual(
  "…unless params already says",
  toConnectionUrl(
    { host: "db", tls: true, params: { tls: "false" } },
    { scheme: "mysql", port: 3306 },
  ),
  "mysql://db:3306/?tls=false",
);
checkEqual(
  "databaseInPath: false keeps the database out of the path",
  toConnectionUrl(
    { host: "db", database: "jobs", params: { authSource: "admin" } },
    { scheme: "mongodb", databaseInPath: false },
  ),
  "mongodb://db/?authSource=admin",
);
checkEqual(
  "no host at all: 127.0.0.1",
  toConnectionUrl({ user: "u" }, { scheme: "postgres" }),
  "postgres://u@127.0.0.1/",
);

// `allowPublicKeyRetrieval` (MySQL/MariaDB) is not part of the URL: the SQL
// driver hands it to the client as an option. Checked by the typecheck only
// here — this tour does not connect to MySQL.
const mysqlOptions = {
  adapter: "mysql",
  connection: {
    host: "127.0.0.1",
    user: "jobs",
    password: "secret",
    database: "jobs",
    allowPublicKeyRetrieval: true,
  },
  tablePrefix: EXAMPLE_PREFIX,
} satisfies SqlDriverOptions;
checkEqual(
  "allowPublicKeyRetrieval is never written into a URL",
  toConnectionUrl(mysqlOptions.connection, { scheme: "mysql", port: 3306 }),
  "mysql://jobs:secret@127.0.0.1:3306/jobs",
);

checkEqual(
  "resolveConnectionUrl: a url wins over connection",
  resolveConnectionUrl(
    { url: "redis://from-env:6379/1", connection: { host: "from-config" } },
    { scheme: "redis", port: 6379 },
    "tour",
  ),
  "redis://from-env:6379/1",
);
checkEqual(
  "resolveConnectionUrl: connection when there is no url",
  resolveConnectionUrl(
    { connection: { host: "from-config", database: 2 } },
    { scheme: "redis", port: 6379 },
    "tour",
  ),
  "redis://from-config:6379/2",
);
await checkRejects(
  "resolveConnectionUrl: neither",
  () => resolveConnectionUrl({}, { scheme: "redis" }, "The tour driver"),
  { name: "ConfigError", message: /needs either a url or a connection/ },
);

checkEqual(
  "databaseFromUrl",
  [
    databaseFromUrl("postgres://h/jobs"),
    databaseFromUrl("redis://h:6379/13"),
    databaseFromUrl("mongodb://h/my%20db?authSource=admin"),
    databaseFromUrl("mongodb://h"),
    databaseFromUrl("not a url"),
  ],
  ["jobs", "13", "my db", undefined, undefined],
);

checkEqual(
  "resolveNames: a prefix, and an exact name that ignores it",
  resolveNames(SQL_TABLES, {
    prefix: "app_",
    overrides: { events: "legacy_event_log" },
    defaultPrefix: "bun_jobs_",
  }),
  {
    jobs: "app_jobs",
    locks: "app_locks",
    kv: "app_kv",
    events: "legacy_event_log",
    logs: "app_logs",
    workers: "app_workers",
    metrics: "app_metrics",
  },
);
checkEqual(
  "resolveNames: the default prefix when none is given",
  resolveNames(MONGO_COLLECTIONS, { defaultPrefix: "bun_jobs_" }).jobLogs,
  "bun_jobs_jobLogs",
);
await checkRejects(
  "resolveNames: an empty exact name",
  () =>
    resolveNames(SQL_TABLES, { overrides: { jobs: "" }, defaultPrefix: "x_" }),
  { name: "ConfigError" },
);

checkEqual(
  "SQL_TABLES",
  [...SQL_TABLES],
  // `workers` holds each worker's heartbeat record and `metrics` the
  // per-minute throughput counts, both read by the queue's read APIs.
  ["jobs", "locks", "kv", "events", "logs", "workers", "metrics"],
);
checkEqual(
  "MONGO_COLLECTIONS",
  [...MONGO_COLLECTIONS],
  ["jobs", "locks", "kv", "events", "jobLogs"],
);

checkEqual(
  "detectAdapter: from the scheme, or a bare path",
  [
    "postgres://h/db",
    "postgresql://h/db",
    "mysql://h/db",
    "mariadb://h/db",
    "sqlite:///tmp/jobs.db",
    "file:/tmp/jobs.db",
    ":memory:",
    "/var/data/jobs.db",
    "./jobs.db",
  ].map((url) => detectAdapter(url)),
  [
    "postgres",
    "postgres",
    "mysql",
    "mariadb",
    "sqlite",
    "sqlite",
    "sqlite",
    "sqlite",
    "sqlite",
  ],
);
await checkRejects(
  "detectAdapter: an unknown scheme",
  () => detectAdapter("redis://h"),
  {
    name: "ConfigError",
  },
);
await checkRejects("detectAdapter: no url", () => detectAdapter(undefined), {
  name: "ConfigError",
});

checkEqual(
  "dialectFor: one per engine, and only Postgres can LISTEN",
  (["postgres", "mysql", "mariadb", "sqlite"] as const).map((adapter) => {
    const dialect = dialectFor(adapter);
    return [dialect.name, dialect.supportsListen];
  }),
  [
    ["postgres", true],
    ["mysql", false],
    ["mariadb", false],
    ["sqlite", false],
  ],
);
await checkRejects(
  "dialectFor: an unsupported adapter",
  () => dialectFor("oracle" as "postgres"),
  { name: "ConfigError" },
);

const plainKeys = new RedisKeys({});
const clusterKeys = new RedisKeys({ prefix: "examples:", cluster: true });
checkEqual(
  "RedisKeys: defaults",
  { prefix: plainKeys.prefix, cluster: plainKeys.cluster },
  { prefix: "bun-jobs", cluster: false },
);
checkEqual(
  "RedisKeys: the namespace first, then what it is",
  [
    plainKeys.namespace("svc"),
    plainKeys.queues("svc"),
    plainKeys.runners("svc"),
    plainKeys.queue({ ns: "svc", queue: "mail" }).wait,
    plainKeys.runner("svc", "nightly").lock,
    plainKeys.channel("svc", "queue", "mail"),
  ],
  [
    "bun-jobs:svc",
    "bun-jobs:svc:queues",
    "bun-jobs:svc:runners",
    "bun-jobs:svc:q:mail:wait",
    "bun-jobs:svc:r:nightly:lock",
    "bun-jobs:svc:ev:q:mail",
  ],
);
checkEqual(
  "RedisKeys: cluster mode hash-tags a queue's and a runner's keys",
  [
    clusterKeys.queue({ ns: "svc", queue: "mail" }).wait,
    clusterKeys.queue({ ns: "svc", queue: "mail" }).meta,
    clusterKeys.runner("svc", "nightly").state,
  ],
  [
    "examples::svc:q:{mail}:wait",
    "examples::svc:q:{mail}:meta",
    "examples::svc:r:{nightly}:state",
  ],
);

/* ------------------------------------------------------------------ */
step("Memory");

const memory = new MemoryDriver();
await checkContract("memory", memory, {
  blockingWait: true,
  events: "local",
  multiProcess: false,
  multiHost: false,
});
check(
  "memory: stores no events and has no schema, so neither optional method",
  (memory as JobsDriver).cleanEvents === undefined &&
    (memory as JobsDriver).syncSchema === undefined,
);
await memory.close();

/* ------------------------------------------------------------------ */
step("File: root, pollInterval, eventRetentionMs");

const fileRoot = join(tempDir("driver-file"), "jobs");
const file = new FileDriver({ root: fileRoot });
checkEqual("file: root", file.root, fileRoot);
check("file: ping() is false before the root exists", !(await file.ping()));
await file.connect();
check("file: connect() creates the root on demand", await file.ping());
await checkContract("file", file, {
  blockingWait: false,
  events: "poll",
  multiProcess: true,
  multiHost: false,
});
check(
  "file: has no schema to sync",
  (file as JobsDriver).syncSchema === undefined,
);
await file.close();

/** The size of one runner's event log under a file driver's root. */
function fileEvents(root: string): StoredEvents {
  return async (namespace, target) => {
    const log = [
      ...new Bun.Glob("**/events.jsonl").scanSync({ cwd: root }),
    ].find(
      (path) =>
        path.startsWith(`${namespace}/`) && path.includes(`/${target}/`),
    );
    return log ? Bun.file(join(root, log)).size : 0;
  };
}

await checkPollInterval("file", (pollInterval) => {
  return new FileDriver({ root: fileRoot, pollInterval });
});
await checkEventRetention(
  "file",
  (eventRetentionMs) => new FileDriver({ root: fileRoot, eventRetentionMs }),
  fileEvents(fileRoot),
);

// The same two options through a config — the form a spawned runner
// receives, so it goes through JSON on the way. `createDriver` used to pass
// only `root` on, and a config could not tune the driver at all.
await checkPollInterval("file-config", (pollInterval) => {
  return createDriver(viaJson({ type: "file", root: fileRoot, pollInterval }));
});
await checkEventRetention(
  "file-config",
  (eventRetentionMs) =>
    createDriver(viaJson({ type: "file", root: fileRoot, eventRetentionMs })),
  fileEvents(fileRoot),
);

/* ------------------------------------------------------------------ */
step(
  "SQLite: url, adapter, tablePrefix, tables, syncSchema, sql, pollInterval, eventRetentionMs",
);

const sqliteFile = join(tempDir("driver-sqlite"), "jobs.db");
const sqliteUrl = `sqlite://${sqliteFile}`;
const eventTable = `${EXAMPLE_PREFIX}event_log`;

/** The options every SQLite driver in this section shares. */
const sqliteBase = {
  url: sqliteUrl,
  tablePrefix: EXAMPLE_PREFIX,
  tables: { events: eventTable },
} satisfies SqlDriverOptions;

const sqlite = new SqlDriver(sqliteBase);
checkEqual("sqlite: the adapter comes from the url", sqlite.adapter, "sqlite");
checkEqual("sqlite: …and so does the dialect", sqlite.dialect.name, "sqlite");
await sqlite.connect();

const inspect = new Database(sqliteFile);

/** Names in `sqlite_master` of one type. */
function sqliteNames(type: "table" | "index"): string[] {
  return inspect
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);
}

checkEqual(
  "sqlite: tablePrefix on every table; tables names one exactly",
  sqliteNames("table").filter((name) => name.startsWith(EXAMPLE_PREFIX)),
  [
    `${EXAMPLE_PREFIX}event_log`,
    `${EXAMPLE_PREFIX}jobs`,
    `${EXAMPLE_PREFIX}kv`,
    `${EXAMPLE_PREFIX}locks`,
    `${EXAMPLE_PREFIX}logs`,
    `${EXAMPLE_PREFIX}metrics`,
    `${EXAMPLE_PREFIX}workers`,
  ],
);

// `multiHost: false`: SQLite is a file, so processes on this machine can share
// it (`multiProcess: true`) but a process on another host cannot. Every other
// SQL engine is reached over a socket, and says `multiHost: true`.
await checkContract("sqlite", sqlite, {
  blockingWait: false,
  events: "poll",
  multiProcess: true,
  multiHost: false,
});

await checkRejects(
  "sqlite: connection fields need an explicit adapter",
  () => new SqlDriver({ connection: { host: "db", database: "jobs" } }),
  { name: "ConfigError", message: /explicit adapter/ },
);
await checkRejects("sqlite: neither url nor adapter", () => new SqlDriver({}), {
  name: "ConfigError",
});

// syncSchema on connect. Connecting already creates every missing index
// (`IF NOT EXISTS`), so the drift a sync exists for is the other direction:
// an `ix_` index this version no longer defines.
const retired = `ix_${EXAMPLE_PREFIX}retired`;
const addRetired = (): void => {
  inspect.run(
    `CREATE INDEX IF NOT EXISTS "${retired}" ON "${EXAMPLE_PREFIX}jobs" (name)`,
  );
};
const hasRetired = (): boolean => sqliteNames("index").includes(retired);

for (const [syncSchema, keeps, label] of [
  [false, true, "false (the default)"],
  [{ dryRun: true }, true, "{ dryRun: true }"],
  [{ indexes: false }, true, "{ indexes: false }"],
  [true, false, "true"],
] as const) {
  addRetired();
  const syncing = new SqlDriver({ ...sqliteBase, syncSchema });
  await syncing.connect();
  checkEqual(
    `sqlite: syncSchema ${label} ${keeps ? "keeps" : "drops"} a retired ix_ index on connect`,
    hasRetired(),
    keeps,
  );
  await syncing.close();
}

addRetired();
const plan = await sqlite.syncSchema({ dryRun: true });
checkEqual(
  "sqlite: syncSchema({ dryRun: true }) reports the change, applied: false",
  plan.map(({ kind, target, blocking, applied }) => ({
    kind,
    target,
    blocking,
    applied,
  })),
  [{ kind: "drop-index", target: retired, blocking: false, applied: false }],
);
check("sqlite: …and changes nothing", hasRetired());
const applied = await sqlite.syncSchema();
checkEqual(
  "sqlite: syncSchema() applies it",
  applied.map(({ kind, target, applied: done }) => ({
    kind,
    target,
    applied: done,
  })),
  [{ kind: "drop-index", target: retired, applied: true }],
);
check("sqlite: …and the index is gone", !hasRetired());
checkEqual(
  "sqlite: a current schema has no drift, alterColumns included",
  await sqlite.syncSchema({ alterColumns: true, dryRun: true }),
  [],
);

// sql: a connection the application already has. The driver never closes it.
const shared = new SQL(sqliteUrl);
const lent = new SqlDriver({
  ...sqliteBase,
  url: undefined,
  adapter: "sqlite",
  sql: shared,
});
await lent.connect();
await new BunQueue("lent", {
  namespace: ns("sqlite", "lent"),
  driver: lent,
}).add("job", {});
await lent.purge(ns("sqlite", "lent"));
await lent.close();
const stillOpen = await shared`SELECT 1 AS one`;
checkEqual(
  "sqlite: sql — closing the driver leaves the lent connection open",
  stillOpen[0],
  {
    one: 1,
  },
);
await shared.close();

await sqlite.close();
check(
  "sqlite: closing a driver that opened its own connection closes it",
  !(await sqlite.ping()),
);

/** Stored events for one runner, in the SQLite event table. */
const sqliteEvents: StoredEvents = async (namespace, target) => {
  const row = inspect
    .query<
      { n: number },
      [string, string]
    >(`SELECT COUNT(*) AS n FROM "${eventTable}" WHERE ns = ? AND channel = ?`)
    .get(namespace, `runner:${target}`);
  return row?.n ?? 0;
};

await checkPollInterval("sqlite", (pollInterval) => {
  return new SqlDriver({ ...sqliteBase, pollInterval });
});
await checkEventRetention(
  "sqlite",
  (eventRetentionMs) => new SqlDriver({ ...sqliteBase, eventRetentionMs }),
  sqliteEvents,
);

// …and through a config, as JSON.
await checkPollInterval("sqlite-config", (pollInterval) => {
  return createDriver(viaJson({ type: "sql", ...sqliteBase, pollInterval }));
});
await checkEventRetention(
  "sqlite-config",
  (eventRetentionMs) =>
    createDriver(viaJson({ type: "sql", ...sqliteBase, eventRetentionMs })),
  sqliteEvents,
);
inspect.close();

/* ------------------------------------------------------------------ */
step("createDriver with every DriverConfig shape, and resolveDriver ownership");

check(
  "createDriver: memory",
  createDriver({ type: "memory" }) instanceof MemoryDriver,
);

const fromFileConfig = createDriver({ type: "file", root: fileRoot });
check(
  "createDriver: file, with its root",
  fromFileConfig instanceof FileDriver && fromFileConfig.root === fileRoot,
);

const fromSqlConfig = createDriver({
  type: "sql",
  url: sqliteUrl,
  adapter: "sqlite",
  tablePrefix: EXAMPLE_PREFIX,
  tables: { events: eventTable },
  notify: false,
  syncSchema: { indexes: true },
});
check(
  "createDriver: sql, every field",
  fromSqlConfig instanceof SqlDriver && fromSqlConfig.adapter === "sqlite",
);
await fromSqlConfig.connect();
check(
  "createDriver: sql connects with the tables it was named",
  await fromSqlConfig.ping(),
);
await fromSqlConfig.close();

// Built, never connected: a client connects on first use.
const fromRedisConfig = createDriver({
  type: "redis",
  connection: { host: "127.0.0.1", port: 6379, database: 13 },
  cluster: true,
  keyPrefix: "examples:",
});
check(
  "createDriver: redis, with cluster and keyPrefix",
  fromRedisConfig instanceof RedisDriver &&
    fromRedisConfig.keys.cluster &&
    fromRedisConfig.keys.prefix === "examples:",
);
await fromRedisConfig.close();

const fromMongoConfig = createDriver({
  type: "mongodb",
  url: "mongodb://127.0.0.1:27017/from_url",
  database: "from_option",
  collectionPrefix: SERVER_PREFIX,
  collections: { events: `${SERVER_PREFIX}event_log` },
  syncSchema: false,
});
check(
  "createDriver: mongodb, with database, collectionPrefix and collections",
  fromMongoConfig instanceof MongoDriver &&
    fromMongoConfig.database === "from_option" &&
    fromMongoConfig.collections.jobs === `${SERVER_PREFIX}jobs` &&
    fromMongoConfig.collections.events === `${SERVER_PREFIX}event_log`,
);
await fromMongoConfig.close();

// clientOptions through a config. They are declared as plain JSON values,
// not the driver library's own option type, precisely so a config survives
// JSON: functions, streams and TLS buffers go to the constructor instead.
// No server is needed to see them arrive — a short server-selection timeout
// makes an unreachable address fail in well under the client's 30s default.
const unreachableConfig = createDriver(
  viaJson({
    type: "mongodb",
    url: "mongodb://127.0.0.1:1/unreachable",
    clientOptions: { serverSelectionTimeoutMS: 300 },
  }),
);
const configTriedAt = Date.now();
await checkRejects(
  "createDriver: mongodb clientOptions — an unreachable server",
  () => unreachableConfig.connect(),
  { name: "DriverError" },
);
const configFailedIn = Date.now() - configTriedAt;
check(
  "createDriver: …failing on the timeout the config gave",
  configFailedIn < 10_000,
  configFailedIn,
);
await unreachableConfig.close();

await checkRejects(
  "createDriver: an unknown type",
  () => createDriver({ type: "cassandra" } as unknown as { type: "memory" }),
  { name: "ConfigError" },
);

const nothingGiven = resolveDriver(undefined);
check(
  "resolveDriver(undefined): a memory driver, owned",
  nothingGiven.driver instanceof MemoryDriver && nothingGiven.owned,
);
const configGiven = resolveDriver({ type: "memory" });
check("resolveDriver(config): built here, owned", configGiven.owned);
const instance = new MemoryDriver();
const instanceGiven = resolveDriver(instance);
check(
  "resolveDriver(instance): the same instance, not owned",
  instanceGiven.driver === instance && !instanceGiven.owned,
);

// What owning means: a context closes a driver it built, and not one lent.
const ownsIt = new BunJobs({
  namespace: ns("owned", "ctx"),
  driver: { type: "sql", url: sqliteUrl, tablePrefix: EXAMPLE_PREFIX },
});
await ownsIt.queue("q").add("job", {});
await ownsIt.purge();
await ownsIt.close();
check(
  "a context closes the driver it built from a config",
  !(await ownsIt.driver.ping()),
);

const lentDriver = new SqlDriver({
  url: sqliteUrl,
  tablePrefix: EXAMPLE_PREFIX,
});
const borrows = new BunJobs({
  namespace: ns("lent", "ctx"),
  driver: lentDriver,
});
await borrows.queue("q").add("job", {});
await borrows.purge();
await borrows.close();
check("…and leaves an instance it was lent open", await lentDriver.ping());
await lentDriver.close();

/* ------------------------------------------------------------------ */
step(
  "Postgres: url, connection, adapter, notify, syncSchema, tables, sql, pollInterval, eventRetentionMs",
);

const postgresUrl = process.env[URL_VARIABLES.postgres];

if (!postgresUrl) {
  show(`skipped: set ${URL_VARIABLES.postgres} to cover the Postgres options`);
} else {
  const probe = new SQL(postgresUrl);
  const pgEvents = `${SERVER_PREFIX}event_log`;

  /** The options every Postgres driver in this section shares. */
  const pgBase = {
    url: postgresUrl,
    tablePrefix: SERVER_PREFIX,
    tables: { events: pgEvents },
  } satisfies SqlDriverOptions;

  const postgres = new SqlDriver(pgBase);
  checkEqual(
    "postgres: the adapter comes from the url",
    postgres.adapter,
    "postgres",
  );
  await postgres.connect();
  await checkContract("postgres", postgres, {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: true,
  });

  const tableRows = await probe.unsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE $1
      ORDER BY table_name`,
    [`${SERVER_PREFIX.replaceAll("_", "\\_")}%`],
  );
  checkEqual(
    "postgres: tablePrefix, and tables naming events exactly",
    tableRows.map((row) => row.table_name),
    [
      pgEvents,
      `${SERVER_PREFIX}jobs`,
      `${SERVER_PREFIX}kv`,
      `${SERVER_PREFIX}locks`,
      `${SERVER_PREFIX}logs`,
      `${SERVER_PREFIX}metrics`,
      `${SERVER_PREFIX}workers`,
    ],
  );

  // The same server as fields, with params and tls, and the adapter named.
  const parts = new URL(postgresUrl);
  const connection = {
    host: parts.hostname,
    port: parts.port ? Number(parts.port) : undefined,
    user: decodeURIComponent(parts.username),
    password: decodeURIComponent(parts.password),
    database: parts.pathname.slice(1),
    tls: false,
    params: { sslmode: "disable" },
  };
  const fromFields = new SqlDriver({
    adapter: "postgres",
    connection,
    tablePrefix: SERVER_PREFIX,
    tables: { events: pgEvents },
  });
  await fromFields.connect();
  check(
    "postgres: connection fields (params, tls) connect",
    await fromFields.ping(),
  );
  await fromFields.close();

  const urlWins = new SqlDriver({
    ...pgBase,
    connection: { ...connection, host: "nowhere.invalid" },
  });
  await urlWins.connect();
  check("postgres: url wins over connection", await urlWins.ping());
  await urlWins.close();

  // notify: a waiting driver LISTENs on the queue's channel, or does not.
  for (const notify of [true, false]) {
    const listening = new SqlDriver({ ...pgBase, notify });
    const namespace = ns("postgres", `notify${String(notify)}`);
    await listening.connect();
    await listening.waitForJob({ ns: namespace, queue: "idle" }, 300);

    const channel = `bunjobs_${Bun.hash(`${namespace}:idle`).toString(36)}`;
    const listeners = await probe.unsafe<{ query: string }[]>(
      "SELECT query FROM pg_stat_activity WHERE query ILIKE $1 AND pid <> pg_backend_pid()",
      [`LISTEN%${channel}%`],
    );
    checkEqual(
      `postgres: notify ${String(notify)} — ${notify ? "a" : "no"} LISTEN for the queue`,
      listeners.length,
      notify ? 1 : 0,
    );
    await listening.close();
  }

  // syncSchema on connect: a retired ix_ index, dropped only when asked.
  const pgRetired = `ix_${SERVER_PREFIX}retired`;
  const pgHasRetired = async (): Promise<boolean> => {
    const rows = await probe.unsafe<{ n: number }[]>(
      "SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1",
      [pgRetired],
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  for (const [syncSchema, keeps, label] of [
    [{ dryRun: true }, true, "{ dryRun: true }"],
    [true, false, "true"],
  ] as const) {
    await probe.unsafe(
      `CREATE INDEX IF NOT EXISTS "${pgRetired}" ON "${SERVER_PREFIX}jobs" (name)`,
    );
    const syncing = new SqlDriver({ ...pgBase, syncSchema });
    await syncing.connect();
    checkEqual(
      `postgres: syncSchema ${label} ${keeps ? "keeps" : "drops"} a retired ix_ index`,
      await pgHasRetired(),
      keeps,
    );
    await syncing.close();
  }
  checkEqual(
    "postgres: a current schema has no drift",
    await postgres.syncSchema({ dryRun: true }),
    [],
  );

  // sql: a shared Bun.SQL survives the driver closing.
  const pgShared = new SQL(postgresUrl);
  const pgLent = new SqlDriver({
    adapter: "postgres",
    sql: pgShared,
    tablePrefix: SERVER_PREFIX,
    tables: { events: pgEvents },
  });
  await pgLent.connect();
  check(
    "postgres: sql — the lent connection works through the driver",
    await pgLent.ping(),
  );
  await pgLent.close();
  const pgStillOpen = await pgShared`SELECT 1 AS one`;
  checkEqual("postgres: …and stays open after it closes", pgStillOpen[0], {
    one: 1,
  });
  await pgShared.close();

  await postgres.close();

  await checkPollInterval("postgres", (pollInterval) => {
    return new SqlDriver({ ...pgBase, pollInterval });
  });
  await checkEventRetention(
    "postgres",
    (eventRetentionMs) => new SqlDriver({ ...pgBase, eventRetentionMs }),
    async (namespace, target) => {
      const rows = await probe.unsafe<{ n: number }[]>(
        `SELECT COUNT(*)::int AS n FROM "${pgEvents}" WHERE ns = $1 AND channel = $2`,
        [namespace, `runner:${target}`],
      );
      return rows[0]?.n ?? 0;
    },
  );

  await probe.close();
}

/* ------------------------------------------------------------------ */
step("Redis: url, connection, keyPrefix, cluster, client, maxBlockSeconds");

const redisUrl = process.env[URL_VARIABLES.redis];

if (!redisUrl) {
  show(`skipped: set ${URL_VARIABLES.redis} to cover the Redis options`);
} else {
  const keyPrefix = "examples:opts";
  const redis = new RedisDriver({ url: redisUrl, keyPrefix });
  checkEqual("redis: keyPrefix", redis.keys.prefix, keyPrefix);
  await checkContract("redis", redis, {
    blockingWait: true,
    events: "push",
    multiProcess: true,
    multiHost: true,
  });
  check(
    "redis: stores no events and has no schema, so neither optional method",
    (redis as JobsDriver).cleanEvents === undefined &&
      (redis as JobsDriver).syncSchema === undefined,
  );

  const inspectRedis = new RedisClient(redisUrl);
  const prefixed = ns("redis", "prefix");
  await new BunQueue("mail", { namespace: prefixed, driver: redis }).add(
    "job",
    {},
  );
  const written = (await inspectRedis.send("KEYS", [
    `${keyPrefix}:${prefixed}:*`,
  ])) as string[];
  check(
    "redis: every key sits under keyPrefix and the namespace",
    written.length > 0,
    written,
  );
  await redis.purge(prefixed);
  checkEqual(
    "redis: purge() removes them",
    (
      (await inspectRedis.send("KEYS", [
        `${keyPrefix}:${prefixed}:*`,
      ])) as string[]
    ).length,
    0,
  );

  // The same server as fields.
  const parts = new URL(redisUrl);
  const fromFields = new RedisDriver({
    connection: {
      host: parts.hostname,
      port: parts.port ? Number(parts.port) : undefined,
      database: Number(parts.pathname.slice(1) || 0),
    },
    keyPrefix,
  });
  check("redis: connection fields connect", await fromFields.ping());
  await fromFields.close();

  // cluster: built only, since there is no cluster to talk to here.
  const cluster = new RedisDriver({ url: redisUrl, keyPrefix, cluster: true });
  check(
    "redis: cluster hash-tags each queue's keys into one slot",
    cluster.keys.cluster &&
      cluster.keys.queue({ ns: "svc", queue: "mail" }).wait.includes("{mail}"),
  );
  await cluster.close();

  // client: a connection the application already has. Commands run on it,
  // but the driver still opens connections of its own — one for blocking
  // waits, one for pub/sub — and builds those from `url` or `connection`, so
  // one of them is required alongside a client.
  const client = new RedisClient(redisUrl);
  await client.connect();
  await checkRejects(
    "redis: a client alone, with no url for the extra connections",
    () => new RedisDriver({ client, keyPrefix }),
    { name: "ConfigError" },
  );
  const borrowing = new RedisDriver({ client, url: redisUrl, keyPrefix });
  check(
    "redis: client — the driver runs on the lent client",
    await borrowing.ping(),
  );
  await borrowing.close();
  checkEqual(
    "redis: …and closing the driver leaves it open",
    await client.send("PING", []),
    "PONG",
  );
  client.close();

  // maxBlockSeconds: how long one blocking wait lasts at most.
  for (const [maxBlockSeconds, min, max] of [
    [0.2, 100, 3_000],
    [undefined, 4_000, 9_500],
  ] as const) {
    const blocking = new RedisDriver({
      url: redisUrl,
      keyPrefix,
      maxBlockSeconds,
    });
    const waitedFrom = Date.now();
    await blocking.waitForJob(
      { ns: ns("redis", "block"), queue: "idle" },
      10_000,
    );
    const waited = Date.now() - waitedFrom;
    check(
      `redis: maxBlockSeconds ${maxBlockSeconds ?? "default (5)"} — a 10s wait on an empty queue returned after ${waited}ms`,
      waited >= min && waited <= max,
      { waited, min, max },
    );
    await blocking.close();
  }

  // …and through a config, which used to drop it: `createDriver` passed on
  // only the connection and the prefix.
  const fromConfig = createDriver(
    viaJson({ type: "redis", url: redisUrl, keyPrefix, maxBlockSeconds: 0.2 }),
  );
  const configWaitFrom = Date.now();
  await fromConfig.waitForJob(
    { ns: ns("redis", "block-config"), queue: "idle" },
    10_000,
  );
  const configWaited = Date.now() - configWaitFrom;
  check(
    `redis: maxBlockSeconds 0.2 from a config — a 10s wait returned after ${configWaited}ms`,
    configWaited >= 100 && configWaited <= 3_000,
    configWaited,
  );
  await fromConfig.close();

  // A wait that was given up on. `BLPOP` cannot be called off, so an aborted
  // wait leaves its pop parked on the blocking connection — and the pop is a
  // destructive read, so the wake token the next add() pushes is taken by
  // that parked pop with nobody to hand it to. The next wait then sat out a
  // whole block (5s by default) before noticing the job. The driver now
  // shares one pop per queue and hands a token nobody took to the next waiter.
  const wakeNs = ns("redis", "wake");
  const wakeRef = { ns: wakeNs, queue: "orders" };
  const waking = new RedisDriver({ url: redisUrl, keyPrefix });
  const wakeQueue = new BunQueue("orders", {
    namespace: wakeNs,
    driver: waking,
  });
  await waking.connect();
  const abort = new AbortController();
  const abandoned = waking.waitForJob(wakeRef, 30_000, abort.signal);
  await Bun.sleep(100); // long enough to be parked inside the pop
  abort.abort();
  await abandoned;
  await wakeQueue.add("reindex", {});
  await Bun.sleep(150); // the parked pop takes the token in this time
  const wokeFrom = Date.now();
  await waking.waitForJob(wakeRef, 30_000);
  const woke = Date.now() - wokeFrom;
  check(
    `redis: the wake an abandoned wait took reaches the next wait (${woke}ms, not a full block)`,
    woke < 1_000,
    woke,
  );
  await wakeQueue.close();
  await waking.purge(wakeNs);
  await waking.close();

  inspectRedis.close();
  await redis.close();
}

/* ------------------------------------------------------------------ */
step(
  "MongoDB: url, connection, database, collectionPrefix, collections, clientOptions, client, pollInterval, syncSchema, eventRetentionMs",
);

const mongoUrl = process.env[URL_VARIABLES.mongodb];

if (!mongoUrl) {
  show(`skipped: set ${URL_VARIABLES.mongodb} to cover the MongoDB options`);
} else {
  const database = databaseFromUrl(mongoUrl) ?? "bun_jobs";
  const mongoEvents = `${SERVER_PREFIX}event_log`;

  /** The options every MongoDB driver in this section shares. */
  const mongoBase = {
    url: mongoUrl,
    collectionPrefix: SERVER_PREFIX,
    collections: { events: mongoEvents },
  };

  const mongo = new MongoDriver(mongoBase);
  checkEqual(
    "mongodb: database defaults to the url's",
    mongo.database,
    database,
  );
  checkEqual(
    "mongodb: collectionPrefix, and collections naming events exactly",
    mongo.collections,
    {
      jobs: `${SERVER_PREFIX}jobs`,
      locks: `${SERVER_PREFIX}locks`,
      kv: `${SERVER_PREFIX}kv`,
      events: mongoEvents,
      jobLogs: `${SERVER_PREFIX}jobLogs`,
    },
  );
  checkEqual(
    "mongodb: database, as an option, over a url without one",
    new MongoDriver({ url: "mongodb://127.0.0.1:27017", database }).database,
    database,
  );
  checkEqual(
    'mongodb: …and "bun_jobs" when nothing names one',
    new MongoDriver({ url: "mongodb://127.0.0.1:27017" }).database,
    "bun_jobs",
  );

  await mongo.connect();
  await checkContract("mongodb", mongo, {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: true,
  });

  const inspectMongo = new MongoClient(mongoUrl);
  await inspectMongo.connect();
  const db = inspectMongo.db(database);
  const collectionNames = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  )
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(SERVER_PREFIX));
  check(
    "mongodb: the collections exist under those names",
    [`${SERVER_PREFIX}jobs`, mongoEvents].every((name) =>
      collectionNames.includes(name),
    ),
    collectionNames,
  );

  const parts = new URL(mongoUrl);
  const fromFields = new MongoDriver({
    connection: {
      host: parts.hostname,
      port: parts.port ? Number(parts.port) : undefined,
      database,
    },
    collectionPrefix: SERVER_PREFIX,
    collections: { events: mongoEvents },
  });
  checkEqual(
    "mongodb: connection.database names the database",
    fromFields.database,
    database,
  );
  check("mongodb: connection fields connect", await fromFields.ping());
  await fromFields.close();

  // clientOptions reach the client: a short server selection timeout makes an
  // unreachable server fail in well under the client's 30s default.
  const unreachable = new MongoDriver({
    url: "mongodb://127.0.0.1:1/unreachable",
    clientOptions: { serverSelectionTimeoutMS: 300 },
  });
  const triedAt = Date.now();
  await checkRejects(
    "mongodb: clientOptions — an unreachable server",
    () => unreachable.connect(),
    {
      name: "DriverError",
    },
  );
  const failedIn = Date.now() - triedAt;
  check(
    "mongodb: …failing on the timeout it was given",
    failedIn < 10_000,
    failedIn,
  );
  await unreachable.close();

  // client: lent, and never closed by the driver.
  const lentClient = new MongoClient(mongoUrl);
  await lentClient.connect();
  const borrowing = new MongoDriver({ ...mongoBase, client: lentClient });
  check(
    "mongodb: client — the driver runs on the lent client",
    await borrowing.ping(),
  );
  await borrowing.close();
  const pong = await lentClient.db(database).command({ ping: 1 });
  checkEqual("mongodb: …and closing the driver leaves it open", pong.ok, 1);
  await lentClient.close();

  // syncSchema on connect: an index an earlier version created, retired now.
  // Retiring it is what `syncSchema` adds over a plain connect, so a connect
  // without it, a `dryRun` and `indexes: false` all leave it in place.
  const jobsCollection = db.collection(`${SERVER_PREFIX}jobs`);
  const retiredIndex = "ns_1_queue_1_state_1_priority_1_createdAt_1";
  const mongoHasRetired = async (): Promise<boolean> => {
    const indexes = await jobsCollection.indexes();
    return indexes.some((index) => index.name === retiredIndex);
  };

  for (const [syncSchema, keeps, label] of [
    [false, true, "false (the default)"],
    [{ dryRun: true }, true, "{ dryRun: true }"],
    [{ indexes: false }, true, "{ indexes: false }"],
    [true, false, "true"],
  ] as const) {
    await jobsCollection.createIndex({
      ns: 1,
      queue: 1,
      state: 1,
      priority: 1,
      createdAt: 1,
    });
    const syncing = new MongoDriver({ ...mongoBase, syncSchema });
    await syncing.connect();
    checkEqual(
      `mongodb: syncSchema ${label} ${keeps ? "keeps" : "drops"} a retired index`,
      await mongoHasRetired(),
      keeps,
    );
    await syncing.close();
  }

  await jobsCollection.createIndex({
    ns: 1,
    queue: 1,
    state: 1,
    priority: 1,
    createdAt: 1,
  });
  const mongoPlan = await mongo.syncSchema({ dryRun: true });
  checkEqual(
    "mongodb: syncSchema({ dryRun: true }) reports the retirement",
    mongoPlan.map(({ kind, target, applied }) => ({ kind, target, applied })),
    [{ kind: "drop-index", target: retiredIndex, applied: false }],
  );
  const mongoApplied = await mongo.syncSchema();
  check(
    "mongodb: syncSchema() applies it",
    mongoApplied.some(
      (change) => change.target === retiredIndex && change.applied,
    ) && !(await mongoHasRetired()),
    mongoApplied,
  );

  await mongo.close();

  await checkPollInterval("mongodb", (pollInterval) => {
    return new MongoDriver({ ...mongoBase, pollInterval });
  });
  await checkEventRetention(
    "mongodb",
    (eventRetentionMs) => new MongoDriver({ ...mongoBase, eventRetentionMs }),
    async (namespace, target) => {
      return await db.collection(mongoEvents).countDocuments({
        ns: namespace,
        channel: `runner:${target}`,
      });
    },
  );

  // …and both through a config, as JSON.
  await checkPollInterval("mongodb-config", (pollInterval) => {
    return createDriver(
      viaJson({ type: "mongodb", ...mongoBase, pollInterval }),
    );
  });
  await checkEventRetention(
    "mongodb-config",
    (eventRetentionMs) =>
      createDriver(
        viaJson({ type: "mongodb", ...mongoBase, eventRetentionMs }),
      ),
    async (namespace, target) => {
      return await db.collection(mongoEvents).countDocuments({
        ns: namespace,
        channel: `runner:${target}`,
      });
    },
  );

  await inspectMongo.close();
}

summary();
