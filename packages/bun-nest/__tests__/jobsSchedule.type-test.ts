/**
 * What the types of `@Cron`, `@Every`, `registerRunner` and `@InjectRunner` catch.
 * Checked by `bun run check`; each `@ts-expect-error` is its own negative control
 * (TS2578 when unused).
 */
import type { BunRunner } from "@kingsleyweb/bun-jobs";
import { BunJobsModule, Cron, Every, InjectRunner } from "../lib/jobs/index";

Cron("0 3 * * *");
Cron("0 3 * * *", {
  name: "nightly",
  queue: "schedule",
  tz: "Europe/London",
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  timeout: 60_000,
  deadLetter: "dead",
  limit: 5,
  startAt: "tomorrow",
  endAt: new Date(),
  catchUp: true,
  disabled: false,
  context: "billing",
  enhancers: false,
  onDenied: "retry",
  onInvalid: "retry",
});
Every(1000);
Every("5 minutes", { immediately: true });
// @ts-expect-error -- a cron expression
Cron(5);
// @ts-expect-error -- not a job or series option
Cron("0 3 * * *", { nope: 1 });
// @ts-expect-error -- milliseconds or words
Every(true);
// @ts-expect-error -- "fail" or "retry"
Every(1000, { onDenied: "drop" });

BunJobsModule.forRoot({
  namespace: "n",
  scheduleQueue: "schedule",
  pruneSchedules: true,
});
// @ts-expect-error -- whether to prune
BunJobsModule.forRoot({ namespace: "n", pruneSchedules: "yes" });

BunJobsModule.registerRunner(
  { id: "cleanup", file: "./cleanup.ts", schedule: "0 3 * * *" },
  {
    id: "other",
    file: new URL("./other.ts", import.meta.url),
    executionMode: "child-process",
    args: { days: 30 },
    context: "billing",
  },
);
// @ts-expect-error -- a runner runs a file
BunJobsModule.registerRunner({ id: "cleanup" });
// @ts-expect-error -- the context owns the namespace
BunJobsModule.registerRunner({ id: "c", file: "./c.ts", namespace: "n" });

export class Ops {
  constructor(
    @InjectRunner("cleanup") readonly runner: BunRunner,
    @InjectRunner("cleanup", "billing") readonly billing: BunRunner,
  ) {}
}
// @ts-expect-error -- a runner's id
InjectRunner(1);
