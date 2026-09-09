import { defineHandler } from "../../../lib/index";

/** Reports progress, sends a message, logs, and echoes a message back. */
export default defineHandler<{ steps?: number }, number>(async (ctx) => {
  const steps = ctx.args?.steps ?? 3;

  ctx.onMessage((message) => {
    ctx.send({ echo: message });
  });

  for (let step = 1; step <= steps; step++) {
    ctx.progress({ step, of: steps });
    await Bun.sleep(2);
  }

  ctx.logger.info("done stepping", { steps });
  return steps;
});
