/**
 * Compile-time checks on `./jobs/testing`, read by `bun run check`.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext } from "@nestjs/common";
import type { RunJobOutcome } from "../lib/jobs/testing/index";
import {
  BunJobsTestingModule,
  drainJobs,
  runJob,
} from "../lib/jobs/testing/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const app: INestApplicationContext;

export const typed = await runJob<string>(app, "emails", "welcome", {
  to: "a",
});
export const untyped = await runJob(app, "emails", "welcome", {});
export const settled = await drainJobs(app);

export type _Result = Expect<Equal<typeof typed.result, string | undefined>>;
export type _Unknown = Expect<Equal<typeof untyped.result, unknown>>;
export type _Outcome = Expect<Equal<typeof typed, RunJobOutcome<string>>>;
export type _State = Expect<Equal<typeof typed.state, "completed" | "dead">>;
export type _Settled = Expect<Equal<typeof settled, Job<unknown, unknown>[]>>;

// `add()`'s options pass through, and its own `timeout` is not the wait.
await runJob(
  app,
  "q",
  "n",
  {},
  { attempts: 3, timeout: 100, settleWithin: 500 },
);
// @ts-expect-error a wrong option is refused
await runJob(app, "q", "n", {}, { settle: 500 });
// @ts-expect-error a wrong option is refused
await drainJobs(app, { queue: "q" });
// @ts-expect-error the context's own options are checked too
BunJobsTestingModule.forRoot({ autoStart: "no" });
BunJobsTestingModule.forRoot();
BunJobsTestingModule.forRoot({ name: "other", logger: false });
