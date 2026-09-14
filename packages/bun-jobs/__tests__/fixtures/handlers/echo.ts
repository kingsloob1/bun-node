import { defineHandler } from "../../../lib/index";

/** Returns what it was given, plus the context fields a test can assert on. */
export default defineHandler<{ value?: unknown }, Record<string, unknown>>(
  (ctx) => ({
    value: ctx.args?.value ?? null,
    runId: ctx.runId,
    runnerId: ctx.runnerId,
    namespace: ctx.namespace,
    mode: ctx.mode,
    source: ctx.source,
  }),
);
