/**
 * Another process on the same file driver: adds one job, publishing its events or
 * not, and exits. `argv`: the driver's path, the namespace, `"publish"` or
 * `"silent"`, and the job's id. No Nest here: it is the process at the other end.
 */
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const [path, namespace, publish, jobId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const jobs = new BunJobs({
  namespace,
  driver: { type: "file", root: path },
  publishEvents: publish === "publish",
});
await jobs.queue("emails").add("welcome", {}, { jobId });
await jobs.close();
