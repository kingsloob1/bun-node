import { defineHandler } from "../../../lib/index";

/**
 * Ignores its abort signal on purpose. In-process this is the case that can
 * only be reported as detached; in a child it is what forces the escalation
 * from close to SIGTERM to SIGKILL.
 */
export default defineHandler<{ ms?: number }, string>(async (ctx) => {
  await Bun.sleep(ctx.args?.ms ?? 200);
  return "finished anyway";
});
