import process from "node:process";
import { defineProcessors, JobDefinitions } from "../../../lib/index";

/**
 * One processor file for several job names, built with `defineProcessors`:
 * two definitions given as plain `{ name, handler }` objects, and one through
 * a `JobDefinitions` registry — the two shapes it takes. Each handler reports
 * which process ran it, so a test can tell the file ran where its target says.
 */
const registry = new JobDefinitions();
registry.set<{ text: string }, string>({
  name: "shout",
  handler: async (job) => job.data.text.toUpperCase(),
  options: {},
});

const fromRegistry = defineProcessors(registry);

export default defineProcessors([
  {
    name: "double",
    handler: async (job) => ({
      doubled: (job.data as { n: number }).n * 2,
      pid: process.pid,
    }),
  },
  {
    name: "shout",
    handler: async (job, ctx) => await fromRegistry(job, ctx),
  },
]);
