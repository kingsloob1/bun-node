/**
 * Choosing a driver — how each backend is configured, what each can do, and
 * the same workload run on every one available.
 *
 * ```bash
 * bun 08-drivers/choosing-a-driver.ts
 * EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 * EXAMPLE_POSTGRES_URL=postgres://postgres:postgres@localhost/jobs \
 *   bun 08-drivers/choosing-a-driver.ts
 * ```
 *
 * | Driver | Cross-process | Cross-host | Waiting | Events |
 * |---|---|---|---|---|
 * | memory | no | no | blocks, in-process | local |
 * | file | yes | no | polls | polled |
 * | sql — sqlite | yes | same disk | polls | polled |
 * | sql — postgres, mysql, mariadb | yes | yes | polls (+ Postgres NOTIFY) | polled |
 * | mongodb | yes | yes | polls | polled |
 * | redis | yes | yes | **blocks** — wakes in ~1ms | **pushed** |
 *
 * Application code never changes with the backend: only the config does.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { join } from "node:path";
import process from "node:process";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { EXAMPLE_PREFIX, tempDir, URL_VARIABLES } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Choosing a driver");

/* ------------------------------------------------------------------ */
step("Configs: a URL or connection fields, for every backend");

// Nothing below connects; these are the shapes a config file would hold.
const shapes: Record<string, DriverConfig> = {
  memory: { type: "memory" },
  file: { type: "file", root: "/var/lib/myapp/jobs" },
  sqlite: { type: "sql", url: "sqlite:///var/lib/myapp/jobs.db" },
  "postgres, url": {
    type: "sql",
    url: "postgres://jobs:secret@db.internal:5432/app",
    tablePrefix: "jobs_", // jobs_jobs, jobs_locks, ...
  },
  "postgres, fields": {
    type: "sql",
    adapter: "postgres", // needed when there is no URL scheme to read
    connection: {
      host: "db.internal",
      user: "jobs",
      password: "secret",
      database: "app",
      tls: true,
    },
    tables: { jobs: "legacy_work_items" }, // exact names, for an existing schema
    syncSchema: true, // reconcile an older schema on connect (see sqlite example)
  },
  mysql: { type: "sql", url: "mysql://jobs:secret@db.internal/app" },
  "redis, url": {
    type: "redis",
    url: "redis://cache.internal:6379/2",
    keyPrefix: "myapp:",
  },
  "redis, fields": {
    type: "redis",
    connection: { host: "cache.internal", database: 2, password: "secret" },
  },
  mongodb: {
    type: "mongodb",
    url: "mongodb://db.internal/app",
    collectionPrefix: "jobs_",
  },
};

show("configs are plain JSON — a spawned child can be handed one", {
  "postgres, fields": JSON.stringify(shapes["postgres, fields"]),
});

/* ------------------------------------------------------------------ */
step("The same workload on every backend available here");

const available: [string, DriverConfig][] = [
  ["memory", { type: "memory" }],
  ["file", { type: "file", root: tempDir("compare-file") }],
  [
    "sqlite",
    {
      type: "sql",
      url: `sqlite://${join(tempDir("compare-sqlite"), "jobs.db")}`,
    },
  ],
];

for (const [backend, variable] of Object.entries(URL_VARIABLES)) {
  const url = process.env[variable];

  if (!url) {
    show(`${backend}: not included`, `set ${variable} to add it`);
    continue;
  }

  // A prefix of our own on a real server, so the comparison never touches
  // tables, collections or keys that something else created.
  available.push([
    backend,
    backend === "redis"
      ? { type: "redis", url, keyPrefix: "examples:" }
      : backend === "mongodb"
        ? { type: "mongodb", url, collectionPrefix: EXAMPLE_PREFIX }
        : {
            type: "sql",
            adapter: backend as "postgres",
            url,
            tablePrefix: EXAMPLE_PREFIX,
          },
  ]);
}

/** How many jobs each backend processes. */
const JOBS = 300;
const rows: Record<string, unknown>[] = [];

for (const [backend, config] of available) {
  const driver = createDriver(config);
  const namespace = `compare-${Date.now().toString(36)}`;
  await driver.connect();

  const queue = new BunQueue<{ n: number }, void>("work", {
    namespace,
    driver,
  });
  let done = 0;
  const worker = new BunQueueWorker<{ n: number }, void>(
    "work",
    async () => {
      done++;
    },
    { namespace, driver, concurrency: 10, pollInterval: 10 },
  );
  void worker.run();

  const started = performance.now();
  await queue.addBulk(
    Array.from({ length: JOBS }, (_, n) => ({ name: "noop", data: { n } })),
  );
  const added = performance.now();
  await waitFor(`${backend} to drain`, () => done === JOBS, {
    timeout: 60_000,
    interval: 2,
  });
  const drained = performance.now();

  rows.push({
    backend,
    ping: await driver.ping(),
    ...driver.capabilities,
    "enqueue ms": Math.round(added - started),
    "drain ms": Math.round(drained - added),
  });

  await worker.close();
  await queue.close();
  await driver.purge(namespace);
  await driver.close();
}

console.log();
console.table(rows);
console.log(
  `(${JOBS} jobs, concurrency 10, one process. A figure measures this machine,`,
  "not the backend in production — see packages/bun-jobs/bench for that.)",
);
