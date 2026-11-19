/**
 * One service's enforcement point in its own process, for `fleet.ts`: an
 * engine kept current by `connectAgent` (`./agent`) over real HTTP.
 *
 * Its configuration is one JSON argument: `{ url, agent, secret, service,
 * publicKey, stateFile, fleetSecret }`. It sends `{ ready: true, status }`
 * once its last known good is in (or it has none), then answers each request
 * `{ id, op, ... }` over IPC: `status` (the agent's), `evaluate` (`{ client }`:
 * the engine's action for a request from that address), `close`.
 *
 * Polls are hourly, so a change that arrives within `fleet.ts`'s wait came
 * through the control plane's nudge.
 */
import process from "node:process";
import { createSecurity } from "@kingsleyweb/bun-security";
import { connectAgent } from "@kingsleyweb/bun-security/agent";
import { facts } from "../../shared/facts";

/** The process's configuration. */
interface Config {
  /** The control plane's API base URL. */
  readonly url: string;
  /** The agent's id, as the control plane registered it. */
  readonly agent: string;
  /** The agent's secret, as `POST /agents` answered it once. */
  readonly secret: string;
  /** The service this enforcement point protects. */
  readonly service: string;
  /** The bundles' public key (PEM), by key id `sk_example`. */
  readonly publicKey: string;
  /** Where the last known good lives. */
  readonly stateFile: string;
  /** The fleet's shared engine secret (ban subjects are keyed by it). */
  readonly fleetSecret: string;
}

/** A request from `fleet.ts`. */
type Request =
  | { id: number; op: "evaluate"; client: string }
  | { id: number; op: "status" | "close" };

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const security = createSecurity({
  secret: config.fleetSecret,
  policy: { service: config.service },
  logger: () => {},
});
const agent = connectAgent({
  url: config.url,
  agent: config.agent,
  secret: config.secret,
  service: config.service,
  publicKeys: { sk_example: config.publicKey },
  security,
  stateFile: config.stateFile,
  pollInterval: "1h",
  banPollInterval: "1h",
  reconcileInterval: "1h",
  heartbeatInterval: "1h",
  nudge: true,
  logger: () => {},
});
await agent.ready;
await security.ready();

process.on("message", (message: Request) => {
  void (async () => {
    switch (message.op) {
      case "status":
        process.send?.({ id: message.id, status: agent.status() });
        return;
      case "evaluate":
        process.send?.({
          id: message.id,
          action: (await security.evaluate(facts(message.client))).action,
        });
        return;
      case "close":
        await agent.close();
        security.close();
        process.send?.({ id: message.id });
        process.exit(0);
    }
  })();
});
process.send?.({ ready: true, status: agent.status() });
