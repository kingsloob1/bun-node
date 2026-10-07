import process from "node:process";

/**
 * Forges a `done` on the channel, using the prefix from its own argv, then
 * throws. A job can lie about its own attempt's result (documented): the
 * forged result is the first, and it wins.
 */
export default async () => {
  const prefix = process.argv.at(-2);
  // One frame, as the runner writes them: `<prefix> <id> <index> <count> <json>`.
  process.stdout.write(
    `\n${prefix} zz 0 1 ${JSON.stringify({ t: "done", runId: process.env.BUN_JOBS_RUN_ID, result: "forged" })}\n`,
  );
  await Bun.sleep(50);
  throw new Error("the real outcome");
};
