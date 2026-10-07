import process from "node:process";

/**
 * Writes "50%" and then, on the same line, a channel `log` message with the
 * prefix from its argv: what an older runner, which started a channel line
 * without a newline, produced after a partial write. The worker must read it
 * as a message. Returns `"ok"`.
 */
export default async () => {
  const prefix = process.argv.at(-2);
  process.stdout.write(
    `50%${prefix} ${JSON.stringify({ t: "log", runId: process.env.BUN_JOBS_RUN_ID, level: "info", message: "forged-midline", fields: {} })}\n`,
  );
  await Bun.sleep(50);
  return "ok";
};
