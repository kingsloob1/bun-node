/**
 * Policies kept in Postgres (`postgresStore`): the same versions as
 * `policy-store.ts`, but the change feed is pushed (`LISTEN/NOTIFY`), so an
 * engine on another connection learns of a new head without polling for it.
 *
 * ```bash
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/db bun 15-policy/postgres-store.ts
 * ```
 *
 * - It runs when `EXAMPLE_POSTGRES_URL` is set and otherwise prints
 *   `skipped:` and exits 0. A URL that is set but unreachable fails.
 * - The store reports `changeFeed: "push"`. The engine below follows with a
 *   one-minute poll, so a version it loads within the example's wait came
 *   through the push.
 * - Two writers on one head: the second is refused, under Postgres's row
 *   lock rather than SQLite's single writer.
 * - Every table carries the prefix `bsec_example_<pid>_`, and the example
 *   drops exactly those tables at the end, even when a check failed.
 */
import process from "node:process";
import { SQL } from "bun";
import { createSecurity } from "@kingsleyweb/bun-security";
import { postgresStore, storeTables } from "@kingsleyweb/bun-security/store";
import { checkEqual, summary } from "../shared/check";
import { facts } from "../shared/facts";
import { show, step, title, waitFor } from "../shared/console";

const url = process.env.EXAMPLE_POSTGRES_URL;
if (!url) {
  console.log(
    "skipped: set EXAMPLE_POSTGRES_URL (for instance postgres://user:pass@127.0.0.1:5432/db) to run this example",
  );
  process.exit(0);
}

title("policies in Postgres, followed by push");

/** This run's table prefix: it names the process, so a run owns its tables. */
const prefix = `bsec_example_${process.pid}_`;

const raw = new SQL({ url, connectionTimeout: 5 });
try {
  await raw.unsafe("SELECT 1");
} catch (error) {
  await raw.close().catch(() => undefined);
  throw new Error("EXAMPLE_POSTGRES_URL is set but unreachable", {
    cause: error,
  });
}

try {
  /* ------------------------------------------------------------------ */
  step("two connections to one store: a writer, and the engine's");
  const writer = postgresStore({ url, prefix });
  const followed = postgresStore({ url, prefix });
  show("change feed", writer.capabilities.changeFeed);
  checkEqual("the feed is pushed", writer.capabilities.changeFeed, "push");

  const v1 = await writer.appendVersion(
    "checkout",
    {
      id: "v1",
      policy: { lists: [{ ip: "203.0.113.0/24", action: "block" }] },
      createdBy: "ann",
    },
    null,
  );
  checkEqual("v1 appended", v1.ok, true);

  const security = createSecurity({
    // A one-minute poll: a later version that arrives sooner was pushed.
    policy: { store: followed, id: "checkout", pollIntervalMs: 60_000 },
    logger: () => {},
  });
  await security.ready();
  checkEqual("v1 in force", security.status().policySource?.version, "v1");
  checkEqual(
    "203.0.113.9 blocked",
    (await security.evaluate(facts("203.0.113.9"))).action,
    "block",
  );

  /* ------------------------------------------------------------------ */
  step("v2 published on the writer's connection reaches the engine by push");
  const v2 = await writer.appendVersion(
    "checkout",
    {
      id: "v2",
      policy: {
        lists: [
          { ip: "203.0.113.0/24", action: "block" },
          { user: "u_mallory", action: "block" },
        ],
      },
      createdBy: "ann",
    },
    "v1",
  );
  checkEqual("v2 appended", v2.ok, true);
  await waitFor(
    "v2 to arrive by LISTEN/NOTIFY",
    () => security.status().policySource?.version === "v2",
  );
  checkEqual(
    "v2's user entry applies",
    (
      await security.evaluate(
        facts("198.51.100.1", { identity: { user: "u_mallory" } }),
      )
    ).action,
    "block",
  );

  /* ------------------------------------------------------------------ */
  step("a second writer on the old head is refused");
  const stale = await writer.appendVersion(
    "checkout",
    { id: "v2-bob", policy: {}, createdBy: "bob" },
    "v1",
  );
  show("bob", stale);
  checkEqual("bob's append is refused", stale.ok, false);
  checkEqual("still v2", security.status().policySource?.version, "v2");

  security.close();
  await followed.close();
  await writer.close();
} finally {
  for (const table of Object.values(storeTables(prefix))) {
    await raw.unsafe(`DROP TABLE IF EXISTS ${table}`);
  }
  await raw.close();
}

summary();
