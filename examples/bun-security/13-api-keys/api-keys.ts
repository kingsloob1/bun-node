/**
 * API keys: per-plan limits, the many-addresses anomaly that suspends a
 * leaked key, `onKeyCompromised` for revoking it, and `revokeApiKey()`.
 *
 * ```bash
 * bun 13-api-keys/api-keys.ts
 * ```
 *
 * - bun-security never issues or stores keys. `identify()` names the key's
 *   **id** (never the key), its plan, and optionally its own address limit.
 * - Everything the engine keeps about a key is keyed by `HMAC(secret, id)`:
 *   a ban's subject is a hash, never the id. List entries and
 *   `ban({ apiKey })` still take the id.
 * - `apiKeys.manyAddresses`: a key used from more than `limit` distinct
 *   addresses in `window` (20 an hour by default). `ban` suspends it and
 *   calls `onKeyCompromised`; `tag` (the default) only marks its requests.
 *   `newAsn` (a key used from a network it never used) needs an ASN
 *   database, so it is not shown here.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import type { KeyCompromise } from "@kingsleyweb/bun-security";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("API keys");

const compromised: KeyCompromise[] = [];
const clock = fakeClock();
const security = createSecurity({
  policy: {
    limits: [
      { id: "free", limit: 3, window: "1m", key: "apiKey", apiKeyPlan: "free" },
      { id: "pro", limit: 100, window: "1m", key: "apiKey", apiKeyPlan: "pro" },
    ],
    apiKeys: {
      manyAddresses: { limit: 5, window: "1h", action: "ban", duration: "2h" },
    },
    lists: [
      { apiKey: "key_old_partner", action: "block", reason: "contract ended" },
    ],
  },
  secret: "an-example-secret-of-at-least-32-bytes!",
  onKeyCompromised: (event) => compromised.push(event),
  now: clock.now,
  logger: () => {},
});

/** A call with key `apiKey` on `plan` from `client`. */
const call = async (apiKey: string, plan: string, client = "198.51.100.1") =>
  security.evaluate(
    facts(client, {
      path: "/v1/orders",
      identity: { apiKey, apiKeyPlan: plan },
    }),
  );

/* ------------------------------------------------------------------ */
step("a plan's limit counts only keys on that plan");
const free: (number | undefined)[] = [];
for (let i = 0; i < 4; i++)
  free.push((await call("key_free_1", "free")).status);
show("a free key, four calls", free);
checkEqual("the fourth is 429", free.at(-1), 429);
const pro = await call("key_pro_1", "pro");
checkEqual(
  "a pro key from the same address is not counted by the free limit",
  pro.action,
  "allow",
);

/* ------------------------------------------------------------------ */
step("a list entry names a key by its id");
checkEqual(
  "the old partner's key is refused",
  (await call("key_old_partner", "pro")).action,
  "block",
);

/* ------------------------------------------------------------------ */
step("a leaked key: used from many addresses, suspended");
const leaked: string[] = [];
for (let i = 1; i <= 7; i++)
  leaked.push((await call("key_leaked", "pro", `203.0.113.${i}`)).action);
show("seven addresses", leaked);
checkEqual("five served, then the key itself banned", leaked, [
  "allow",
  "allow",
  "allow",
  "allow",
  "allow",
  "ban",
  "ban",
]);
checkEqual(
  "…from any address",
  (await call("key_leaked", "pro", "198.51.100.9")).action,
  "ban",
);
show(
  "onKeyCompromised",
  compromised.map((c) => ({ reason: c.reason, apiKey: c.apiKey })),
);
checkEqual(
  "your hook was called once, with the key's id",
  compromised.map((c) => [c.reason, c.apiKey]),
  [["apiKey.manyAddresses", "key_leaked"]],
);
const ban = security.bans().find((b) => b.subject.type === "apiKey");
show("the ban's subject", ban?.subject);
check(
  "keyed by its HMAC, never the id",
  ban !== undefined && !JSON.stringify(ban).includes("key_leaked"),
  ban,
);

/* ------------------------------------------------------------------ */
step("revokeApiKey(): the app revokes a key, the engine covers the gap");
security.revokeApiKey("key_pro_1", { reason: "owner asked", by: "support" });
checkEqual("refused at once", (await call("key_pro_1", "pro")).action, "ban");
checkEqual("…and your hook heard it", compromised.at(-1)?.reason, "revoked");

security.close();
summary();
