/**
 * Groups, inheritance and signed bundles: what the control plane computes
 * for each service, done by hand with its own functions.
 *
 * ```bash
 * bun 20-control/bundles-and-groups.ts
 * ```
 *
 * - **A service's effective policy** is global ← its groups, outermost
 *   first ← its own (`mergePolicies`): objects merge by key, limits, rules
 *   and list entries by `id`, lists union. Each field's origin comes back in
 *   `origins`.
 * - **`locked: true`** on an item: no scope below may change it. A lower
 *   scope's override is dropped and named in `locked`; `locks` says which
 *   scope locked each item.
 * - **`diffPolicies`** compares two policies field by field, keyed items
 *   matched by `id` (a reordered list is no change).
 * - **`dangerousChanges`** names what needs a confirmation or a second
 *   operator on a production service: a rule from dry run to enforced, an
 *   action raised, an allow entry added or widened.
 * - **A bundle** is the effective policy signed with Ed25519
 *   (`signBundle`); an enforcement point checks it with `verifyBundle`
 *   against the public keys it was deployed with, and refuses a tampered
 *   one, another service's, an older one (a replay) and an unknown key.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyBundle } from "@kingsleyweb/bun-security";
import type { SecurityBundle } from "@kingsleyweb/bun-security";
import {
  bundlePublicKey,
  dangerousChanges,
  diffPolicies,
  mergePolicies,
  signBundle,
} from "@kingsleyweb/bun-security/control";
import type { ResolvedSigner } from "@kingsleyweb/bun-security/control";
import { BUNDLE_FORMAT } from "@kingsleyweb/bun-security/control/contract";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("groups, inheritance, signed bundles");

/* ------------------------------------------------------------------ */
step("global ← group:payments ← service:checkout, with a locked limit");

const global = {
  limits: [
    { id: "per-ip", limit: 300, window: "1m", locked: true },
    { id: "search", limit: 60, window: "1m", routes: ["GET /search"] },
  ],
  lists: [{ id: "scanners", ip: "203.0.113.0/24", action: "block" }],
};
const payments = {
  // Tries to loosen the locked limit: dropped, and named.
  limits: [
    { id: "per-ip", limit: 10_000, window: "1m" },
    { id: "card-tests", limit: 5, window: "10m", routes: ["POST /pay"] },
  ],
};
const checkout = {
  // Tightens an inherited, unlocked limit, and turns nothing else off.
  limits: [{ id: "search", limit: 20, window: "1m", routes: ["GET /search"] }],
  lists: [{ id: "office", ip: "198.51.100.0/24", action: "allow" }],
};

const merged = mergePolicies([
  { scope: "global", policy: global },
  { scope: "group:payments", policy: payments },
  { scope: "service:checkout", policy: checkout },
]);
show("effective limits", merged.policy.limits);
const limits = merged.policy.limits as { id: string; limit: number }[];
checkEqual(
  "the locked limit keeps global's value",
  limits.find((l) => l.id === "per-ip")?.limit,
  300,
);
checkEqual("the group's override of it is dropped, and named", merged.locked, [
  {
    path: "limits[id=per-ip]",
    lockedBy: "global",
    scope: "group:payments",
  },
]);
checkEqual("locks: who locked what", merged.locks, {
  "limits[id=per-ip]": "global",
});
checkEqual(
  "the service's own value wins where nothing is locked",
  limits.find((l) => l.id === "search")?.limit,
  20,
);
checkEqual(
  "the group's own limit is inherited",
  limits.find((l) => l.id === "card-tests")?.limit,
  5,
);
checkEqual(
  "each item's origin",
  [
    merged.origins["limits[id=per-ip]"],
    merged.origins["limits[id=card-tests]"],
    merged.origins["limits[id=search]"],
  ],
  ["global", "group:payments", "service:checkout"],
);
checkEqual(
  "lists union across the scopes",
  (merged.policy.lists as { id: string }[]).map((l) => l.id).sort(),
  ["office", "scanners"],
);

/* ------------------------------------------------------------------ */
step("diffPolicies: what changed, keyed items matched by id");

