import process from "node:process";

/** Sends itself SIGTERM, then waits: the run must end, not hang. */
export default async () => {
  process.kill(process.pid, "SIGTERM");
  await new Promise(() => {});
};
