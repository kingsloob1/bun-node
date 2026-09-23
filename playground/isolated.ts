import type {
  BackoffStrategy,
  BunJobs,
  BunQueueWorker,
} from "@kingsleyweb/bun-jobs";
import type { ChecksumData, ChecksumResult } from "./processors/checksum";
import type { PreviewData, PreviewResult } from "./processors/preview";
import type { WedgeData, WedgeResult } from "./processors/wedge";

/**
 * The half of the playground that runs its processors **somewhere else**: a
 * worker given a processor *file* plus `isolation: "spawn"` or
 * `isolation: "worker"` runs every attempt in a child process, or in a fresh
 * `Worker`, instead of on its own thread.
 *
 * | Queue       | Worker (stable key)            | Isolation | What it shows |
 * |-------------|--------------------------------|-----------|---------------|
 * | `checksums` | `api.checksums.hasher`         | `spawn`   | a CPU-bound processor that would otherwise hold the claim loop |
 * | `previews`  | `api.previews`                 | `worker`  | a fresh JavaScript context per attempt, in this process |
 * | `previews`  | `api.previews.2`               | `spawn`   | the *same* processor file in a child process, side by side |
 * | `imports`   | `api.imports.wedged`           | `spawn`   | a processor that ignores its signal, killed when the job times out |
 *
 * **The child needs no driver of its own.** Everything an isolated processor
 * asks of the store — a log line, a lock renewal, a flow's children — travels
 * the executor's message channel and is answered by the worker, which keeps
 * the driver; progress is forwarded the same way. That is why these queues
 * work identically on the default memory driver and on
 * `PLAYGROUND_DRIVER=sqlite`: nothing in the child ever opens a backend.
 *
 * Look for it in the UI: Workers groups all four under `api`, and a completed
 * job's `returnValue` on the Queues → job screen records the pid and thread
 * that produced it.
 */

/** The isolated queues, their workers, and how to feed and stop them. */
export interface IsolatedWorld {
  /** The workers, so the caller can close them with the rest. */
  workers: BunQueueWorker<any, any>[];
  /** Adds one checksum job, for the producer to call now and then. */
  addChecksum: () => Promise<unknown>;
  /** Adds one preview job, for the producer to call now and then. */
  addPreview: () => Promise<unknown>;
}

/** The processor files, resolved against this file rather than the cwd. */
const CHECKSUM = new URL("./processors/checksum.ts", import.meta.url);
const PREVIEW = new URL("./processors/preview.ts", import.meta.url);
const WEDGE = new URL("./processors/wedge.ts", import.meta.url);

/** A random element. */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

const ARCHIVES = ["catalogue.tar.gz", "orders-2026-09.zip", "legacy-crm.7z"];
const ASSETS = ["hero.png", "avatar.jpg", "chart.svg", "banner.webp"];

