/**
 * A process a summoner started, for `summon-routes.ts`: it builds the same
 * `BunJobs` (one summon policy, for `reports`) and the same management API
 * as the parent, the way a config module shared with the worker would, and
 * asks its own `GET /summon`.
 *
 * The parent runs it with a `--bun-jobs-summon-id=` argument, so its
 * controller is **inert**: a summoned process must never summon more
 * workers. The namespace and driver config arrive through the environment.
 *
 * It prints one JSON line: the list's controllers, whether the controller is
 * inert, what a check did, and whether its summoner was ever called. Not
 * meant to be run on its own.
 */
import type { DriverConfig, SummonListDto } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, defineSummoner } from "@kingsleyweb/bun-jobs";

let called = false;
const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  logger: noopLogger,
  summon: {
    reports: {
      summoner: defineSummoner({
        kind: "example-record",
        invoke: async () => {
          called = true;
          return { status: "started", handles: [] };
        },
      }),
      triggers: { onAdd: false, events: false, poll: false },
    },
  },
});
const controller = jobs.summonController("reports");
const check = await controller.check();

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  authorize: () => true,
});
const adapter = new BunHttpAdapter(0);
adapter.use(api.basePath, api.router);
const response = await adapter.fetch(`${api.basePath}/summon`);
const list = (await response.json()) as SummonListDto;

console.log(
  JSON.stringify({
    status: response.status,
    controllers: list.controllers,
    inert: controller.inert,
    check,
    called,
  }),
);
await api.close();
await adapter.close();
await jobs.close();
