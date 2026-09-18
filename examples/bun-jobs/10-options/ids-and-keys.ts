/**
 * Option tour: the names a caller chooses — job ids, flow child ids, debounce
 * and throttle ids, repeat keys — and the queue-state names the package
 * reserves for itself.
 *
 * ```bash
 * bun 10-options/ids-and-keys.ts
 * EXAMPLE_DRIVER=file bun 10-options/ids-and-keys.ts
 * EXAMPLE_DRIVER=mysql EXAMPLE_MYSQL_URL=mysql://user:pass@localhost/jobs bun 10-options/ids-and-keys.ts
 * ```
 *
 * The points worth knowing:
 *
 * - **An id you choose is checked where you give it.** `jobId`, a flow
 *   child's `jobId`, `debounce.id` / `throttle.id` and `repeat.key` go
 *   through `assertJobId`, a *denylist*: empty, over 191 characters, a
 *   control character (C0, DEL, C1), a leading `.` or a lone surrogate is a
 *   `ConfigError`, thrown before anything is written. Everything else passes — `/`, `\`, `:`, `|`,
 *   spaces, unicode — because the package's own ids are built from exactly
 *   those characters.
 * - **One cap for every backend: 191 characters.** MySQL and MariaDB store an
 *   id as `VARCHAR(191)` and used to *truncate* a longer one, merging two jobs
 *   into one. The file driver has one more limit of its own: an id's
 *   encoded file name must fit in 201 bytes, and a character outside
 *   `[a-z0-9]` encodes to 2–9 bytes; it refuses a wider id before writing.
 * - **An id the package derives is shortened, never refused** — a dead
 *   letter's, a repeat occurrence's, a debounced job's, a window pointer's
 *   name — by `shortenJobId`, deterministically, so two workers deriving one
 *   occurrence still agree. It is fitted to the tightest store in *bytes* as
 *   well as characters, so it fits the file driver too.
 * - **A repeat key you choose is stored as `k:<key>`** so it can never equal a
 *   generated key (`<name>|<schedule>|<start>`) and take that series over. The
 *   prefix is hidden wherever the key surfaces, *unless* the key contains `|`
 *   — then it stays, because hiding it could make two series look alike and
 *   derive the same occurrence id. `removeRepeatable()` takes the key as
 *   listed or as you supplied it, and a series *listed* as the key wins.
 * - **`__win:` is reserved** in queue state: window pointers live under
 *   `__win:debounce:` / `__win:throttle:`, a caller's `setQueueState` there is
 *   a `ConfigError`, and the sweep never touches a name outside it — so an
 *   entry of your own called `debounce:…` is safe now.
 * - **A debounce pointer is written, then confirmed.** Between the two the
 *   pointer names a job that does not exist yet; a sweep or a second producer
 *   landing in that gap leaves the window alone instead of opening another.
 * - **Long names are fitted, or refused where they are configuration.** A
 *   repeat key is at most 189 characters (it is stored as `k:<key>`); a kv
 *   entry a long name would overflow on MySQL/MariaDB is fitted with a hash,
 *   never truncated; and a namespace or queue name over 191 characters there
 *   is a `ConfigError`.
 */