/** Creates the isolated queues, starts their workers, and seeds each one. */
export async function startIsolated(jobs: BunJobs): Promise<IsolatedWorld> {
  const checksums = jobs.queue<ChecksumData, ChecksumResult>("checksums");
  const previews = jobs.queue<PreviewData, PreviewResult>("previews");
  const imports = jobs.queue<WedgeData, WedgeResult>("imports");

  /**
   * A custom backoff, registered on both `previews` workers.
   *
   * A job's options are *stored*, so a function cannot be among them — the job
   * says `backoff: { type: "decode-ramp" }` and whichever worker claims it
   * resolves that name locally. A worker that was never given the name falls
   * back to the default backoff and warns, rather than losing the job's
   * remaining attempts to a typo.
   *
   * This one ramps 2 s, 8 s, 18 s and then gives up: a decoder that has run
   * out of memory three times is not going to succeed on the fourth.
   */
  const decodeRamp: Record<string, BackoffStrategy> = {
    "decode-ramp": ({ attempt }) =>
      attempt > 3 ? false : attempt * attempt * 2_000,
  };

  const hasher = jobs.worker<ChecksumData, ChecksumResult>(
    "checksums",
    CHECKSUM,
    {
      // A child process per attempt: the processor blocks its thread outright,
      // and this is the mode where that thread is not the worker's.
      isolation: "spawn",
      isolationOptions: {
        // Hashing checks its signal between blocks, so it unwinds well within
        // this; the kill timeout is the backstop if a block runs long.
        closeTimeout: 3_000,
        killTimeout: 1_000,
        spawn: {
          // Reaches the child as `process.env`: how a processor is told which
          // deployment it belongs to without putting it in every payload.
          env: { PLAYGROUND_ROLE: "checksums" },
        },
      },
      // Two children at a time. Each is a process, so this is the knob that
      // actually costs something here — unlike an in-process worker, where
      // raising it only interleaves more promises.
      concurrency: 2,
      // A block of hashing holds its thread for ~350 ms and a job runs several,
      // so the default 30 s lock would be tight if the machine were loaded.
      // The heartbeat renews at a third of it either way; the processor also
      // asks for a renewal itself after every block.
      lockDuration: 60_000,
      heartbeatInterval: 15_000,
      name: "hasher",
    },
  );

  // Two workers on ONE queue, running ONE processor file in two isolation
  // modes, so the difference is visible rather than described. Neither is
  // given a `name`, so `BunJobs` numbers them: `api.previews` and
  // `api.previews.2`.
  const previewWorker = jobs.worker<PreviewData, PreviewResult>(
    "previews",
    PREVIEW,
    {
      // A fresh `Worker` per attempt: a separate JavaScript context in this
      // same process, so nothing a processor leaves behind survives its job.
      isolation: "worker",
      isolationOptions: {
        closeTimeout: 2_000,
        worker: {
          // Low-memory mode: a preview render is short-lived, and a smaller
          // heap is the right trade for a context built per attempt.
          smol: true,
          // What the thread is called in diagnostics.
          name: "preview-render",
        },
      },
      concurrency: 2,
      // The `previews` processor throws about a quarter of the time, so these
      // are the workers that most need a retry policy; the jobs name
      // `decode-ramp` and this is where the name is resolved.
      backoffStrategies: decodeRamp,
      // Where a preview that exhausts its attempts is filed. A job's own
      // `deadLetter` wins over this; nothing here sets one, so this is what
      // they all use.
      deadLetterQueue: "dead-letters",
      // A terminated `Worker` leaves its job's lock to expire, so sweep more
      // often than the 30 s default, and let a job stall twice before burying
      // it — once is easy to hit when a render is killed mid-flight.
      stalledInterval: 15_000,
      maxStalledCount: 2,
    },
  );

  const previewSpawn = jobs.worker<PreviewData, PreviewResult>(
    "previews",
    PREVIEW,
    {
      // The same file, in a child process.
      isolation: "spawn",
      isolationOptions: { closeTimeout: 2_000, killTimeout: 1_000 },
      concurrency: 1,
      backoffStrategies: decodeRamp,
      deadLetterQueue: "dead-letters",
      // `BunJobs` would assign this anyway, since this is the second worker it
      // creates for `previews`. Pinning it says so out loud: an ordinal shifts
      // the moment a worker's creation becomes conditional, and a settings
      // override saved from the UI would then follow the wrong worker.
      keyOrdinal: 2,
      // A child process costs more to start than a `Worker`, so this one waits
      // a little longer between empty claims rather than spinning on them.
      pollInterval: 2_000,
      maxBlock: 2_000,
      // The one worker in the playground that skips the sweep, and it can
      // only do that because `previewWorker` above consumes the same queue
      // and does it. Maintenance — promoting delayed jobs, recovering stalled
      // ones, pruning results, healing repeats — is idempotent and per queue,
      // so any worker on the queue covers it, but *some* worker must.
      maintenance: false,
    },
  );

  const wedged = jobs.worker<WedgeData, WedgeResult>("imports", WEDGE, {
    isolation: "spawn",
    isolationOptions: {
      // Short on purpose, so the escalation is quick to watch: close, then
      // `SIGTERM` after a second, then `SIGKILL` half a second later. This
      // processor answers none of them, so every step is taken.
      closeTimeout: 1_000,
      killTimeout: 500,
    },
    // One at a time: each attempt is a process pinning a CPU until it is
    // killed, and there is nothing to learn from two of them at once.
    concurrency: 1,
    // Starts consuming as soon as it is constructed, instead of waiting for
    // `run()` — which is why it is missing from the loop below.
    autorun: true,
    // Maintenance stays **on**, and the reason is the point of this queue:
    // isolation means the blocked thread is the child's, not the worker's.
    // This is also the only worker on `imports`, and a queue whose only
    // worker skips the sweep has nobody to promote its delayed retries or
    // recover a job whose child was killed — such a job sits `active` for
    // ever. Measured on sqlite before this was fixed: a job left `active`
    // with no logs, and four jobs stuck at attempt 1 of 2.
    pollInterval: 2_000,
    maxBlock: 2_000,
    name: "wedged",
  });

  // Three of the four are started at the end of this function, once the seed
  // below is in. `wedged` is not in this list at all: its `autorun` had it
  // claiming before any of this ran.

  /** Adds one checksum job. */
  const addChecksum = async () =>
    await checksums.add("checksum", {
      file: `${pick(ARCHIVES)}#${Math.floor(Math.random() * 1_000)}`,
      blocks: 3 + Math.floor(Math.random() * 3),
    });

  /** Adds one preview job. */
  const addPreview = async () =>
    await previews.add(
      "render-preview",
      { asset: pick(ASSETS) },
      // Three attempts, spaced by the custom strategy both workers know.
      { attempts: 3, backoff: { type: "decode-ramp" } },
    );

  // --- The seed ---
  for (let i = 0; i < 6; i++) {
    await addChecksum();
  }
  for (let i = 0; i < 6; i++) {
    await addPreview();
  }
  // Dies on its first attempt even though it has four, because the processor
  // calls `job.fail()` from inside the child: unrecoverable, not retryable.
  // With no `deadLetter` of its own it takes the workers' `deadLetterQueue`,
  // so a letter about it turns up in `dead-letters`.
  await previews.add(
    "render-preview",
    { asset: "broken-header.png", corrupt: true },
    { jobId: "preview-broken-header", attempts: 4, backoff: 2_000 },
  );

  // Two, not twenty: each one pins a CPU for as long as its timeout and then
  // has to be killed. `attempts: 2` so the retry after a kill is visible.
  for (const archive of ARCHIVES.slice(0, 2)) {
    await imports.add(
      "import-archive",
      { archive },
      {
        // The worker aborts the attempt here; the child ignores that, so the
        // escalation in `isolationOptions` is what actually ends it.
        timeout: 4_000,
        attempts: 2,
        backoff: 5_000,
        // Retention as a **count**, which is the form that needs a queue of
        // its own: it sweeps the whole queue's dead set down to four, not
        // this job's own copies. Nothing else is on `imports`, so here it
        // means what it reads like — keep the last four corpses to look at.
        removeOnFail: { count: 4 },
      },
    );
  }

  // Now, with the whole seed in the queues (see above).
  for (const worker of [hasher, previewWorker, previewSpawn]) {
    void worker.run();
  }

  return {
    workers: [hasher, previewWorker, previewSpawn, wedged],
    addChecksum,
    addPreview,
  };
}
