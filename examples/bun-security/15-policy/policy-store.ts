/**
 * Policies published as versions in a security store (`sqliteStore`, one
 * file several processes share): the engine follows the head, a stale writer
 * is refused, and a failing store changes nothing.
 *
 * ```bash
 * bun 15-policy/policy-store.ts
 * ```
 *
 * - `appendVersion(policyId, version, expectedHead)` moves the head only if it
 *   is still the one the writer read (`null` for the first): two operators
 *   never both win.
 * - The engine (`policy: { store, id }`) loads the head, then follows the
 *   store's change feed (polled every 250 ms for SQLite, `pollIntervalMs`).
 * - A store that fails raises `policy.unavailable` once and changes nothing:
 *   the policy in force stays. `faultyStore` from `./testing` makes one fail
 *   on demand, as a test would.
 * - The file is a temporary one, deleted at the end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { SecurityWarning } from "@kingsleyweb/bun-security";
import { sqliteStore } from "@kingsleyweb/bun-security/store";
import { faultyStore } from "@kingsleyweb/bun-security/testing";
import { check, checkEqual, summary } from "../shared/check";
import { facts } from "../shared/facts";
import { show, step, title, waitFor } from "../shared/console";

title("policies as versions in a store");

const dir = mkdtempSync(join(tmpdir(), "bun-security-example-"));
const path = join(dir, "security.sqlite");

try {
  const store = sqliteStore({ path });

  /* ------------------------------------------------------------------ */
  step("publish v1, and start an engine following it");
  const v1 = await store.appendVersion(
    "checkout",
    {
      id: "v1",
      policy: { lists: [{ ip: "203.0.113.0/24", action: "block" }] },
      createdBy: "ann",
    },
    null,
  );
  checkEqual("v1 appended", v1.ok, true);
  let failing = false;
  const warnings: SecurityWarning[] = [];
  // The engine reads through a store that fails while `failing` is set.
  const followed = faultyStore(sqliteStore({ path }), {
    fail: () => (failing ? new Error("disk gone") : undefined),
  });
  const security = createSecurity({
    policy: { store: followed, id: "checkout", pollIntervalMs: 50 },
    onWarning: (warning) => warnings.push(warning),
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
  step(
    "two operators publish on v1: the first wins, the second is told the head moved",
  );
  const ann = await store.appendVersion(
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
  const bob = await store.appendVersion(
    "checkout",
    { id: "v2-bob", policy: {}, createdBy: "bob" },
    "v1",
  );
  show("ann", ann);
  show("bob", bob);
  checkEqual("ann's append", ann.ok, true);
  checkEqual("bob's is refused", bob.ok, false);

  /* ------------------------------------------------------------------ */
  step("the engine follows the head");
  await waitFor(
    "v2 to load",
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
  step("the store fails: nothing changes, one warning");
  failing = true;
  await waitFor("the unavailable warning", () =>
    warnings.some((w) => w.kind === "policy.unavailable"),
  );
  checkEqual("still v2", security.status().policySource?.version, "v2");
  checkEqual(
    "still enforced",
    (await security.evaluate(facts("203.0.113.9"))).action,
    "block",
  );
  check(
    "unavailable in status()",
    security.status().policySource?.unavailable === true,
  );
  failing = false;

  security.close();
  await followed.close();
  await store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

summary();
