/**
 * Postgres, MySQL and MariaDB — through `Bun.sql`, no driver package needed.
 *
 * ```bash
 * EXAMPLE_POSTGRES_URL=postgres://postgres:postgres@localhost/jobs bun 08-drivers/postgres-and-mysql.ts
 * EXAMPLE_MYSQL_URL=mysql://root:root@localhost/jobs bun 08-drivers/postgres-and-mysql.ts
 * EXAMPLE_MARIADB_URL=mariadb://root:root@localhost/jobs bun 08-drivers/postgres-and-mysql.ts
 * ```
 *
 * Runs against every engine whose URL is set. Claims use
 * `FOR UPDATE SKIP LOCKED`, so any number of workers on any number of hosts
 * take jobs without ever taking the same one. On Postgres, new jobs are also
 * announced over `LISTEN`/`NOTIFY` (`notify`, on by default), which a waiting
 * worker hears immediately; polling continues underneath as the safety net.
 *
 * `bun scripts/setup-databases.ts` at the repo root installs local servers.
 *
 * The tables are created with the prefix `bun_jobs_example_` in the database
 * you point it at, and left there (empty) afterwards so a rerun reuses them.
 */
import type { SqlAdapter } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunQueue, BunQueueWorker, SqlDriver } from "@kingsleyweb/bun-jobs";
import { URL_VARIABLES } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

const engines = (["postgres", "mysql", "mariadb"] as const).filter(
  (engine) => process.env[URL_VARIABLES[engine]],
);

if (engines.length === 0) {
  console.log(
    "skipped: set EXAMPLE_POSTGRES_URL, EXAMPLE_MYSQL_URL or EXAMPLE_MARIADB_URL to run this example",
  );
  process.exit(0);
}

title("Postgres, MySQL and MariaDB");

for (const engine of engines) {
  step(engine);

  const url = new URL(process.env[URL_VARIABLES[engine]]!);

  // The same connection as fields — the form a config file or a secrets
  // manager hands you. (`url` works just as well.)
  const driver = new SqlDriver({
    adapter: engine satisfies SqlAdapter,
    connection: {
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      // Driver options carried in the query string, e.g. MySQL 8's
      // `allowPublicKeyRetrieval=true` or `ssl=true`.
      params: Object.fromEntries(url.searchParams),
    },
    tablePrefix: "bun_jobs_example_",
    syncSchema: true, // reconcile tables an older version made, on connect
  });

  const namespace = `sql-example-${Date.now().toString(36)}`;
  await driver.connect();
  show("capabilities", driver.capabilities);

  const queue = new BunQueue<{ n: number }, void>("work", {
    namespace,
    driver,
  });
  let done = 0;
  const workers = [1, 2].map(
    (index) =>
      new BunQueueWorker<{ n: number }, void>(
        "work",
        async () => {
          done++;
        },
        {
          namespace,
          driver,
          id: `w${index}`,
          concurrency: 8,
          pollInterval: 50,
        },
      ),
  );
  workers.forEach((worker) => void worker.run());

  const started = performance.now();
  await queue.addBulk(
    Array.from({ length: 500 }, (_, n) => ({ name: "noop", data: { n } })),
  );
  await waitFor("500 jobs", () => done === 500, { timeout: 60_000 });
  show(
    "500 jobs, 2 workers × 8",
    `${Math.round(performance.now() - started)}ms`,
  );

  // One job into an idle queue: on Postgres NOTIFY wakes a worker at once;
  // elsewhere it is found on the next poll (pollInterval 50ms here).
  await Bun.sleep(200);
  const before = done;
  const added = performance.now();
  await queue.add("noop", { n: -1 });
  await waitFor("the single job", () => done === before + 1);
  show("idle add → done", `${(performance.now() - added).toFixed(1)}ms`);

  show("schema drift (dry run)", await driver.syncSchema({ dryRun: true }));

  await Promise.all(workers.map((worker) => worker.close()));
  await queue.close();
  await driver.purge(namespace);
  await driver.close();
}
