import type {
  RemoteContext,
  RemoteExecutor,
  RemoteExecutorOptions,
  RemoteExecutorStore,
  RemoteJob,
  RemoteJobHandler,
} from "@kingsleyweb/bun-jobs/remote";
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";

/**
 * Compile-time checks for the executor's public surface, run by the tests
 * typecheck rather than `bun test`. Negative controls are `@ts-expect-error`
 * lines: if one stopped failing, the directive itself would be the error.
 */

type Equal<X, Y> =
  (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2
    ? true
    : false;
type Expect<V extends true> = V;
type IsAny<T> = 0 extends 1 & T ? true : false;

const secret = "x".repeat(32);

/** A handler typed for its own data sits beside an untyped one. */
const typed: RemoteJobHandler<{ url: string }, { bytes: number }> = async (
  job,
) => ({ bytes: job.data.url.length });

export const executor: RemoteExecutor = createRemoteExecutor({
  secret,
  handlers: {
    typed,
    inline: async (job, ctx) => {
      const _data: unknown = job.data;
      const _signal: AbortSignal = ctx.signal;
      await ctx.heartbeat();
      await job.updateProgress(10);
      await job.updateProgress({ step: "a" });
      return job.log("line");
    },
  },
});

export const fetchHandler: (request: Request) => Promise<Response> = executor;
export type _NotAny = Expect<Equal<IsAny<RemoteExecutor>, false>>;
export type _Data = Expect<Equal<RemoteJob<{ a: 1 }>["data"], { a: 1 }>>;
export type _Ctx = Expect<Equal<RemoteContext["delivery"], number>>;
export type _Secret = Expect<
  Equal<RemoteExecutorOptions["secret"], string | readonly string[]>
>;

export function negative(job: RemoteJob, store: RemoteExecutorStore): void {
  // @ts-expect-error a remote job has no driver: no retry()
  void job.retry;
  // @ts-expect-error the job is read-only
  job.data = 1;
  // @ts-expect-error progress is a number or an object
  void job.updateProgress("half");
  // @ts-expect-error a record is one of the four kinds
  void store.set("k", { kind: "other" }, 1, 0);
  // @ts-expect-error handlers are required
  createRemoteExecutor({ secret });
  // @ts-expect-error a handler is a function
  createRemoteExecutor({ secret, handlers: { a: 1 } });
}
