/**
 * The cache lab's smoke check (plan row PG): starts the playground on a free
 * port, drives every control on `/playground/cache` through `fetch`, asserts
 * the `X-Cache` sequences, stops it with SIGINT, and checks that no process
 * it started and none of the data the lab created is left.
 *
 * ```bash
 * bun playground/cache-smoke.ts                  # memory, file and SQLite only
 * eval "$(bun scripts/setup-databases.ts --print-env)" && bun playground/cache-smoke.ts
 * ```
 *
 * - Every driver the lab lists as available is switched to in turn and runs
 *   the same sequences; the unavailable ones are printed as skipped, with
 *   the variable each needs. A server whose variable is set but which does
 *   not answer fails the check.
 * - The last driver switched to is a server one when any is available, so
 *   the playground's own shutdown has server data to remove.
 * - After the exit: every process in the playground's tree (read from
 *   `/proc` before the SIGINT) must be gone, and every driver the lab opened
 *   must have nothing left at its location (`labDataLeft`, which reads the
 *   same prefixes the cleanup removes, and removes nothing).
 * - The at-rest item (`cache-at-rest.ts`): the encrypted store shows none of
 *   the written key, namespace, tags or value, where the plain store shows
 *   them all; the sealed entry opens by hand from the README's format, its
 *   names recompute by hand, `describeKey` matches the stored row, and the
 *   cache answers the value with the ring's key id. A `POST` writes a new
 *   value, and a bad one is refused.
 * - The playground runs with `PLAYGROUND_INTERVAL_MS=0` (no simulated jobs)
 *   on its default backend. Linux only (`/proc`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { LabDriverInfo, LabDriverKind } from "./cache-drivers";
import type { LabOpening } from "./cache";
import { labDataLeft } from "./cache-drivers";

/** What the lab's `/state` answers (the parts this check reads). */
interface LabState {
  /** The current configuration. */
  config: { driver: LabDriverKind; compress: string; l1: boolean };
  /** Every driver, available or not. */
  drivers: LabDriverInfo[];
  /** Every driver opened this run. */
  openings: LabOpening[];
  /** `cache.stats()`. */
  stats: { bytesWritten: number; evictions: number; l1?: unknown };
}

/** One answer, as the checks read it. */
interface Answer {
  /** The status code. */
  status: number;
  /** `X-Cache`, or `""`. */
  xCache: string;
  /** `Age`, or `null`. */
  age: string | null;
  /** How long it took, in ms. */
  ms: number;
  /** The JSON body. */
  body: Record<string, unknown>;
}

let failures = 0;
/** MISSes seen while waiting for a HIT on a driver whose write lagged its response. */
let writeLagMisses = 0;
let passes = 0;

