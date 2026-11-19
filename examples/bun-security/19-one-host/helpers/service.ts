/**
 * One API of `one-host.ts` in its own process: a `Bun.serve` behind
 * `withSecurity`, its engine sharing bans and counts with the other two
 * through a `cacheStore` over one Redis.
 *
 * Its configuration is one JSON argument: `{ name, url, prefix, accounts?,
 * shopToken }`. It listens on `127.0.0.1`, port 0, trusting the loopback
 * proxy (`X-Forwarded-For` names the client), and sends `{ ready: true,
 * url }`; then answers each request `{ id, op, ... }` over IPC: `ban`
 * (`{ ip }`: a ban by hand, from this process), `unban` (`{ ip }`), `close`.
 *
 * - `accounts` trusts `shop` as a service identity (its token's SHA-256),
 *   which forwards its end user in `x-service-client-ip`, and limits each
 *   client to 3 requests a minute, service calls included
 *   (`appliesToServices`).
 * - `shop`'s `/profile` calls accounts' `/internal/me` for its end user,
 *   with its token when `?token=1`, and answers accounts' status.
 */
import { createHash } from "node:crypto";
import process from "node:process";
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { SecurityPolicy } from "@kingsleyweb/bun-security";
import { withSecurity } from "@kingsleyweb/bun-security/serve";
import { cacheStore } from "@kingsleyweb/bun-security/stores";

/** The process's configuration. */
interface Config {
  /** The API's name: `accounts`, `shop` or `partner`. */
  readonly name: string;
  /** The Redis URL all three share. */
  readonly url: string;
  /** This run's key prefix. */
  readonly prefix: string;
  /** Accounts' base URL, for shop's call. */
  readonly accounts?: string;
  /** Shop's service token: in real life, a secret from its environment. */
  readonly shopToken: string;
}

/** A request from `one-host.ts`. */
type Request =
  { id: number; op: "ban" | "unban"; ip: string } | { id: number; op: "close" };

/** Where shop's own requests come from, as accounts' proxy sees them. */
const SHOP_EGRESS = "192.0.2.10";

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const driver = redisDriver({ url: config.url, prefix: config.prefix });
const store = cacheStore(createCache({ driver, logger: () => {} }), {
  namespace: "bun-security-example",
  bus: driver,
  pollInterval: "200ms",
  logger: () => {},
});

const policy: SecurityPolicy =
  config.name === "accounts"
    ? {
        service: "accounts",
        limits: [
          // A verified service call is exempt from lists, bans, counted
          // rules and limits unless a limit says `appliesToServices`; this
          // one does, and so counts shop's calls by the end user it names.
          {
            id: "per-client",
            limit: 3,
            window: "1m",
            key: ["ip"],
            appliesToServices: true,
          },
        ],
        serviceIdentity: {
          services: [
            {
              id: "shop",
              verifier: `sha256:${createHash("sha256").update(config.shopToken).digest("hex")}`,
              forwardsClientIp: true,
            },
          ],
        },
      }
    : { service: config.name };

const security = createSecurity({
  policy,
  store,
  // Every process sharing a store keys usernames and API keys alike.
  secret: "the-fleet-secret-of-at-least-32-bytes!!",
  logger: () => {},
});
await security.ready();

/** Shop's call to accounts on its end user's behalf. */
async function callAccounts(
  endUser: string,
  withToken: boolean,
): Promise<Response> {
  const response = await fetch(`${config.accounts}/internal/me`, {
    headers: {
      // Shop's own address, as the proxy in front of accounts forwards it.
      "x-forwarded-for": SHOP_EGRESS,
      ...(withToken
        ? {
            "x-service-token": config.shopToken,
            "x-service-client-ip": endUser,
          }
        : {}),
    },
  });
  return new Response(await response.text(), { status: response.status });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: withSecurity(
    security,
    async (req) => {
      const url = new URL(req.url);
      if (config.name === "shop" && url.pathname === "/profile") {
        const endUser = req.headers.get("x-forwarded-for") ?? "";
        return await callAccounts(
          endUser,
          url.searchParams.get("token") === "1",
        );
      }
      return new Response(`${config.name}: ${url.pathname}`);
    },
    { trustProxy: "loopback", logger: () => {} },
  ),
});

process.on("message", (message: Request) => {
  void (async () => {
    switch (message.op) {
      case "ban":
        security.ban({ ip: message.ip, duration: "1h", by: config.name });
        await security.flush();
        process.send?.({ id: message.id });
        return;
      case "unban":
        security.unban(`ip:${message.ip}`, { by: config.name });
        await security.flush();
        process.send?.({ id: message.id });
        return;
      case "close":
        await server.stop(true);
        security.close();
        await security.flush();
        await store.close();
        await driver.close().catch(() => undefined);
        process.send?.({ id: message.id });
        process.exit(0);
    }
  })();
});
process.send?.({ ready: true, url: `http://127.0.0.1:${server.port}` });