import type { JobsDriver, QueueRef } from "@kingsleyweb/bun-jobs";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  CALLER_REPEAT_KEY_PREFIX,
  ConfigError,
  createDriver,
  DEBOUNCE_PREFIX,
  MAX_JOB_ID_LENGTH,
  MAX_REPEAT_KEY_LENGTH,
  RESERVED_STATE_PREFIX,
  shortenJobId,
  THROTTLE_PREFIX,
} from "@kingsleyweb/bun-jobs";
import {
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: ids, window ids, repeat keys and reserved names");

/** What every job in this tour carries. */
interface Doc {
  /** A number to tell adds apart. */
  v: number;
}

const backend = exampleBackend();
const namespace = exampleNamespace("ids-and-keys");
const driver = createDriver(exampleDriver());
await driver.connect();
show("backend", backend);

/** Generous, because other suites may share this machine and its servers. */
const WAIT = { timeout: 30_000, interval: 20 };

/** Every queue this tour opens, closed at the end. */
const queues: BunQueue<Doc, unknown, string>[] = [];

/** A queue in this tour's namespace. */
function openQueue(
  name: string,
  over: JobsDriver = driver,
): BunQueue<Doc, unknown, string> {
  const queue = new BunQueue<Doc, unknown, string>(name, {
    namespace,
    driver: over,
    logger: noopLogger,
  });
  queues.push(queue);
  return queue;
}

/** Every job the queue holds, in any state. */
async function total(queue: BunQueue<Doc, unknown, string>): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** A control character, built so the source holds no literal one. */
function control(code: number): string {
  return `a${String.fromCharCode(code)}b`;
}

/** What `run` threw or rejected with, or `undefined`. */
async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Every refused class of id, with the phrase that must name it. */
const REFUSED = [
  { label: "empty", id: "", message: /must be a non-empty string/ },
  {
    label: "192 characters",
    id: "a".repeat(MAX_JOB_ID_LENGTH + 1),
    message: /is 192 characters long; the most is 191/,
  },
  { label: "NUL", id: control(0x00), message: /U\+0000 at index 1/ },
  { label: "a C0 control (BEL)", id: control(0x07), message: /U\+0007/ },
  { label: "DEL", id: control(0x7f), message: /U\+007F/ },
  { label: "a C1 control (NEL)", id: control(0x85), message: /U\+0085/ },
  { label: "a leading dot", id: ".hidden", message: /may not begin with "\."/ },
  { label: '".."', id: "..", message: /may not begin with "\."/ },
  {
    label: "a lone surrogate",
    id: `a${String.fromCharCode(0xd800)}b`,
    message: /contains a lone surrogate, which no backend can store faithfully/,
  },
] as const;

/* ------------------------------------------------------------------ */
step("jobId: refused at add(), before anything is written");

{
  const queue = openQueue("refused");

  for (const { label, id, message } of REFUSED) {
    await checkRejects(
      `jobId ${label}`,
      () => queue.add("x", { v: 1 }, { jobId: id }),
      { name: "ConfigError", code: "CONFIG", message },
    );
  }
  checkEqual("nothing was written", await total(queue), 0);

  // addBulk checks every entry first, so one bad id adds none of the batch.
  await checkRejects(
    "addBulk: one bad id among good ones",
    () =>
      queue.addBulk([
        { name: "x", data: { v: 1 }, opts: { jobId: "good-1" } },
        { name: "x", data: { v: 2 }, opts: { jobId: control(0x07) } },
      ]),
    { name: "ConfigError", message: /U\+0007/ },
  );
  checkEqual(
    "…and the good entry was not added either",
    await queue.getJob("good-1"),
    null,
  );

  // A flow child's id is checked too, and the whole flow is refused.
  await checkRejects(
    "addFlow: a child with a bad id",
    () =>
      queue.addFlow({
        name: "parent",
        data: { v: 1 },
        children: [{ name: "child", data: { v: 2 }, opts: { jobId: ".x" } }],
      }),
    { name: "ConfigError", message: /^flow node jobId may not begin/ },
  );
  checkEqual("…writing nothing", await total(queue), 0);

  // A window id becomes a queue-state name and part of a job id, so it is
  // held to the same rules, and the message names which option it was.
  for (const kind of ["debounce", "throttle"] as const) {
    await checkRejects(
      `${kind}.id with a control character`,
      () =>
        queue.add("x", { v: 1 }, { [kind]: { id: control(1), ttl: 1_000 } }),
      { name: "ConfigError", message: new RegExp(`^${kind}\\.id may not`) },
    );
    await checkRejects(
      `${kind}.id over the cap`,
      () =>
        queue.add(
          "x",
          { v: 1 },
          { [kind]: { id: "w".repeat(MAX_JOB_ID_LENGTH + 1), ttl: 1_000 } },
        ),
      { name: "ConfigError", message: new RegExp(`^${kind}\\.id is 192`) },
    );
  }
  // An empty window id keeps its own, older message.
  await checkRejects(
    "debounce.id empty",
    () => queue.add("x", { v: 1 }, { debounce: { id: "", ttl: 1_000 } }),
    { name: "ConfigError", message: /debounce\.id is required/ },
  );
  checkEqual("…and no window opened", await total(queue), 0);

  // The registry reaches the same check through every way it names a job.
  const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
  jobs.define<Doc>("mail", async () => null);
  await checkRejects(
    "jobs.now(..., { jobId })",
    () => jobs.now<Doc>("mail", { v: 1 }, { jobId: "" }),
    { name: "ConfigError", message: /jobId must be a non-empty string/ },
  );
  await checkRejects(
    "jobs.create().unique() — at save()",
    () => jobs.create<Doc>("mail", { v: 1 }).unique(".dot").save(),
    { name: "ConfigError", message: /may not begin with "\."/ },
  );
  await checkRejects(
    "jobs.run().unique() — at start()",
    () => jobs.run<Doc>("mail", { v: 1 }).unique(control(0x9f)).start(),
    { name: "ConfigError", message: /U\+009F/ },
  );
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("jobId: everything else is allowed, and round-trips");

{
  const queue = openQueue("accepted");
  const accepted = [
    ["a UUID", "01a0b426-8d65-74e0-acbd-2c5cfcde29a9"],
    ["a slash (tenant-scoped)", "tenant/7"],
    ["a backslash", "a\\b"],
    ["colons and pipes, as generated ids have", "report|every:60000|"],
    ["a cron series' characters", "0 9 * * 1-5@Europe/London"],
    ["commas and spaces", "with,commas and spaces"],
    ["a trailing space, distinct from none", "trailing "],
    ["a non-breaking space (not a control)", "a\u00A0b"],
    ["unicode", "unicode-é-🙂"],
    ["exactly 191 characters", "a".repeat(MAX_JOB_ID_LENGTH)],
  ] as const;

  for (const [label, id] of accepted) {
    const job = await queue.add("x", { v: 1 }, { jobId: id });
    const stored = await queue.getJob(id);
    checkEqual(
      `${label}: added as given, and read back`,
      [job.id, stored?.id],
      [id, id],
    );
  }

  // Ids that differ only by case or a trailing space are different ids on
  // every backend — MySQL's default collations would say otherwise, which is
  // why the id columns there are binary.
  const twin = await queue.add("x", { v: 2 }, { jobId: "trailing" });
  const cased = await queue.add("x", { v: 3 }, { jobId: "Tenant/7" });
  checkEqual(
    "near-twins are new jobs, not duplicates",
    [twin.wasAdded, cased.wasAdded],
    [true, true],
  );

  // The file driver's own limit: the *encoded* file name. Letters a–z and
  // digits are one byte each; an uppercase letter is two, most punctuation
  // two or three, a character outside ASCII up to nine.
  const wide = "漢".repeat(120);
  if (backend === "file") {
    const refused = await checkRejects(
      "file: 120 CJK characters — legal, but too wide as a file name",
      () => queue.add("x", { v: 1 }, { jobId: wide }),
      { name: "DriverError", message: /file driver failed during addJob/ },
    );
    check(
      "…the cause names the encoded size and the limit",
      /encodes to 1080 bytes as a file name, and the most is 201/.test(
        (refused?.cause as Error | undefined)?.message ?? "",
      ),
      (refused?.cause as Error | undefined)?.message,
    );
  } else {
    const job = await queue.add("x", { v: 1 }, { jobId: wide });
    checkEqual(
      `${backend}: 120 CJK characters round-trip`,
      (await queue.getJob(job.id))?.id,
      wide,
    );
  }
}

/* ------------------------------------------------------------------ */
step("Derived ids are shortened to fit, never refused");

{
  // A dead letter's id is `<queue>:<id>:<createdAt>`, so a job whose own id is
  // at the cap derives one well over it. Refusing it would throw inside the
  // worker's failure path and lose the letter; it is shortened instead.
  const source = openQueue("letters-source");
  const letters = openQueue("letters-dead");
  const atCap = "d".repeat(MAX_JOB_ID_LENGTH);
  await source.add(
    "fails",
    { v: 1 },
    { jobId: atCap, attempts: 1, deadLetter: "letters-dead" },
  );
  const worker = new BunQueueWorker<Doc, unknown>(
    "letters-source",
    () => {
      throw new Error("boom");
    },
    { namespace, driver, logger: noopLogger, pollInterval: 20 },
  );
  void worker.run();
  await waitFor(
    "the dead letter",
    async () => (await letters.list(["waiting", "delayed"])).length === 1,
    WAIT,
  );
  await worker.close();
  const [letter] = await letters.list(["waiting", "delayed"]);
  check(
    "a dead letter for a 191-character id: filed, its id shortened to 191",
    letter !== undefined &&
      letter.id.length === MAX_JOB_ID_LENGTH &&
      letter.id.startsWith(`letters-source:${"d".repeat(100)}`) &&
      /~[0-9a-z]+$/.test(letter.id),
    letter?.id,
  );

  // A repeat occurrence's id is `repeat:<key>:<runAt>`. A long key makes a
  // long id, shortened the same way every time — which is what keeps a
  // second add of the same series idempotent.
  // (175 characters: long enough that the occurrence id needs shortening;
  // a caller's key may be at most 189, see "Repeat keys are checked" below.)
  const repeats = openQueue("ls");
  const key = "s".repeat(175);
  const first = await repeats.add(
    "x",
    { v: 1 },
    { repeat: { every: 60_000, key } },
  );
  const again = await repeats.add(
    "x",
    { v: 2 },
    { repeat: { every: 60_000, key } },
  );
  checkEqual(
    "a 175-character repeat key: an occurrence id of 191",
    first.id.length,
    MAX_JOB_ID_LENGTH,
  );
  checkEqual(
    "…and the same one on a second add",
    [again.id === first.id, again.wasAdded],
    [true, false],
  );
  await repeats.removeRepeatable(key);

  // A debounced job's id is `__win:debounce:<id>:<uuid>`: with a long window
  // id, shortened too.
  const windows = openQueue("long-window");
  let debounced: Awaited<ReturnType<typeof windows.add>> | undefined;
  const debounceError = await caught(async () => {
    debounced = await windows.add(
      "x",
      { v: 1 },
      { debounce: { id: "w".repeat(150), ttl: 60_000 } },
    );
  });
  // Fitted to the tightest store in bytes as well as characters: `_` and `:`
  // take more than one byte in a file name, so the id is shortened a little
  // below 191 characters — the same on every backend, since the fitting
  // does not depend on which one is in use. A fitted id already fits, so
  // `shortenJobId` hands it back unchanged.
  check(
    "a 150-character debounce id: the job is added, its id shortened to fit",
    debounceError === undefined &&
      debounced !== undefined &&
      debounced.id.length <= MAX_JOB_ID_LENGTH &&
      debounced.id.startsWith(`${DEBOUNCE_PREFIX}${"w".repeat(100)}`) &&
      /~[0-9a-z]+$/.test(debounced.id) &&
      shortenJobId(debounced.id) === debounced.id,
    debounceError ?? debounced?.id,
  );
}

/* ------------------------------------------------------------------ */
step("Repeat keys: stored as k:<key>, shown bare");

{
  const queue = openQueue("series");
  const heard: string[] = [];
  queue.on("repeatScheduled", (key) => heard.push(key));

  const job = await queue.add(
    "digest",
    { v: 1 },
    { repeat: { every: 60_000, key: "nightly" } },
  );
  const [listed] = await queue.listRepeatables();
  checkEqual(
    "job.repeatKey, listRepeatables()[].key, the repeatScheduled event: bare",
    [job.repeatKey, listed?.key, heard],
    ["nightly", "nightly", ["nightly"]],
  );
  check(
    "the occurrence id follows the shown key: repeat:nightly:<runAt>",
    job.id === `repeat:nightly:${job.runAt}`,
    job.id,
  );

  // Underneath, the driver holds it namespaced.
  const ref: QueueRef = queue.ref;
  checkEqual(
    "stored as k:nightly — the driver has no series called plain nightly",
    [
      (await driver.getRepeat(ref, `${CALLER_REPEAT_KEY_PREFIX}nightly`))?.key,
      await driver.getRepeat(ref, "nightly"),
    ],
    ["k:nightly", null],
  );

  // removeRepeatable() takes the key as listed (here the same as the one
  // given). The stored spelling is neither: it is not what any series is
  // listed as, so it removes nothing.
  checkEqual(
    "removeRepeatable(the key as given)",
    await queue.removeRepeatable("nightly"),
    true,
  );
  await queue.add(
    "digest",
    { v: 1 },
    { repeat: { every: 60_000, key: "hourly" } },
  );
  checkEqual(
    "removeRepeatable(the stored spelling k:hourly): not a listed key, removes nothing",
    [
      await queue.removeRepeatable("k:hourly"),
      (await queue.listRepeatables()).map((record) => record.key),
    ],
    [false, ["hourly"]],
  );
  checkEqual(
    "removeRepeatable(hourly): removed",
    await queue.removeRepeatable("hourly"),
    true,
  );
  checkEqual("…both gone", await queue.listRepeatables(), []);

  // The takeover this prevents: a caller key equal to a generated one.
  await queue.add("report", { v: 1 }, { repeat: { every: 60_000 } });
  const [generated] = await queue.listRepeatables();
  checkEqual(
    "a generated key: <name>|every:<ms>|<start>",
    generated?.key,
    "report|every:60000|",
  );
  const impostor = await queue.add(
    "other",
    { v: 2 },
    { repeat: { every: 60_000, key: "report|every:60000|" } },
  );
  checkEqual(
    "the same string as a caller key is a second series, not the first",
    (await queue.listRepeatables()).map((record) => record.key).sort(),
    ["k:report|every:60000|", "report|every:60000|"],
  );
  checkEqual(
    "a key with | keeps its prefix everywhere it shows",
    [impostor.repeatKey, impostor.id.startsWith("repeat:k:report|")],
    ["k:report|every:60000|", true],
  );
  check(
    "…so the two series derive different occurrence ids",
    impostor.id !== `repeat:report|every:60000|:${impostor.runAt}`,
    impostor.id,
  );
  checkEqual(
    "removeRepeatable(listed key) removes the one it lists",
    [
      await queue.removeRepeatable("k:report|every:60000|"),
      (await queue.listRepeatables()).map((record) => record.name),
    ],
    [true, ["report"]],
  );
  await queue.removeRepeatable("report|every:60000|");

  // Migration: a series an earlier version stored under the bare key is
  // still removable by that key.
  await driver.upsertRepeat(ref, {
    key: "legacy",
    name: "digest",
    data: { v: 0 },
    opts: listed!.opts,
    every: 60_000,
    count: 0,
    nextRunAt: null,
    nextJobId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  checkEqual(
    "an unprefixed series from before: listed as it is, removed by its key",
    [
      (await queue.listRepeatables()).map((record) => record.key),
      await queue.removeRepeatable("legacy"),
      await queue.listRepeatables(),
    ],
    [["legacy"], true, []],
  );
  await queue.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Reserved queue-state names: __win: is the package's");

{
  const queue = openQueue("state");
  checkEqual(
    "the prefixes",
    [RESERVED_STATE_PREFIX, DEBOUNCE_PREFIX, THROTTLE_PREFIX],
    ["__win:", "__win:debounce:", "__win:throttle:"],
  );

  await checkRejects(
    "setQueueState under __win: from a caller",
    () =>
      driver.setQueueState!(
        queue.ref,
        `${RESERVED_STATE_PREFIX}mine`,
        {},
        null,
      ),
    { name: "ConfigError", code: "CONFIG", message: /reserved by bun-jobs/ },
  );
  checkEqual(
    "…nothing written",
    await driver.getQueueState!(queue.ref, `${RESERVED_STATE_PREFIX}mine`),
    null,
  );

  // The library's own writes carry a token that is an unexported symbol, so
  // no option a caller can build gets past the guard — not the old
  // `{ internal: true }`, and not a symbol with the same description.
  for (const [label, internal] of [
    ["{ internal: true }", true as unknown as symbol],
    ["a look-alike symbol", Symbol("bun-jobs: reserved queue-state write")],
  ] as const) {
    await checkRejects(
      `setQueueState under __win: with ${label}: still refused`,
      () =>
        driver.setQueueState!(
          queue.ref,
          `${RESERVED_STATE_PREFIX}forged`,
          {},
          null,
          { internal },
        ),
      { name: "ConfigError", message: /reserved by bun-jobs/ },
    );
  }

  // The file driver checks a state name's encoded size before writing, as it
  // does a job id's: 120 capitals encode to 240 bytes.
  if (backend === "file") {
    const wideName = "S".repeat(120);
    const refused = await checkRejects(
      "file: a 240-byte queue-state name is refused",
      () => driver.setQueueState!(queue.ref, wideName, { v: 1 }, null),
      { name: "DriverError" },
    );
    check(
      "…naming the encoded size, and nothing is written",
      /encodes to 240 bytes as a file name, and the most is 201/.test(
        (refused?.cause as Error | undefined)?.message ?? "",
      ) && (await driver.getQueueState!(queue.ref, wideName)) === null,
      (refused?.cause as Error | undefined)?.message,
    );
  }

  // The name the sweep used to believe it owned — and deleted.
  const mine = "debounce:my-own-setting";
  await driver.setQueueState!(queue.ref, mine, { hello: "world" }, null);
  // A window that has closed, so the sweep has work of its own.
  await queue.add("x", { v: 1 }, { throttle: { id: "closed", ttl: 1 } });
  await Bun.sleep(30);
  checkEqual(
    "cleanWindows() removes the closed window",
    await queue.cleanWindows(),
    1,
  );
  checkEqual(
    "…and leaves an application's own debounce:-named entry alone",
    (await driver.getQueueState!(queue.ref, mine))?.value,
    { hello: "world" },
  );
  await driver.setQueueState!(queue.ref, mine, null, null).catch(() => null);
}

/* ------------------------------------------------------------------ */
step("A debounce pointer is written, then confirmed");

{
  const queue = openQueue("pointer");
  const job = await queue.add(
    "x",
    { v: 1 },
    { debounce: { id: "doc", ttl: 60_000 } },
  );
  const pointer = (
    await driver.getQueueState!(queue.ref, `${DEBOUNCE_PREFIX}doc`)
  )?.value as { jobId?: string; at?: number; ready?: boolean } | undefined;
  checkEqual(
    "the pointer: the job's id, when it was written, and ready once the job exists",
    [pointer?.jobId, typeof pointer?.at, pointer?.ready],
    [job.id, "number", true],
  );

  // A sweep that lands in the gap between the pointer and the job. The
  // driver below runs one right before it writes each job record, which is
  // exactly where it used to delete the brand-new pointer — the next add then
  // opened a second window, and the caller had two jobs.
  const sweeper = openQueue("gap");
  let inTheGap: typeof pointer;
  const gapped = new Proxy(driver, {
    get(target, property) {
      if (property === "addJob") {
        return async (...args: Parameters<JobsDriver["addJob"]>) => {
          inTheGap = (
            await target.getQueueState!(args[0], `${DEBOUNCE_PREFIX}gap`)
          )?.value as typeof pointer;
          await sweeper.cleanWindows();
          return await target.addJob(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const inGap = openQueue("gap", gapped);
  const options = { debounce: { id: "gap", ttl: 60_000 } };
  const opened = await inGap.add("x", { v: 1 }, options);
  checkEqual(
    "mid-add, the pointer names the job but is not yet ready",
    [inTheGap?.jobId, inTheGap?.ready],
    [opened.id, undefined],
  );
  const joined = await inGap.add("x", { v: 2 }, options);
  checkEqual(
    "a sweep in the gap left the window: the second add joined the first",
    [joined.id === opened.id, joined.wasAdded, await total(inGap)],
    [true, false, 1],
  );

  // Many producers at once, with sweeps running beside them: still one job.
  const racing = openQueue("racing");
  const racingOptions = { debounce: { id: "busy", ttl: 60_000 } };
  const adds = [];
  for (let v = 0; v < 12; v++) {
    adds.push(racing.add("x", { v }, racingOptions));
  }
  const sweeps = Array.from({ length: 4 }, () => racing.cleanWindows());
  const [added] = await Promise.all([Promise.all(adds), Promise.all(sweeps)]);
  const ids = new Set(added.map((job) => job.id));
  checkEqual(
    "12 producers and 4 sweeps at once: one job",
    [ids.size, await total(racing)],
    [1, 1],
  );
}

/* ------------------------------------------------------------------ */
step("Repeat keys are checked like ids, and long ones never merge");

{
  const queue = openQueue("keys");

  // The same denylist as a jobId, at add() and before anything is written —
  // a NUL used to be a DriverError on Postgres alone and accepted elsewhere.
  for (const [label, key, message] of [
    [
      "a NUL",
      control(0),
      /^repeat\.key may not contain control characters, and has U\+0000/,
    ],
    ["a leading dot", ".nightly", /^repeat\.key may not begin with "\."/],
    [
      "a lone surrogate",
      `a${String.fromCharCode(0xdc00)}`,
      /^repeat\.key contains a lone surrogate/,
    ],
    [
      "one character over 189",
      "k".repeat(MAX_REPEAT_KEY_LENGTH + 1),
      /^repeat\.key is 190 characters long; the most is 189 \(it is stored with a "k:" prefix\)/,
    ],
  ] as const) {
    await checkRejects(
      `repeat.key with ${label}`,
      () => queue.add("x", { v: 1 }, { repeat: { every: 60_000, key } }),
      { name: "ConfigError", code: "CONFIG", message },
    );
  }
  checkEqual(
    "…and nothing was written: no job, no series",
    [await total(queue), (await queue.listRepeatables()).length],
    [0, 0],
  );
  checkEqual(
    "MAX_REPEAT_KEY_LENGTH is 191 less the k: prefix",
    MAX_REPEAT_KEY_LENGTH,
    189,
  );

  // Two keys at the cap that differ only in their last character. The kv key
  // under which MySQL and MariaDB keep a series is `q:<queue>:repeat:k:<key>`,
  // too wide for their 191-character column: it used to be truncated there,
  // merging the two series into one that neither key could remove. Now the
  // name is fitted with a hash of the whole — two series, each removable.
  const keyA = `${"z".repeat(MAX_REPEAT_KEY_LENGTH - 1)}a`;
  const keyB = `${"z".repeat(MAX_REPEAT_KEY_LENGTH - 1)}b`;
  await queue.add("a", { v: 1 }, { repeat: { every: 60_000, key: keyA } });
  await queue.add("b", { v: 2 }, { repeat: { every: 60_000, key: keyB } });
  checkEqual(
    "two 189-character keys sharing 188: two series, listed by their keys",
    (await queue.listRepeatables())
      .map((record) => [
        record.name,
        record.key === (record.name === "a" ? keyA : keyB),
      ])
      .sort(),
    [
      ["a", true],
      ["b", true],
    ],
  );
  checkEqual(
    "…each removed by its own key",
    [
      await queue.removeRepeatable(keyA),
      await queue.removeRepeatable(keyB),
      await queue.listRepeatables(),
    ],
    [true, true, []],
  );
  await queue.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("removeRepeatable(): the series listed as the key wins");

{
  const queue = openQueue("listed-first");

  // A caller key "k:nightly" is stored as "k:k:nightly" and listed as
  // "k:nightly" — which is also the *stored* spelling of a series keyed
  // "nightly". The one listed as the key given is the one removed.
  await queue.add(
    "plain",
    { v: 1 },
    { repeat: { every: 60_000, key: "nightly" } },
  );
  await queue.add(
    "prefixed",
    { v: 2 },
    { repeat: { every: 60_000, key: "k:nightly" } },
  );
  checkEqual(
    "listed as nightly and k:nightly",
    (await queue.listRepeatables())
      .map((record) => [record.key, record.name])
      .sort(),
    [
      ["k:nightly", "prefixed"],
      ["nightly", "plain"],
    ],
  );
  checkEqual(
    'removeRepeatable("k:nightly") removes the series listed as k:nightly',
    [
      await queue.removeRepeatable("k:nightly"),
      (await queue.listRepeatables()).map((record) => record.name),
    ],
    [true, ["plain"]],
  );
  checkEqual(
    'removeRepeatable("nightly") then removes the other',
    [await queue.removeRepeatable("nightly"), await queue.listRepeatables()],
    [true, []],
  );
  await queue.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Legal ids near the limits work on every backend, or are refused first");

{
  const queue = openQueue("near-limits");

  // A window id is part of the pointer's *name*, `__win:debounce:<id>`, which
  // is longer than the id: a 191-character kv column on MySQL/MariaDB, and a
  // file name on the file driver. The name is fitted, so two ids under the
  // cap are two windows everywhere.
  for (const kind of ["debounce", "throttle"] as const) {
    const first = await queue.add(
      "x",
      { v: 1 },
      { [kind]: { id: `${"w".repeat(185)}1`, ttl: 60_000 } },
    );
    const second = await queue.add(
      "x",
      { v: 2 },
      { [kind]: { id: `${"w".repeat(185)}2`, ttl: 60_000 } },
    );
    checkEqual(
      `two 186-character ${kind} ids: two windows, two jobs`,
      [
        first.wasAdded,
        second.wasAdded,
        first.id !== second.id,
        await total(queue),
      ],
      [true, true, true, 2],
    );
    await queue.drain({ delayed: true });
  }

  // A dead letter's id (`<queue>:<id>:<createdAt>`) is fitted in bytes too.
  // An id of 100 capitals is legal on the file driver (200 bytes); its dead
  // letter's id would encode to more than 201, and is shortened, not refused.
  const source = openQueue("near-limits-source");
  const letters = openQueue("near-limits-dead");
  const upper = "C".repeat(100);
  await source.add(
    "fails",
    { v: 1 },
    { jobId: upper, attempts: 1, deadLetter: "near-limits-dead" },
  );
  const errors: string[] = [];
  const worker = new BunQueueWorker<Doc, unknown>(
    "near-limits-source",
    () => {
      throw new Error("boom");
    },
    { namespace, driver, logger: noopLogger, pollInterval: 20 },
  );
  worker.on("error", (error) => errors.push(error.message));
  void worker.run();
  await waitFor(
    "the dead letter",
    async () => (await letters.list(["waiting", "delayed"])).length === 1,
    WAIT,
  );
  await worker.close();
  const [letter] = await letters.list(["waiting", "delayed"]);
  checkEqual(
    "a 100-capital id that dies: its dead letter is filed, under a fitted id, with no error",
    {
      prefix: letter?.id.startsWith(`near-limits-source:${"C".repeat(50)}`),
      fits: letter !== undefined && shortenJobId(letter.id) === letter.id,
      errors,
    },
    { prefix: true, fits: true, errors: [] },
  );

  // A caller's own id is not shortened: on the file driver one that encodes
  // past 201 bytes is refused, before anything is written — 101 capitals
  // already are. Every other backend stores it.
  const upperId = "A".repeat(120);
  if (backend === "file") {
    const before = await total(queue);
    const refused = await checkRejects(
      "file: 120 capitals — legal, but 240 bytes as a file name",
      () => queue.add("x", { v: 1 }, { jobId: upperId }),
      { name: "DriverError" },
    );
    check(
      "…the cause names the encoded size and the limit",
      /the id encodes to 240 bytes as a file name, and the most is 201/.test(
        (refused?.cause as Error | undefined)?.message ?? "",
      ),
      (refused?.cause as Error | undefined)?.message,
    );
    checkEqual(
      "…and nothing was written",
      [(await total(queue)) - before, await queue.getJob(upperId)],
      [0, null],
    );
  } else {
    const job = await queue.add("x", { v: 1 }, { jobId: upperId });
    checkEqual(
      `${backend}: 120 capitals round-trip`,
      (await queue.getJob(job.id))?.id,
      upperId,
    );
  }
  await queue.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("MySQL and MariaDB: a namespace or queue name is capped at 191 too");

{
  // Namespaces and queue names are checked by `assertSegment` (at most 200
  // characters) — but MySQL and MariaDB store them in 191-character columns.
  // Rather than truncate, those two refuse with a ConfigError: the name is
  // configuration, and no retry will make it fit. Every other backend takes
  // the full 200.
  const long = `${namespace}-`.padEnd(195, "n");
  const wide = new BunQueue<Doc, unknown, string>("q", {
    namespace: long,
    driver,
    logger: noopLogger,
  });
  const longQueue = openQueue("q".padEnd(195, "q"));
  const errors = [
    await caught(() => wide.add("x", { v: 1 })),
    await caught(() => longQueue.add("x", { v: 1 })),
  ];
  if (backend === "mysql" || backend === "mariadb") {
    for (const [index, what] of ["namespace", "queue name"].entries()) {
      const error = errors[index];
      check(
        `${backend}: a 195-character ${what} is a ConfigError naming the column`,
        error instanceof ConfigError &&
          new RegExp(
            `^the ${what} ".*" is 195 characters, and ${backend} stores it in a column of 191; use a shorter one$`,
          ).test(error.message),
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
      );
    }
  } else {
    checkEqual(
      `${backend}: a 195-character namespace and queue name work`,
      errors,
      [undefined, undefined],
    );
  }
  await wide.close();
  // Exactly the namespace this section created.
  await driver.purge(long);
}

/* ------------------------------------------------------------------ */
step("Clean up");

for (const queue of queues) {
  await queue.close();
}
// Exactly the namespace this run created — never a prefix sweep.
await driver.purge(namespace);
await driver.close();

summary();
