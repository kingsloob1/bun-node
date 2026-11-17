/**
 * One control-plane instance in its own process, for the topology (c)
 * suite (`__tests__/topology/c.test.ts`, plan §11.4): `createSecurityApi`
 * over `postgresStore` (agents, bans, audit, break-glass), served by
 * `secureAdmin` on port 0. Operators are named by an `x-op` header.
 *
 * Its configuration is one JSON argument: `{ url, prefix, signingKey,
 * auditKey, fleetSecret, breakGlass? }`. It sends `{ ready: true, url }`
 * once listening, then answers each request `{ id, op, ... }` over IPC:
 * `die` (`{ on }`: the next call of that store operation exits the
 * process before it runs, as a crash would), `verifyAudit`, `close`.
 */
import process from "node:process";
import { createSecurityApi, secureAdmin } from "../../lib/control/index";
import { postgresStore } from "../../lib/store/index";
import type { StoreOperation } from "../../lib/testing/index";
import { faultyStore } from "../../lib/testing/index";

/** The process's configuration. */
interface Config {
  readonly url: string;
  readonly prefix: string;
  readonly signingKey: string;
  readonly auditKey: string;
  readonly fleetSecret: string;
  readonly breakGlass?: {
    readonly passwordHash: string;
    readonly totpSecret: string;
  };
}

/** A request from the test. */
type Request =
  | { id: number; op: "die"; on: StoreOperation }
  | { id: number; op: "verifyAudit" | "close" };

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
let dieOn: StoreOperation | undefined;
const store = faultyStore(
  postgresStore({ url: config.url, prefix: config.prefix, max: 4 }),
  {
    fail: (operation) => {
      // A crash in the middle: the process is gone before the operation runs.
      if (operation === dieOn) process.exit(70);
      return undefined;
    },
  },
);
await store.connect();
const api = createSecurityApi({
  store,
  authenticate: (req) => {
    const id = req.request.headers.get("x-op");
    return id === null ? null : { id };
  },
  owners: ["alice"],
  allowWithoutStepUp: true,
  signing: { keyId: "sk_topology", privateKey: config.signingKey },
  audit: {
    signing: { keyId: "ak_topology", privateKey: config.auditKey },
    allowNoExternalCheckpoints: true,
  },
  bans: { secret: config.fleetSecret },
  agents: {},
  // The repair pass every second, so a bundle a cut-off publish left
  // behind is caught up within the test's deadline (#847).
  bundleRepair: { interval: "1s" },
  ...(config.breakGlass === undefined ? {} : { breakGlass: config.breakGlass }),
  logger: () => {},
});
const admin = await secureAdmin({ port: 0, api, logger: () => {} });

process.on("message", (message: Request) => {
  void (async () => {
    switch (message.op) {
      case "die":
        dieOn = message.on;
        process.send?.({ id: message.id });
        return;
      case "verifyAudit":
        process.send?.({ id: message.id, verify: await api.verifyAudit() });
        return;
      case "close":
        await admin.close();
        await store.close();
        process.send?.({ id: message.id });
        process.exit(0);
    }
  })();
});
process.send?.({ ready: true, url: `${admin.url}${api.basePath}` });
