/**
 * One enforcement point in its own process, for the multi-process topology
 * tests (`__tests__/stores/multiprocess.test.ts`, plan §11.4): an engine on
 * a `cacheStore` over Redis, Postgres or a SQLite file, driven over IPC.
 *
 * Its configuration is one JSON argument: `{ backend: "redis" | "sqlite",
 * url, path, prefix, policy, store }`. It answers each request
 * `{ id, op, ... }` with `{ id, ... }`: `evaluate` (the decision's action),
 * `ban`, `unban`, `bans` (the ids), `status`, `flush`, `close`; `apiKey`
 * (a request with an API key: the action and tags) and `compromised` (what
 * `onKeyCompromised` was told here).
 */
import process from "node:process";
import {
  createCache,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { cacheStore } from "../../lib/stores/index";
import type { CacheStoreOptions } from "../../lib/stores/index";
import { facts } from "../helpers";

/** The process's configuration. */
interface Config {
  readonly backend: "redis" | "postgres" | "sqlite";
  readonly url?: string;
  readonly path?: string;
  readonly prefix: string;
  readonly policy: SecurityPolicy;
  readonly store: CacheStoreOptions;
  readonly secret?: string;
}

/** A request from the test. */
type Request =
  | { id: number; op: "evaluate"; client: string; path?: string }
  | { id: number; op: "ban"; ip: string }
  | { id: number; op: "unban"; ban: string }
  | {
      id: number;
      op: "login";
      username: string;
      client: string;
      outcome: "failure" | "success" | "none";
    }
  | { id: number; op: "apiKey"; client: string; apiKey: string }
  | { id: number; op: "bans" | "status" | "flush" | "close" | "compromised" };

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const driver =
  config.backend === "redis"
    ? redisDriver({ url: config.url, prefix: config.prefix })
    : config.backend === "postgres"
      ? postgresDriver({ url: config.url, prefix: config.prefix })
      : sqliteDriver({ path: config.path, prefix: config.prefix });
const quiet = (): void => {};
const store = cacheStore(createCache({ driver, logger: quiet }), {
  ...config.store,
  ...(driver.publish !== undefined && config.backend !== "sqlite"
    ? { bus: driver }
    : {}),
  logger: quiet,
});
/** The API keys `onKeyCompromised` was told of, in this process. */
const compromised: string[] = [];
const security = createSecurity({
  secret: config.secret ?? "the-multi-process-secret-of-32-bytes!",
  policy: config.policy,
  store,
  logger: quiet,
  onKeyCompromised: (event) =>
    compromised.push(`${event.apiKey}:${event.reason}`),
});
await security.ready();

process.on("message", (message: Request) => {
  const answer = async (): Promise<Record<string, unknown>> => {
    switch (message.op) {
      case "evaluate": {
        const path = message.path ?? "/";
        const decision = await security.evaluate(
          facts({ client: message.client, path, rawPath: path }),
        );
        return {
          action: decision.action,
          rules: decision.hits.map((h) => h.rule),
        };
      }
      case "login": {
        const request = facts({
          client: message.client,
          method: "POST",
          path: "/login",
          rawPath: "/login",
          routeKey: "POST /login",
          profile: "login",
          identity: { username: message.username },
        });
        const decision = await security.evaluate(request);
        const hits =
          message.outcome === "none"
            ? []
            : await security.signal(request, `auth.${message.outcome}`);
        return {
          action: decision.action,
          tags: decision.tags,
          hits: hits.map((hit) => `${hit.rule}:${hit.action}`),
        };
      }
      case "apiKey": {
        const path = "/api/orders";
        const request = facts({
          client: message.client,
          path,
          rawPath: path,
          routeKey: "GET /api/orders",
          identity: { apiKey: message.apiKey },
        });
        const decision = await security.evaluate(request);
        return { action: decision.action, tags: decision.tags };
      }
      case "compromised":
        return { compromised };
      case "ban":
        security.ban({ ip: message.ip, reason: "multiprocess" });
        await security.flush();
        return {};
      case "unban":
        security.unban(message.ban);
        await security.flush();
        return {};
      case "bans":
        return {
          bans: security
            .bans()
            .map((ban) => ban.id)
            .sort(),
          actions: security
            .bans()
            .map((ban) => `${ban.id}:${ban.action}`)
            .sort(),
        };
      case "status":
        return { store: security.status().state.store };
      case "flush":
        await security.flush();
        return {};
      case "close":
        security.close();
        await security.flush();
        await store.close();
        await driver.close();
        return {};
    }
  };
  answer().then(
    (body) => {
      process.send?.({ id: message.id, ...body });
      if (message.op === "close") process.exit(0);
    },
    (error: unknown) => {
      process.send?.({ id: message.id, error: String(error) });
    },
  );
});
process.send?.({ ready: true });
