/**
 * Throttle — at most one job per id per window.
 *
 * ```bash
 * bun 05-flow-control/throttle.ts
 * ```
 *
 * "Send a password-reset email" should not become fifty emails because
 * someone hammered the button. With `throttle: { id, ttl }` the first add
 * opens a window; every add inside it adds nothing and answers with the job
 * that opened it. The first add after the window closes opens the next one.
 *
 * Debounce keeps the *last* add's data and runs after the adds stop; throttle
 * keeps the *first* and runs straight away.
 */
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a reset-email job carries. */
interface ResetEmail {
  /** The account asking. */
  userId: string;
  /** Which click this was. */
  click: number;
}

title("Throttle");

const jobs = new BunJobs({
  namespace: exampleNamespace("auth"),
  driver: exampleDriver(),
});

/** Emails actually sent. */
const sent: ResetEmail[] = [];

jobs.define<ResetEmail>("sendPasswordReset", async (job) => {
  sent.push(job.data);
  show(`email sent to ${job.data.userId}`, `from click ${job.data.click}`);
});
await jobs.start({ pollInterval: 25 });

jobs
  .queue<ResetEmail>("jobs")
  .on("throttled", (job) => show("throttled — the window's job is", job.id));

/* ------------------------------------------------------------------ */
step("u_1 clicks five times; u_2 once — window of 1 second per user");

/** Adds one reset email, throttled per user. */
const requestReset = async (userId: string, click: number) =>
  await jobs
    .run<ResetEmail>("sendPasswordReset", { userId, click })
    .throttle(`reset:${userId}`, "1 second")
    .start();

for (let click = 1; click <= 5; click++) {
  await requestReset("u_1", click);
}
await requestReset("u_2", 1);

await waitFor("two emails", () => sent.length === 2);

/* ------------------------------------------------------------------ */
step("After the window closes, the next click goes through");

await Bun.sleep(1_050);
await requestReset("u_1", 6);
await waitFor("u_1's second email", () => sent.length === 3);

show(
  "emails per user",
  Object.groupBy(sent, (email) => email.userId),
);

// The closed windows' pointers can be swept now rather than by the workers'
// once-a-minute sweep.
show("closed windows removed", await jobs.queue("jobs").cleanWindows());

await jobs.purge();
await jobs.close();
