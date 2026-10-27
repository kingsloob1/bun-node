/**
 * Typed and validated — a schema for the keys' value types, and `validate`
 * (bun-validate's V10) checking stored values on read.
 *
 * ```bash
 * bun 03-typed/validated.ts
 * ```
 *
 * - `createCache<Schema>` types every key's reads and writes, template
 *   patterns included; `increment` accepts only number-valued keys.
 * - `validate: { "user:*": UserSchema }` checks values on read with any
 *   Standard Schema. A stored value that fails — written by an older deploy,
 *   or by a service with a looser shape — is a miss, is deleted, and fires an
 *   `error` event whose issues target `"cache"`.
 * - The cache's type can be inferred from `validate` alone
 *   (`CacheSchemaFrom`).
 */
import { z } from "zod";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("typed caches and runtime-checked reads");

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  role: z.string().default("member"),
});

/* ------------------------------------------------------------------ */
step("a typed cache");

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- a type alias, not an interface: an interface has no implicit index signature, so it would not satisfy the schema constraint
type Schema = {
  [k: `user:${number}`]: z.output<typeof UserSchema>;
  [k: `hits:${string}`]: number;
};
const typed = createCache<Schema>({ driver: memoryDriver() });

await typed.set("user:42", { id: 42, name: "Ada", role: "admin" });
const user = await typed.get("user:42");
show("user:42", user);
checkEqual("typed read", user?.name, "Ada");
// `await typed.get("usr:42")` and `typed.increment("user:42")` are type
// errors; `typed.increment("hits:/home")` is not.

/* ------------------------------------------------------------------ */
step("validate: a failing value is a miss plus an error event");

// The type comes from the validate map (CacheSchemaFrom): no explicit Schema.
const cache = createCache({
  driver: memoryDriver(),
  validate: { "user:*": UserSchema },
});

cache.on("error", (event) => {
  if (event.phase === "validate") {
    show("a stored value failed its schema", {
      key: event.key,
      issues: event.issues?.map(
        (issue) => `${issue.target}.${issue.path}: ${issue.message}`,
      ),
    });
  }
});

await cache.set("user:1", { id: 1, name: "Ada", role: "admin" });
check(
  "a passing read returns the value",
  (await cache.get("user:1")) !== undefined,
);

// An older deploy, or a looser writer, left this one behind:
const driver = memoryDriver();
const older = createCache({ driver });
await older.set("user:2", { id: "not-a-number", name: "Grace" });
const checking = createCache({ driver, validate: { "user:*": UserSchema } });
checkEqual("a failing read is a miss", await checking.get("user:2"), undefined);
checkEqual(
  "…and the bad entry was deleted",
  await older.get("user:2"),
  undefined,
);

/* ------------------------------------------------------------------ */
step("the schema's output is what a read returns");

// `role` defaults to "member" in the schema; the stored value lacked it.
await older.set("user:3", { id: 3, name: "Lin" });
checkEqual(
  "the default was applied on read",
  (await checking.get("user:3"))?.role,
  "member",
);

summary();
await typed.close();
await cache.close();
await older.close();
await checking.close();
