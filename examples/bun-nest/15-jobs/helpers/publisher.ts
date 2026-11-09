/**
 * The other process of `events.ts`, a plain script with no Nest in it: it adds
 * one `welcome` job to `emails` on a file driver another process has open,
 * publishing its events or not, and exits (`run-all.ts` skips `helpers/`).
 *
 * `argv`: the driver's directory, the namespace, `"publish"` or `"silent"`,
 * and the job's id.
 */
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const [root, namespace, mode, jobId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];

const jobs = new BunJobs({
  namespace,
  driver: { type: "file", root },
  publishEvents: mode === "publish",
});
await jobs.queue("emails").add("welcome", {}, { jobId });
await jobs.close();