/** Records one check. */
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === "" ? "" : `: ${detail}`}`);
  }
}

const here = import.meta.dir;
const child = Bun.spawn(["bun", "index.ts"], {
  cwd: here,
  env: { ...process.env, PORT: "0", PLAYGROUND_INTERVAL_MS: "0" },
  stdout: "pipe",
  stderr: "inherit",
});

/** The playground's stdout so far. */
let output = "";
const reader = (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk, { stream: true });
  }
})();

/** Waits for `predicate`, polling every 50 ms, up to `ms`. */
async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  ms = 30_000,
): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) {
      return true;
    }
    await Bun.sleep(50);
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
}

if (
  !(await waitFor(
    "the playground's banner",
    () => /Cache lab\s+http:\/\/localhost:\d+/.test(output),
    120_000,
  ))
) {
  child.kill("SIGINT");
  console.log(output);
  process.exit(1);
}
const base =
  /Cache lab\s+(http:\/\/localhost:\d+\/playground\/cache)/.exec(output)?.[1] ??
  "";
console.log(`playground pid ${child.pid}, lab at ${base}`);

/** Sends one request to the lab. */
async function call(method: "GET" | "POST", path: string): Promise<Answer> {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();
  const ms = performance.now() - started;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return {
    status: response.status,
    xCache: response.headers.get("x-cache") ?? "",
    age: response.headers.get("age"),
    ms,
    body,
  };
}

/** GETs `path` and checks its `X-Cache` (and, for a `MISS`, that the handler ran: at least 100 ms). */
async function expectX(
  label: string,
  path: string,
  expected: string,
): Promise<Answer> {
  let answer = await call("GET", path);
  // A miss's write never delays its response (bun-cache's http README), so
  // on a driver with slow writes (Azure's several round trips) the request
  // right behind it can miss too. A HIT is waited for, up to 5 s, and the
  // lagging misses are counted.
  const until = Date.now() + 5_000;
  if (expected === "HIT") {
    while (answer.xCache === "MISS" && Date.now() < until) {
      writeLagMisses++;
      await Bun.sleep(100);
      answer = await call("GET", path);
    }
  }
  check(
    `${label}: GET ${path} is ${expected}`,
    answer.xCache === expected,
    `got ${answer.xCache || "(none)"} (${answer.status})`,
  );
  if (expected === "MISS") {
    check(
      `${label}: a MISS ran the 120 ms handler`,
      answer.ms >= 100,
      `${answer.ms.toFixed(0)} ms`,
    );
  }
  if (expected === "HIT" || expected === "STALE") {
    check(
      `${label}: a ${expected} carries Age`,
      answer.age !== null && /^\d+$/.test(answer.age),
      `Age ${answer.age}`,
    );
  }
  return answer;
}

/** POSTs a control and answers its body. */
async function control(path: string): Promise<Answer> {
  const answer = await call("POST", path);
  check(
    `POST ${path} answers 200`,
    answer.status === 200,
    `${answer.status} ${JSON.stringify(answer.body)}`,
  );
  return answer;
}

/** The lab's state. */
async function state(): Promise<LabState> {
  return (await call("GET", "/state")).body as unknown as LabState;
}

/** The sequences every driver runs. */
async function sequences(label: string): Promise<void> {
  // Fresh, BYPASS, and the two invalidations.
  await expectX(label, "/http/item/1", "MISS");
  await expectX(label, "/http/item/1", "HIT");
  await expectX(label, "/http/item/1?bypass=1", "BYPASS");
  await expectX(label, "/http/item/1", "HIT");
  await control(
    `/invalidate-path?path=${encodeURIComponent("/playground/cache/http/item/1")}`,
  );
  await expectX(label, "/http/item/1", "MISS");
  await expectX(label, "/http/item/1", "HIT");
  await control(`/invalidate?tag=${encodeURIComponent("item:1")}`);
  await expectX(label, "/http/item/1", "MISS");
  await expectX(label, "/http/item/2", "MISS");
  await control("/invalidate?tag=items");
  await expectX(label, "/http/item/1", "MISS");
  await expectX(label, "/http/item/2", "MISS");
  await expectX(label, "/http/item/2", "HIT");
  // An unsafe method through the middleware drops its path's entries.
  await control("/http/item/2");
  await expectX(label, "/http/item/2", "MISS");
  // Never stored.
  await expectX(label, "/http/private", "UNCACHEABLE");
  await expectX(label, "/http/private", "UNCACHEABLE");

  // Stale-while-revalidate: STALE (the old build), then the replay's build.
  // The stored build is the HIT's (a lagging write can make it the second MISS's).
  await expectX(label, "/http/swr", "MISS");
  const first = await expectX(label, "/http/swr", "HIT");
  await Bun.sleep(2_200);
  const stale = await expectX(label, "/http/swr", "STALE");
  check(
    `${label}: the STALE answer is the old build`,
    stale.body.build === first.body.build,
    JSON.stringify(stale.body),
  );
  let refreshed: Answer | undefined;
  await waitFor(
    `${label}: the replay's build`,
    async () => {
      refreshed = await call("GET", "/http/swr");
      return (
        refreshed.xCache === "HIT" && refreshed.body.build !== first.body.build
      );
    },
    10_000,
  );
  check(
    `${label}: after the replay, a HIT on a new build`,
    refreshed?.xCache === "HIT" && refreshed.body.build !== first.body.build,
    JSON.stringify(refreshed),
  );

  // Stale-if-error: the 503 is replaced by the stale copy.
  await expectX(label, "/http/sie", "MISS");
  const kept = await expectX(label, "/http/sie", "HIT");
  await control("/sie?failing=true");
  await Bun.sleep(2_200);
  const rescued = await expectX(label, "/http/sie", "STALE");
  check(
    `${label}: stale-if-error answers 200 with the kept build`,
    rescued.status === 200 && rescued.body.build === kept.body.build,
    `${rescued.status} ${JSON.stringify(rescued.body)}`,
  );
  await control("/sie?failing=false");
  await expectX(label, "/http/sie", "MISS");
  await expectX(label, "/http/sie", "HIT");

  // A load fenced by a delete in its middle.
  const fence = await control("/fence");
  check(
    `${label}: the fence demo drops the write`,
    fence.body.fenced === 1 &&
      JSON.stringify(fence.body.reasons) === '["local"]' &&
      fence.body.stored === false,
    JSON.stringify(fence.body),
  );
}

