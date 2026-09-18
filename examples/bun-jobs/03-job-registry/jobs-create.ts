/**
 * Saved drafts — `jobs.create(name, data)`, set up, then `save()`.
 *
 * ```bash
 * bun 03-job-registry/jobs-create.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 03-job-registry/jobs-create.ts
 * ```
 *
 * `create()` answers with a `JobDraft`: the same vocabulary as the builder,
 * in Agenda's shape. Nothing is written until `save()`, which answers with the
 * stored `Job`. What is worth knowing beyond the code:
 *
 * - **A draft is saved once.** Saving it again with nothing changed answers
 *   with the same job and writes nothing — even two saves racing. A setter
 *   called after a save began makes the next `save()` a `ConfigError`: change
 *   the stored job through its own methods, or `create()` another draft.
 * - **A save that threw saved nothing**, so the draft can be corrected and
 *   saved again.
 * - **Where Agenda differs, this follows the package:** `priority` is
 *   lower-runs-first, `unique` takes an id, and `repeatEvery` runs at once only
 *   with `immediately: true`.
 */
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a welcome email job carries. */
interface Email {
  /** Who receives it. */
  to: string;
  /** Which template to render. */
  template: string;
}

title("Job registry: saved drafts");

const jobs = new BunJobs({
  namespace: exampleNamespace("drafts"),
  driver: exampleDriver(),
  // Under the definition's options, which are under the draft's.
  defaultJobOptions: { keepStacktraces: 5 },
});

/** What each run of `sendEmail` did, in order. */
const sent: string[] = [];

jobs.define<Email, string>(
  "sendEmail",
  async (job) => {
    sent.push(`${job.data.template} → ${job.data.to}`);
    return `sent to ${job.data.to}`;
  },
  { attempts: 3, priority: 5, timeout: 30_000 },
);

// The registry's queue, to look at what was stored.
const registry = jobs.queue<Email>("jobs");

/* ------------------------------------------------------------------ */
step("create: a draft writes nothing");

const draft = jobs.create<Email, string>("sendEmail", {
  to: "ada@example.com",
  template: "welcome",
});

show("draft", {
  name: draft.name,
  isSaved: draft.isSaved,
  job: draft.job,
  jobsStored: (await registry.count()).waiting,
});

/* ------------------------------------------------------------------ */
step("Set it up, then save");

draft
  .unique("welcome-ada") // id + idempotency key
  .priority(1) // lower runs first: ahead of the definition's 5
  .attempts(5)
  .backoff({ type: "exponential", delay: 1_000 })
  .timeout("45 seconds")
  .keepLogs(50)
  .removeOnComplete({ count: 100 }) // keep the last 100 completed
  .deadLetter("emails-dead")
  .schedule("in 10 minutes");

const welcome = await draft.save();

show("saved", {
  id: welcome.id,
  state: welcome.state,
  runsInMinutes: Math.round((welcome.runAt - Date.now()) / 60_000),
  priority: welcome.priority,
  // The definition's timeout was replaced; its keepStacktraces default kept.
  opts: welcome.opts,
});
show("draft now", { isSaved: draft.isSaved, sameJob: draft.job === welcome });

/* ------------------------------------------------------------------ */
step("A draft is saved once");

const again = await draft.save();
show("second save answers with the same job", again === welcome);

const racing = jobs.create<Email>("sendEmail", {
  to: "grace@example.com",
  template: "welcome",
});
const [a, b] = await Promise.all([racing.save(), racing.save()]);
show("two racing saves, one job", a === b);

// A setter after the save: the stored job would no longer match the draft.
draft.priority(2);
try {
  await draft.save();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("ConfigError", error.message);
}

// Change the stored job through its own methods instead.
await welcome.setPriority(2);
show(
  "stored priority, changed on the job",
  (await registry.getJob(welcome.id))?.priority,
);

/* ------------------------------------------------------------------ */
step("A unique id is the idempotency key across drafts, too");

const duplicate = await jobs
  .create<Email>("sendEmail", { to: "someone-else", template: "welcome" })
  .jobId("welcome-ada") // `jobId` is `unique` under the raw option's name
  .save();
show("second draft with the id", {
  wasAdded: duplicate.wasAdded,
  data: duplicate.data, // the stored job's, untouched
});

/* ------------------------------------------------------------------ */
step("Repeating drafts");

const digestStart = new Date(Date.now() + 86_400_000);
digestStart.setUTCHours(8, 0, 0, 0);

const digest = await jobs
  .create<Email>("sendEmail", { to: "team@example.com", template: "digest" })
  .repeatEvery("1 day", { tz: "Africa/Lagos", limit: 30, key: "daily-digest" })
  .schedule(digestStart) // on a repeating draft: when the series begins
  .save();

show("series", {
  repeatKey: digest.repeatKey,
  firstRun: new Date(digest.runAt).toISOString(),
  stored: (await registry.listRepeatables()).map(
    ({ key, every, limit, tz }) => ({
      key,
      every,
      limit,
      tz,
    }),
  ),
});

/* ------------------------------------------------------------------ */
step("Debounced drafts collapse into one job");

for (const revision of [1, 2, 3]) {
  await jobs
    .create<Email>("sendEmail", {
      to: "ada@example.com",
      template: `profile-updated-r${revision}`,
    })
    .debounce("profile:ada", "1 hour")
    .save();
}
const debounced = await registry.list("delayed");
show(
  "pending profile emails",
  debounced
    .filter((job) => job.data.template.startsWith("profile"))
    .map((job) => job.data.template),
);

/* ------------------------------------------------------------------ */
step("What the queue refuses is refused at save, and nothing is written");

const before = await registry.listRepeatables();
try {
  await jobs
    .create<Email>("sendEmail", { to: "x", template: "x" })
    .repeatEvery("1 hour")
    .debounce("x", "1 minute")
    .save();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("ConfigError", error.message);
}
show("repeat series before / after", [
  before.length,
  (await registry.listRepeatables()).length,
]);

/* ------------------------------------------------------------------ */
step("A save that threw can be corrected and saved again");

const misdated = jobs
  .create<Email>("sendEmail", { to: "linus@example.com", template: "reminder" })
  .schedule("zzqx vbnm"); // words no date parser can read — read at save

try {
  await misdated.save();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("first save", error.message);
}

// The last `schedule()` stands, so correcting it is one more call.
const reminder = await misdated.schedule(Date.now() + 300).save();
show("corrected and saved", {
  isSaved: misdated.isSaved,
  state: reminder.state,
});

/* ------------------------------------------------------------------ */
step("A worker runs saved drafts like any other job");

// Something to run now, beside the reminder coming due.
await jobs
  .create<Email>("sendEmail", { to: "ada@example.com", template: "receipt" })
  .save();

const worker = await jobs.start({ pollInterval: 50 });
/** Whether a `sendEmail` job with `template` has run. */
const hasSent = (template: string) =>
  sent.some((line) => line.startsWith(`${template} `));
await waitFor(
  "the receipt and the reminder",
  () => hasSent("receipt") && hasSent("reminder"),
);
show("sent", sent);

await worker.close();
await jobs.purge();
await jobs.close();
