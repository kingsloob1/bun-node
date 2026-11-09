import type {
  DynamicModule,
  INestApplicationContext,
  NestApplicationOptions,
  Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { withApplicationRole } from "./applicationRole";

/** Each module's context in this thread or process. */
const CONTEXTS = new Map<unknown, Promise<INestApplicationContext>>();

/**
 * DI inside a processor file: a Nest application context (no HTTP), built once per
 * thread or process and cached, whose providers a file resolves.
 *
 * ```ts
 * export default defineProcessor(async (job, ctx) => {
 *   const app = await createProcessorContext(ImagesWorkerModule);
 *   return app.get(ResizeService).resize(job.data, ctx.signal);
 * });
 * ```
 *
 * **bun-jobs starts a fresh thread or process per attempt, so the bootstrap is paid on
 * every attempt**: a median 115 to 130 ms measured on a three-provider module, on top of
 * the ~135 ms the thread or process already spends, and a module that opens database
 * connections pays for those too. The cache helps only an `"in-process"` file. The Nest
 * pipeline does not cross the boundary: inside the file, call services directly. A
 * `child-process` attempt sees an environment allowlist, so a module reading
 * `process.env.DATABASE_URL` at construction needs `passEnv` to name it.
 *
 * No worker, series or runner in the module starts here, so a module shared with the
 * main process cannot start consuming from inside an attempt.
 *
 * @param module The module to build.
 * @param options Nest's options; `logger` defaults to warnings and errors, since an
 * attempt's bootstrap lines are noise. Only the first call for a module reads them.
 */
export function createProcessorContext(
  module: Type<unknown> | DynamicModule,
  options: NestApplicationOptions = {},
): Promise<INestApplicationContext> {
  let context = CONTEXTS.get(module);
  if (context === undefined) {
    context = NestFactory.createApplicationContext(
      withApplicationRole(module, {}),
      { logger: ["warn", "error"], abortOnError: false, ...options },
    );
    CONTEXTS.set(module, context);
    context.catch(() => {
      CONTEXTS.delete(module);
    });
  }
  return context;
}
