/**
 * The child half of `servers.test.ts`: a process of its own serving
 * bun-common's live invalidation on port 0, connected to the job's bus
 * (`cacheLiveBus(redisBus(…))` or `cacheLiveBus(pgBus(…))`) when it names
 * one, with two control routes
 * the test drives it by. It prints `{"port":…,"connectionName":…}` once
 * its bus subscription holds (at once when `waitReady` is false), and exits
 * when its stdin closes.
 *
 * - `POST /control/publish` `{ tags }`: one `publishTags(tags)`.
 * - `POST /control/sequence` `{ tags }`: one `publishTags([tag])` per tag,
 *   a macrotask apart, so they leave as separate bus messages where the bus
 *   is quick enough.
 */
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import type { LiveBusConnection } from "@kingsleyweb/bun-common/live";
import {
  connectLiveBus,
  liveInvalidation,
  publishTags,
} from "@kingsleyweb/bun-common/live";
import { pgBus, redisBus } from "../../lib/index";
import { cacheLiveBus } from "../../lib/live/index";

/** The job the parent passes on the command line, as JSON. */
export interface LiveWorkerJob {
  /** The bus's server. Default `"redis"`. */
  kind?: "redis" | "postgres";
  /** The URL of the bus's server; none: no bus. */
  url?: string;
  /** The bus's channel. */
  channel: string;
  /** Whether to print the ready line only once the subscription holds. Default true. */
  waitReady?: boolean;
}

/** What the child prints once it serves. */
export interface LiveWorkerReady {
  /** The port it serves on. */
  port: number;
  /** Its Redis bus subscriber connection's `CLIENT SETNAME`, when it has one. */
  connectionName?: string;
}

const job = JSON.parse(process.argv[2] ?? "{}") as LiveWorkerJob;
const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.use(
  liveInvalidation(adapter, { authorize: (_req, _res, next) => next() }),
);
adapter.post("/control/publish", (req, res) => {
  publishTags((req.body as { tags: string[] }).tags);
  void res.status(204).end();
});
adapter.post("/control/sequence", async (req, res) => {
  for (const tag of (req.body as { tags: string[] }).tags) {
    publishTags([tag]);
    await Bun.sleep(1);
  }
  void res.status(204).end();
});

let connection: LiveBusConnection | undefined;
let connectionName: string | undefined;
const bus =
  job.url === undefined
    ? undefined
    : job.kind === "postgres"
      ? pgBus({ url: job.url, channel: job.channel })
      : redisBus({ url: job.url, channel: job.channel });
if (bus !== undefined) {
  connectionName = (bus as unknown as { connectionName?: string })
    .connectionName;
  connection = connectLiveBus(cacheLiveBus(bus), { logger: noopLogger });
  if (job.waitReady !== false) await connection.ready;
}
const server = await adapter.listen(0);
const ready: LiveWorkerReady = {
  port: (server as { port: number }).port,
  ...(connectionName === undefined ? {} : { connectionName }),
};
await Bun.write(Bun.stdout, `${JSON.stringify(ready)}\n`);

// Until the parent closes stdin.
for await (const _chunk of Bun.stdin.stream()) {
  // Nothing is read; the loop ends with stdin.
}
await connection?.close();
await bus?.close();
await adapter.close();
process.exit(0);