const before = { limits: global.limits, lists: global.lists };
const after = {
  // Reordered (no change) and one value changed.
  limits: [
    { id: "search", limit: 30, window: "1m", routes: ["GET /search"] },
    { id: "per-ip", limit: 300, window: "1m", locked: true },
  ],
  lists: global.lists,
};
const changes = diffPolicies(before, after);
show("changes", changes);
checkEqual("one change, named by its path", changes, [
  { path: "limits[id=search].limit", before: 60, after: 30 },
]);
checkEqual(
  "a policy against itself: nothing",
  diffPolicies(before, before),
  [],
);

/* ------------------------------------------------------------------ */
step("dangerousChanges on a production service");

const dryRun = {
  limits: [{ id: "x", limit: 10, window: "1m", mode: "dryRun" }],
  lists: [{ id: "office", ip: "198.51.100.0/25", action: "allow" }],
};
const enforced = {
  limits: [{ id: "x", limit: 10, window: "1m", action: "ban" }],
  lists: [{ id: "office", ip: "198.51.100.0/24", action: "allow" }],
};
const dangerous = dangerousChanges(dryRun, enforced, true);
show("dangerous", dangerous);
check(
  "a rule from dry run to enforced",
  dangerous.some((line) => line.startsWith("limits[id=x]: from dry run")),
  dangerous,
);
check(
  "an allow entry widened from /25 to /24",
  dangerous.some((line) => line.includes("widened from /25 to /24")),
  dangerous,
);
checkEqual(
  "the same change on a service that is not production: only the widening",
  dangerousChanges(dryRun, enforced, false).length,
  1,
);

/* ------------------------------------------------------------------ */
step("a signed bundle, and what an enforcement point refuses");

const { privateKey } = generateKeyPairSync("ed25519");
const signer: ResolvedSigner = {
  keyId: "sk_2026_11",
  sign: (bytes) =>
    Promise.resolve(new Uint8Array(sign(null, bytes, privateKey))),
};
const keys = { sk_2026_11: bundlePublicKey(privateKey) };
const now = Date.UTC(2026, 10, 19, 12);
const bundle = await signBundle(
  {
    format: BUNDLE_FORMAT,
    service: "checkout",
    version: 7,
    policyVersions: ["global@3", "group:payments@2", "service:checkout@5"],
    compiledAt: new Date(now).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
    effective: merged.policy,
    artefacts: [],
  },
  signer,
);
show("signature", bundle.signature);
const verdict = verifyBundle(bundle, keys, {
  service: "checkout",
  after: 6,
  now: () => now,
});
checkEqual("it verifies", verdict.ok, true);

/** A copy of the bundle with `change` made to it. */
const changed = (change: Partial<SecurityBundle>): unknown => ({
  ...structuredClone(bundle),
  ...change,
});
const refusal = (value: unknown, options = {}) => {
  const result = verifyBundle(value, keys, { now: () => now, ...options });
  return result.ok ? "accepted" : result.reason;
};
checkEqual(
  "a tampered policy (the per-ip limit raised) is refused",
  refusal(
    changed({
      effective: {
        ...bundle.effective,
        limits: [{ id: "per-ip", limit: 1_000_000, window: "1m" }],
      },
    }),
  ),
  "signature",
);
checkEqual(
  "another service's bundle",
  refusal(bundle, { service: "search" }),
  "wrong-service",
);
checkEqual(
  "one not newer than the version loaded (a replay)",
  refusal(bundle, { service: "checkout", after: 7 }),
  "replayed",
);
checkEqual(
  "a key the EP was not deployed with",
  refusal(bundle, { service: "checkout" }) === "accepted"
    ? (() => {
        const result = verifyBundle(
          bundle,
          { sk_other: keys.sk_2026_11 },
          {
            now: () => now,
          },
        );
        return result.ok ? "accepted" : result.reason;
      })()
    : "the control failed",
  "unknown-key",
);
const early = await signBundle(
  {
    ...bundle,
    version: 8,
    notBefore: new Date(now + 3_600_000).toISOString(),
  },
  signer,
);
checkEqual("one signed to start in an hour", refusal(early), "not-yet-valid");

summary();
