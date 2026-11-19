/**
 * One host, three APIs (topology (b), plan §11.6 `02-one-host`): `accounts`,
 * `shop` and `partner`, each a `Bun.serve` behind `withSecurity` in a
 * process of its own, sharing bans and counts through one Redis
 * (`cacheStore`), with a service identity between shop and accounts.
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/15 bun 19-one-host/one-host.ts
 * ```
 *
 * - It runs when `EXAMPLE_REDIS_URL` is set and otherwise prints `skipped:`
 *   and exits 0. A URL that is set but unreachable fails.
 * - Accounts bans an address: shop and partner refuse it too, the ban
 *   announced on Redis pub/sub. A lift from accounts reaches both as well.
 * - Shop calls accounts' internal route for its end users. With its service
 *   token, shop's call is a verified service call: exempt from lists, bans,
 *   counted rules and limits, except a limit marked `appliesToServices`,
 *   which counts the end user shop names (`x-service-client-ip`) as the
 *   client. So six users' calls all pass accounts' 3-a-minute limit, and one
 *   user calling again is refused past its own 3. The negative control: the
 *   same calls without the token are shop's own, counted against shop's
 *   address, and the fourth is refused.
 * - Every server listens on `127.0.0.1`, port 0, trusting the loopback proxy:
 *   each request names its client in `X-Forwarded-For`.
 * - Every key lives under the prefix `bun-security-example:<pid>:`, and the
 *   example deletes exactly the keys that prefix names (a `SCAN` of it,
 *   never `FLUSHDB`) at the end, even when a check failed.
 */
import { join } from "node:path";
import process from "node:process";
import { RedisClient } from "bun";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const url = process.env.EXAMPLE_REDIS_URL;
if (!url) {
  console.log(
    "skipped: set EXAMPLE_REDIS_URL (for instance redis://127.0.0.1:6379/15) to run this example",
  );
  process.exit(0);
}

title("one host, three APIs on one Redis");

/** This run's key prefix: it names the process, so a run owns its keys. */
const prefix = `bun-security-example:${process.pid}:`;
const SERVICE = join(import.meta.dir, "helpers", "service.ts");
const SHOP_TOKEN = "shop-api-token-0123456789abcdef";

// No reconnecting: an unreachable server fails at once, where the default
// client retries for about 30 s before giving up.
const raw = new RedisClient(url, {
  autoReconnect: false,
  connectionTimeout: 5000,
});
try {
  await raw.connect();
  await raw.send("PING", []);
} catch (error) {
  raw.close();
  throw new Error("EXAMPLE_REDIS_URL is set but unreachable", { cause: error });
}

/** Every key this run created: a `SCAN` of exactly its prefix. */
async function keysOfRun(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = (await raw.send("SCAN", [
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "500",
    ])) as [string, string[]];
    found.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

/** An API process, driven over IPC. */
interface Api {
  /** Its base URL. */
  readonly url: string;
  /** Asks it something and waits for its answer. */
  readonly ask: (request: Record<string, unknown>) => Promise<void>;
  /** Closes it and waits for it to exit. */
  readonly close: () => Promise<void>;
}

/** Every process started, so the end can close the ones still running. */
const started: ReturnType<typeof Bun.spawn>[] = [];

/** Starts one API and waits until it listens. */
async function startApi(config: Record<string, unknown>): Promise<Api> {
  let next = 0;
  const waiting = new Map<number, () => void>();
  let ready: (url: string) => void = () => {};
  const listening = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      SERVICE,
      JSON.stringify({ url, prefix, shopToken: SHOP_TOKEN, ...config }),
    ],
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: Record<string, unknown>) {
      if (message.ready === true) {
        ready(message.url as string);
        return;
      }
      waiting.get(message.id as number)?.();
      waiting.delete(message.id as number);
    },
  });
  started.push(child);
  const base = await Promise.race([
    listening,
    child.exited.then((code): never => {
      throw new Error(`${String(config.name)} exited with ${code}`);
    }),
  ]);
  const ask = (request: Record<string, unknown>) =>
    new Promise<void>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.send({ ...request, id });
    });
  return {
    url: base,
    ask,
    close: async () => {
      if (child.exitCode !== null) return;
      await ask({ op: "close" });
      await child.exited;
    },
  };
}

/** A request to `api` from `client`, as the proxy in front forwards it: the status. */
async function from(api: Api, client: string, path = "/"): Promise<number> {
  const response = await fetch(`${api.url}${path}`, {
    headers: { "x-forwarded-for": client },
  });
  await response.text();
  return response.status;
}

const apis: Api[] = [];
try {
  const accounts = await startApi({ name: "accounts" });
  const shop = await startApi({ name: "shop", accounts: accounts.url });
  const partner = await startApi({ name: "partner" });
  apis.push(accounts, shop, partner);

  /* ------------------------------------------------------------------ */
  step("accounts bans an address: shop and partner refuse it too");
  const MALLORY = "203.0.113.9";
  checkEqual(
    "before: all three answer",
    await Promise.all(apis.map((api) => from(api, MALLORY))),
    [200, 200, 200],
  );
  await accounts.ask({ op: "ban", ip: MALLORY });
  await waitFor("the ban on all three", async () =>
    (await Promise.all(apis.map((api) => from(api, MALLORY)))).every(
      (status) => status === 403,
    ),
  );
  checkEqual(
    "after: all three refuse it",
    await Promise.all(apis.map((api) => from(api, MALLORY))),
    [403, 403, 403],
  );
  checkEqual(
    "another client still served",
    await from(partner, "198.51.100.4"),
    200,
  );

  /* ------------------------------------------------------------------ */
  step("shop calls accounts for six end users, with its service token");
  const users = Array.from({ length: 6 }, (_, i) => `198.51.100.${20 + i}`);
  const withToken: number[] = [];
  for (const user of users)
    withToken.push(await from(shop, user, "/profile?token=1"));
  show("accounts' answers", withToken);
  checkEqual(
    "each user counted as itself: all six pass the 3-a-minute limit",
    withToken,
    [200, 200, 200, 200, 200, 200],
  );
  const repeat: number[] = [];
  for (let i = 0; i < 4; i++)
    repeat.push(await from(shop, users[0], "/profile?token=1"));
  checkEqual(
    "one user calling again is counted as that user: refused past 3",
    repeat,
    [200, 200, 429, 429],
  );

  /* ------------------------------------------------------------------ */
  step("the negative control: the same calls without the token are shop's own");
  const users2 = Array.from({ length: 6 }, (_, i) => `198.51.100.${40 + i}`);
  const without: number[] = [];
  for (const user of users2) without.push(await from(shop, user, "/profile"));
  show("accounts' answers", without);
  checkEqual(
    "counted against shop's address: the fourth is refused",
    without,
    [200, 200, 200, 429, 429, 429],
  );

  /* ------------------------------------------------------------------ */
  step("accounts lifts the ban: shop and partner serve the address again");
  await accounts.ask({ op: "unban", ip: MALLORY });
  await waitFor("the lift on all three", async () =>
    (await Promise.all(apis.map((api) => from(api, MALLORY)))).every(
      (status) => status === 200,
    ),
  );
  checkEqual(
    "all three answer again",
    await Promise.all(apis.map((api) => from(api, MALLORY))),
    [200, 200, 200],
  );
} finally {
  for (const api of apis) await api.close().catch(() => undefined);
  for (const child of started) if (child.exitCode === null) child.kill();
  const keys = await keysOfRun();
  show("keys this run wrote, now deleted", keys.length);
  if (keys.length > 0) await raw.send("DEL", keys);
  raw.close();
}

summary();
