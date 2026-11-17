/**
 * A policy from a file (GitOps): the engine follows a reviewed JSON file,
 * refuses a broken edit and keeps the last good policy, and on a restart
 * reads the last good policy back from disk.
 *
 * ```bash
 * bun 15-policy/policy-file.ts
 * ```
 *
 * - `createSecurity({ policy: { store: policyFile(path), lastKnownGood } })`
 *   loads the file and watches it. `ready()` resolves once it was read.
 * - A version that does not compile is never swapped in: the last good
 *   policy stays in force, and one `policy.refused` warning is raised.
 * - `lastKnownGood`: every accepted policy is written there (atomically,
 *   mode 0600) and read first at start, so a restart while the source is
 *   broken or missing enforces what was enforced before.
 * - The files are temporary ones, deleted at the end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecurity } from "@kingsleyweb/bun-security";
import type {
  SecurityPolicy,
  SecurityWarning,
} from "@kingsleyweb/bun-security";
import { policyFile } from "@kingsleyweb/bun-security/store";
import { checkEqual, summary } from "../shared/check";
import { facts } from "../shared/facts";
import { show, step, title, waitFor } from "../shared/console";

title("a policy from a file, with last-known-good");

const dir = mkdtempSync(join(tmpdir(), "bun-security-example-"));
const file = join(dir, "security.json");
const lkg = join(dir, "security.lkg.json");

/** Writes `policy` (or raw text) to the policy file. */
const write = (policy: SecurityPolicy | string) =>
  Bun.write(
    file,
    typeof policy === "string" ? policy : JSON.stringify(policy, null, 2),
  );

const warnings: SecurityWarning[] = [];
/** An engine following the file, with the last-known-good copy. */
const start = () =>
  createSecurity({
    policy: { store: policyFile(file, { debounceMs: 20 }), lastKnownGood: lkg },
    onWarning: (warning) => warnings.push(warning),
    logger: () => {},
  });

try {
  await write({ lists: [{ ip: "203.0.113.0/24", action: "block" }] });
  const security = start();
  await security.ready();

  /* ------------------------------------------------------------------ */
  step("the file's policy is in force");
  checkEqual(
    "203.0.113.9 blocked",
    (await security.evaluate(facts("203.0.113.9"))).action,
    "block",
  );
  show("policySource", security.status().policySource);

  /* ------------------------------------------------------------------ */
  step("an edit is followed");
  await write({
    lists: [
      { ip: "203.0.113.0/24", action: "block" },
      { ip: "198.51.100.66", action: "block" },
    ],
  });
  await waitFor(
    "the edit to load",
    async () =>
      (await security.evaluate(facts("198.51.100.66"))).action === "block",
  );
  checkEqual(
    "the new entry applies",
    (await security.evaluate(facts("198.51.100.66"))).action,
    "block",
  );

  /* ------------------------------------------------------------------ */
  step("a broken edit is refused; the last good policy stays");
  await write({ lists: [{ ip: "not-an-address", action: "block" }] });
  await waitFor("the refusal", () =>
    warnings.some((w) => w.kind === "policy.refused"),
  );
  show("warning", warnings.find((w) => w.kind === "policy.refused")?.message);
  checkEqual(
    "still enforced",
    (await security.evaluate(facts("198.51.100.66"))).action,
    "block",
  );
  checkEqual(
    "the refusal is in status()",
    security.status().policySource?.refused !== undefined,
    true,
  );
  security.close();

  /* ------------------------------------------------------------------ */
  step("a restart while the file is broken: the last good policy from disk");
  await write("{ this is not json");
  const restarted = start();
  await restarted.ready();
  show("policySource", restarted.status().policySource);
  checkEqual(
    "from last-known-good",
    restarted.status().policySource?.fromLastKnownGood,
    true,
  );
  checkEqual(
    "…enforcing what was enforced before",
    (await restarted.evaluate(facts("198.51.100.66"))).action,
    "block",
  );
  restarted.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

summary();
