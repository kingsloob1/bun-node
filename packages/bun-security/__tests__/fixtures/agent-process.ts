/**
 * One service's agent in its own process, for the topology (c) suite
 * (`__tests__/topology/c.test.ts`, plan §11.4): an engine on the fleet's
 * secret kept current by `connectAgent` over real HTTP, with CP1's ring
 * and recorder for its events.
 *
 * Its configuration is one JSON argument: `{ url, agent, secret, service,
 * publicKey, stateFile, fleetSecret, poll, banPoll, nudge }`. It sends
 * `{ ready: true }` once its last known good is in, then answers each
 * request `{ id, op, ... }` over IPC: `status`, `bans` (the engine's ban
 * subjects), `evaluate` (`{ client }`: the action), `offer` (`{ client }`:
 * a decision evaluated and offered to the ring), `flush` (the batcher, at
 * once), `close`.
 */
import process from "node:process";
import {
  createAnalyticsRecorder,
  createEventRing,
} from "../../lib/analytics/index";
import { connectAgent } from "../../lib/agent/index";
import { createSecurity } from "../../lib/index";
import { facts } from "../helpers";

/** The process's configuration. */
interface Config {
  readonly url: string;
  readonly agent: string;
  readonly secret: string;
  readonly service: string;
  readonly publicKey: string;
  readonly stateFile: string;
  readonly fleetSecret: string;
  readonly poll: string;
  readonly banPoll: string;
  readonly nudge: boolean;
}

/** A request from the test. */
type Request =
  | { id: number; op: "evaluate" | "offer"; client: string }
  | { id: number; op: "status" | "bans" | "flush" | "close" };

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const security = createSecurity({
  secret: config.fleetSecret,
  policy: { service: config.service },
  logger: () => {},
});
const recorder = createAnalyticsRecorder({ service: config.service });
const ring = createEventRing({
  service: config.service,
  recorder,
  sampleAllows: 0,
});
const agent = connectAgent({
  url: config.url,
  agent: config.agent,
  secret: config.secret,
  service: config.service,
  publicKeys: { sk_topology: config.publicKey },
  security,
  stateFile: config.stateFile,
  pollInterval: config.poll,
  banPollInterval: config.banPoll,
  reconcileInterval: "1h",
  heartbeatInterval: "1h",
  nudge: config.nudge,
  events: { ring, recorder },
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
      case "bans":
        process.send?.({
          id: message.id,
          bans: security.bans().map((ban) => ban.subject.value),
        });
        return;
      case "evaluate":
        process.send?.({
          id: message.id,
          action: (await security.evaluate(facts({ client: message.client })))
            .action,
        });
        return;
      case "offer": {
        const decision = await security.evaluate(
          facts({ client: message.client }),
        );
        process.send?.({
          id: message.id,
          offered: ring.offer(decision),
          action: decision.action,
        });
        return;
      }
      case "flush":
        await agent.events?.flush();
        process.send?.({ id: message.id, queued: agent.events?.queued() ?? 0 });
        return;
      case "close":
        await agent.close();
        await security.close();
        process.send?.({ id: message.id });
        process.exit(0);
    }
  })();
});
process.send?.({ ready: true });