/** The at-rest item's checks, on the answer of a GET or POST of `/at-rest`. */
function checkAtRest(label: string, answer: Answer, note: string): void {
  const body = answer.body as {
    written?: { key: string; value: Record<string, unknown> };
    sealed?: {
      store: {
        entries: { n?: number }[];
        plaintextFound: Record<string, boolean>;
      };
      envelope: {
        opened?: boolean;
        fields?: {
          magic: string;
          version: number;
          cipherId: number;
          keyId: string;
        };
        entry?: { magic: string; key: string; value: unknown };
        sizes?: { overhead: number; formula: string };
      };
      namesByHand: { matchDescribeKey: boolean };
      cache: {
        describeKeyMatchesStore: boolean;
        get: unknown;
        hitKeyId: string | null;
        counter: unknown;
      };
    };
    plain?: {
      store: { plaintextFound: Record<string, boolean> };
      entry: { magic: string; key: string };
      cache: {
        describeKeyMatchesStore: boolean;
        get: unknown;
        hitKeyId: string | null;
      };
    };
  };
  check(`${label}: answers 200`, answer.status === 200, String(answer.status));
  const { written, sealed, plain } = body;
  if (written === undefined || sealed === undefined || plain === undefined) {
    check(
      `${label}: has written, sealed and plain`,
      false,
      JSON.stringify(body),
    );
    return;
  }
  const shown = (found: Record<string, boolean>) =>
    Object.entries(found)
      .filter(([, seen]) => seen)
      .map(([needle]) => needle);
  check(
    `${label}: the encrypted store shows no plaintext`,
    Object.keys(sealed.store.plaintextFound).length >= 5 &&
      shown(sealed.store.plaintextFound).length === 0,
    JSON.stringify(sealed.store.plaintextFound),
  );
  check(
    `${label}: the plain store shows every needle (the scan can see)`,
    Object.values(plain.store.plaintextFound).every(Boolean),
    JSON.stringify(plain.store.plaintextFound),
  );
  const envelope = sealed.envelope;
  check(
    `${label}: the sealed entry opens by hand from the README's format`,
    envelope.opened === true &&
      envelope.fields?.magic === "BE" &&
      envelope.fields.version === 1 &&
      envelope.fields.cipherId === 1 &&
      envelope.fields.keyId === "playground-1" &&
      envelope.entry?.magic === "BC" &&
      envelope.entry.key === written.key &&
      JSON.stringify(envelope.entry.value) === JSON.stringify(written.value),
    JSON.stringify(envelope),
  );
  check(
    `${label}: the sealed size is the README's overhead`,
    envelope.sizes !== undefined &&
      envelope.sizes.formula.endsWith(`= ${envelope.sizes.overhead}`),
    JSON.stringify(envelope.sizes),
  );
  check(
    `${label}: the names recompute by hand to describeKey's`,
    sealed.namesByHand.matchDescribeKey,
  );
  check(
    `${label}: describeKey names the stored rows`,
    sealed.cache.describeKeyMatchesStore && plain.cache.describeKeyMatchesStore,
  );
  check(
    `${label}: both caches answer the value, the encrypted one with its key id`,
    JSON.stringify(sealed.cache.get) === JSON.stringify(written.value) &&
      JSON.stringify(plain.cache.get) === JSON.stringify(written.value) &&
      sealed.cache.hitKeyId === "playground-1" &&
      plain.cache.hitKeyId === null &&
      written.value.note === note,
    JSON.stringify({ sealed: sealed.cache, plain: plain.cache }),
  );
  check(
    `${label}: the counter's value is a plaintext integer in the encrypted store`,
    sealed.cache.counter === 1 &&
      sealed.store.entries.some((row) => row.n === 1),
    JSON.stringify(sealed.store.entries.map((row) => row.n)),
  );
  check(
    `${label}: the plain entry carries its key in clear`,
    plain.entry.magic === "BC" && plain.entry.key === written.key,
    JSON.stringify(plain.entry),
  );
}

