/**
 * Across processes — two producers and three consumers, five processes, one
 * backend, every job processed exactly once.
 *
 * ```bash
 * bun 08-drivers/cross-process/main.ts                        # a shared SQLite file
 * EXAMPLE_DRIVER=file bun 08-drivers/cross-process/main.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 08-drivers/cross-process/main.ts
 * ```
 *
 * `producer.ts` and `consumer.ts` share no code with each other beyond the
 * package: they agree on a namespace, a queue name and a backend, handed to
 * them in the environment. That is the whole contract — the same one two
 * services in two repositories would have.
 *
 * Consumers are stopped with `SIGTERM` and shut down gracefully, finishing
 * what they hold, as they would under a deploy. Each says when it is ready —
 * when a `SIGTERM` will be handled rather than kill it outright — and the
 * producers start once all three are, as a rollout waits on readiness.
 */
import type { Subprocess } from "bun";
import process from "node:process";
import { BunQueue, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../../shared/backend";
import { check, summary } from "../../shared/check";
import { show, step, title, waitFor } from "../../shared/console";

title("Across processes");

const config = crossProcessDriver();
const namespace = exampleNamespace("fleet");
const JOBS_PER_PRODUCER = 60;

/** Environment every child gets: where to meet. */
const env = {
  ...process.env,
  NAMESPACE: namespace,
  DRIVER_CONFIG: JSON.stringify(config),
};

/** Starts one of the sibling scripts as its own `bun` process. */
function spawn(
  script: string,
  extra: Record<string, string>,
): Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(
    [process.execPath, new URL(script, import.meta.url).pathname],
    {
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/** How a child process ended, and everything it wrote. */
interface Ended {
  /** Its exit code, or `null` when a signal ended it. */
  exitCode: number | null;
  /** The signal that ended it, if one did. */
  signal: string | null;
  /** Every line it wrote to stdout. */
  lines: string[];
  /** Everything it wrote to stderr. */
  stderr: string;
}

/** A consumer process, with its readiness and its end. */
interface Consumer {
  /** Its `CONSUMER_ID`. */
  id: string;
  /** The process. */
  child: Subprocess<"ignore", "pipe", "pipe">;
  /** Settles when it says it is ready; rejects if it exits before that. */
  ready: Promise<void>;
  /** Settles once it has exited and both its streams are read to the end. */
  ended: Promise<Ended>;
}

/** Reads a stream line by line, as the lines arrive. */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  if (pending !== "") yield pending;
}

/** One line of a consumer's stdout as an object, or `undefined` if not one. */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Starts a consumer and follows its stdout for the readiness line. */
function startConsumer(id: string): Consumer {
  const child = spawn("./consumer.ts", { CONSUMER_ID: id });
  const ready = Promise.withResolvers<void>();

  const lines = (async () => {
    const seen: string[] = [];
    for await (const line of readLines(child.stdout)) {
      seen.push(line);
      if (parseLine(line)?.ready === true) ready.resolve();
    }
    return seen;
  })();

  const ended = Promise.all([
    lines,
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([seen, stderr]) => ({
    exitCode: child.exitCode,
    signal: child.signalCode,
    lines: seen,
    stderr,
  }));

  // Does nothing once it was ready; otherwise the wait for it fails, naming it.
  void ended.then((end) => {
    ready.reject(
      new Error(
        `${id} exited before it was ready (exit code ${end.exitCode}, signal ${end.signal}); stdout: ${JSON.stringify(end.lines)}; stderr:\n${end.stderr}`,
      ),
    );
  });

  return { id, child, ready: ready.promise, ended };
}

/* ------------------------------------------------------------------ */
step("Start three consumers, wait until they are ready, then two producers");

const consumers = ["consumer-1", "consumer-2", "consumer-3"].map(startConsumer);
// A run that fails part-way must not leave a consumer behind: it would serve
// the queue forever, with nobody to stop it.
process.once("exit", () => {
  for (const { child } of consumers) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
await Promise.all(consumers.map((consumer) => consumer.ready));
show("consumers ready");

const producers = ["producer-a", "producer-b"].map((id) =>
  spawn("./producer.ts", { PRODUCER_ID: id, COUNT: String(JOBS_PER_PRODUCER) }),
);
show("pids", {
  consumers: consumers.map((consumer) => consumer.child.pid),
  producers: producers.map((child) => child.pid),
});

await Promise.all(producers.map((child) => child.exited));
show("producers finished and exited");

/* ------------------------------------------------------------------ */
step("Watch the queue from this process until it is empty");

const driver = createDriver(config);
const orders = new BunQueue<{ orderId: string }, { by: string }>("orders", {
  namespace,
  driver,
});

const total = JOBS_PER_PRODUCER * producers.length;
await waitFor(
  `${total} completed jobs`,
  async () => (await orders.count("completed")) === total,
  { timeout: 60_000, interval: 50 },
);
show("counts", await orders.count());

/* ------------------------------------------------------------------ */
step("Stop the consumers with SIGTERM");

for (const consumer of consumers) consumer.child.kill("SIGTERM");

const reports: { id: string; processed: number }[] = [];
for (const consumer of consumers) {
  const end = await consumer.ended;
  const report = end.lines
    .map(parseLine)
    .find((line) => typeof line?.processed === "number");

  if (end.stderr.trim() !== "") {
    show(`${consumer.id} stderr`, end.stderr.trim());
  }
  check(
    `${consumer.id} stopped gracefully and reported`,
    report !== undefined && report.error === undefined && end.exitCode === 0,
    { report, exitCode: end.exitCode, signal: end.signal, stderr: end.stderr },
  );
  if (report !== undefined) {
    reports.push({ id: consumer.id, processed: report.processed as number });
  }
}
show("what each consumer says it processed", reports);

/* ------------------------------------------------------------------ */
step("Check: every job exactly once");

const completed = await orders.list("completed", { limit: total + 10 });
const perConsumer = Object.groupBy(
  completed,
  (job) => job.returnValue?.by ?? "?",
);
const ids = new Set(completed.map((job) => job.id));

show("distinct job ids completed", `${ids.size} of ${total}`);
show(
  "by consumer (from the job records)",
  Object.fromEntries(
    Object.entries(perConsumer).map(([id, jobs]) => [id, jobs?.length]),
  ),
);
show(
  "consumers' own counts add up",
  reports.reduce((sum, report) => sum + report.processed, 0) === total,
);

await orders.close();
await driver.purge(namespace);
await driver.close();
summary();