/** Switches the lab; answers whether it switched. */
async function switchTo(query: string): Promise<boolean> {
  const answer = await call("POST", `/config?${query}`);
  check(
    `switch ${query}`,
    answer.status === 200,
    `${answer.status} ${JSON.stringify(answer.body.error ?? "")}`,
  );
  return answer.status === 200;
}

/** Every pid in `root`'s process tree, from `/proc`. */
function processTree(root: number): number[] {
  const parents = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The ppid is the second field after the parenthesised command.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parents.set(ppid, [...(parents.get(ppid) ?? []), Number(name)]);
    } catch {
      // gone meanwhile
    }
  }
  const tree: number[] = [root];
  for (let at = 0; at < tree.length; at++) {
    tree.push(...(parents.get(tree[at] ?? -1) ?? []));
  }
  return tree;
}

/** Whether `pid` is alive (and not a zombie awaiting its parent). */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
    );
  } catch {
    return false;
  }
}

try {
  /* -------------------------------------------------------------- */
  const initial = await state();
  check(
    "starts on memory, zstd, L1 on",
    initial.config.driver === "memory" &&
      initial.config.compress === "zstd" &&
      initial.config.l1,
    JSON.stringify(initial.config),
  );
  const page = await fetch(base);
  const html = await page.text();
  check(
    "the page is HTML with the controls",
    page.status === 200 &&
      (page.headers.get("content-type") ?? "").includes("text/html") &&
      html.includes("Playground cache") &&
      html.includes('data-get="/http/swr"'),
    `${page.status}`,
  );
  const available = initial.drivers.filter((driver) => driver.available);
  for (const skipped of initial.drivers.filter((driver) => !driver.available)) {
    console.log(`  skipped ${skipped.kind}: ${skipped.reason ?? ""}`);
  }
  check(
    "an unavailable driver is refused",
    (await call("POST", "/config?driver=cloudflare-kv")).status === 400,
  );
  check(
    "an unknown compression is refused",
    (await call("POST", "/config?compress=lz4")).status === 400,
  );

  /* -------------------------------------------------------------- */
  console.log("at rest: the encrypted and plain stores, opened by hand");
  checkAtRest(
    "at-rest GET",
    await call("GET", "/at-rest"),
    "a value the store should never show",
  );
  const note = "a second note, still hidden";
  checkAtRest(
    "at-rest POST",
    await call(
      "POST",
      `/at-rest?key=${encodeURIComponent("user:grace@example.com")}&note=${encodeURIComponent(note)}`,
    ),
    note,
  );
  check(
    "at-rest: a key with a control character is refused",
    (await call("POST", `/at-rest?key=${encodeURIComponent("a\nb")}`))
      .status === 400,
  );
  check(
    "the page has the at-rest section",
    html.includes('id="at-rest-write"'),
  );

  /* -------------------------------------------------------------- */
  console.log("memory: the full sequences, L1, evictions, compression");
  await sequences("memory");
  check(
    "stats().l1 is present with L1 on",
    (await state()).stats.l1 !== undefined,
  );
  const fill = await control("/fill?count=100");
  check(
    "memory: filling 100 against a cap of 64 evicts",
    typeof fill.body.evictions === "number" && fill.body.evictions >= 36,
    JSON.stringify(fill.body),
  );
  check("stats().evictions counts them", (await state()).stats.evictions >= 36);
  const written = new Map<string, number>();
  for (const compress of ["off", "zstd", "gzip", "br", "deflate"]) {
    await switchTo(`driver=memory&compress=${compress}&l1=true`);
    const before = (await state()).stats.bytesWritten;
    await expectX(`memory/${compress}`, "/http/big", "MISS");
    await expectX(`memory/${compress}`, "/http/big", "HIT");
    written.set(compress, (await state()).stats.bytesWritten - before);
  }
  console.log(
    `  bytes written for GET big: ${JSON.stringify(Object.fromEntries(written))}`,
  );
  const uncompressed = written.get("off") ?? 0;
  for (const compress of ["zstd", "gzip", "br", "deflate"]) {
    check(
      `${compress} writes under a quarter of uncompressed`,
      (written.get(compress) ?? 0) > 0 &&
        (written.get(compress) ?? 0) * 4 < uncompressed,
      `${written.get(compress)} vs ${uncompressed}`,
    );
  }
  await switchTo("driver=memory&compress=zstd&l1=false");
  check(
    "stats().l1 is absent with L1 off",
    (await state()).stats.l1 === undefined,
  );
  await expectX("memory/no-l1", "/http/item/1", "MISS");
  await expectX("memory/no-l1", "/http/item/1", "HIT");

  /* -------------------------------------------------------------- */
  // Every other driver, the servers last, so shutdown removes a server's data.
  const others = available
    .map((driver) => driver.kind)
    .filter((kind) => kind !== "memory");
  for (const kind of others) {
    console.log(`${kind}: the sequences`);
    if (await switchTo(`driver=${kind}&compress=zstd&l1=true`)) {
      await sequences(kind);
    }
  }

  /* -------------------------------------------------------------- */
  const final = await state();
  const tree = processTree(child.pid);
  console.log(
    `stopping (SIGINT); ${final.openings.length} driver openings, ${tree.length} processes in the tree`,
  );
  child.kill("SIGINT");
  const exited = await Promise.race([
    child.exited,
    Bun.sleep(60_000).then(() => "timeout" as const),
  ]);
  check("the playground exits 0 on SIGINT", exited === 0, String(exited));
  await reader;
  check("it logged its shutdown", output.includes("stopping…"));
  await waitFor(
    "the tree to exit",
    () => tree.every((pid) => !alive(pid)),
    10_000,
  );
  const left = tree.filter((pid) => alive(pid));
  check(
    "no process of its tree is left",
    left.length === 0,
    `left: ${left.join(", ")}`,
  );

  for (const opening of final.openings) {
    const count = await labDataLeft(opening);
    check(
      `${opening.kind} at ${opening.location}: nothing left`,
      count === 0,
      `${count} left`,
    );
  }
  const ownDir = join(here, ".data", `cache-${child.pid}`);
  check(`${ownDir} is gone`, !existsSync(ownDir));
  const tempDb = join(here, ".data", `temp-${child.pid}.db`);
  check(`${tempDb} is gone`, !existsSync(tempDb));
} catch (error) {
  failures++;
  console.log("  FAIL the smoke check threw:", error);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGINT");
    await child.exited;
  }
}

console.log(
  `\n${passes} checks passed, ${failures} failed (${writeLagMisses} MISS before an expected HIT, waited out: the write lagged the response)`,
);
process.exit(failures === 0 ? 0 : 1);
