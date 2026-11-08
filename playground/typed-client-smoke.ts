/**
 * The typed-client section's smoke check: checks that the committed route map
 * is fresh, starts the playground on a free port, runs every scenario on
 * `/playground/client` and asserts what each one shows, follows the dev
 * endpoint with `bun-client generate --url` and `bun-client watch` (in
 * process, as `runCli`) through the "add a route" button, then stops the
 * playground with SIGINT and checks that its token file is gone.
 *
 * ```bash
 * bun playground/typed-client-smoke.ts
 * ```
 *
 * - The committed files: `bun-client generate --module typed-client-api.ts
 *   … --check` exits 0 (`bun run check:client` in `playground/`).
 * - The page and `/state`: the generated module's hash, the zod module's,
 *   the dev endpoint on, its token file `0600`, every scenario with its code.
 * - Every scenario's outcome, what the client sent (statuses, headers,
 *   timing) and what the API saw; `live` over the playground's own socket.
 * - The dev endpoint: refused without the token (404); with it,
 *   `generate --url` gives the committed file byte for byte; the page's
 *   regenerate answers no diff and `--check` 0. After "add a route": the
 *   new route is served, `watch` rewrites its file with it under the new
 *   hash, regenerate shows it as added lines, and `--check` still answers 0
 *   (the code did not change).
 * - The playground runs with `PLAYGROUND_INTERVAL_MS=0` (no simulated jobs)
 *   on its default backend.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import type { DiffLine, ScenarioName, ScenarioRun } from "./typed-client";
import { FILES, GENERATE_ARGS, headerHash, SCENARIOS } from "./typed-client";

/** The playground directory: where the playground runs, and the CLI's working directory. */
const here = import.meta.dir;

let failures = 0;
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

/** `bun-client` in this process: its exit status (a promise: `watch` runs until `signal`) and output so far. */
function cli(argv: string[], signal?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = runCli(argv, {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    cwd: here,
    ...(signal === undefined ? {} : { signal }),
  });
  return { exit, out, err };
}

const committed = await Bun.file(join(here, FILES.gen)).text();
const committedHash = headerHash(committed);

console.log("the committed files: generate --module … --check");
{
  const run = cli([...GENERATE_ARGS, "--check"]);
  check(
    "the committed route map and zod module are fresh",
    (await run.exit) === 0,
    run.err.join("") + run.out.join(""),
  );
}

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

if (
  !(await waitFor(
    "the playground's banner",
    () => /Typed client\s+http:\/\/localhost:\d+/.test(output),
    120_000,
  ))
) {
  child.kill("SIGINT");
  console.log(output);
  process.exit(1);
}
const base =
  /Typed client\s+(http:\/\/localhost:\d+\/playground\/client)/.exec(
    output,
  )?.[1] ?? "";
console.log(`playground pid ${child.pid}, section at ${base}`);

/** What `/state` answers (the parts this check reads). */
interface State {
  /** The generated module. */
  generated: { hash: string; warnings: string[]; code: string; zod: string };
  /** The dev endpoint. */
  dev: {
    enabled: boolean;
    endpoint?: string;
    tokenFile?: string;
    drifted: boolean;
  };
  /** The commands the page shows. */
  commands: { generate: string; check: string; watch?: string };
  /** Every scenario, with its code. */
  scenarios: { name: ScenarioName; snippet: string }[];
}

/** What `/regenerate` answers. */
interface Regenerated {
  /** Where it read the documents. */
  source: string;
  /** The in-process `generate`. */
  generate: { exit: number; hash?: string; stderr: string };
  /** Whether it equals the committed file. */
  same: boolean;
  /** The diff against the committed file. */
  diff: DiffLine[];
  /** `generate --module … --check`. */
  check: { exit: number };
}

/** POSTs to the section and answers the JSON. */
async function post<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, { method: "POST" });
  return { status: response.status, body: (await response.json()) as T };
}

/** Runs one scenario, checking it ran. */
async function run(name: ScenarioName): Promise<ScenarioRun> {
  const { status, body } = await post<ScenarioRun>(`/run/${name}`);
  check(
    `${name}: ran`,
    status === 200 && body.ok,
    `${status} ${JSON.stringify(body.outcome)}`,
  );
  return body;
}

/** `value` as a record, for reading an outcome. */
const rec = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

/** The statuses of a run's sent requests, in order. */
const statuses = (r: ScenarioRun) => r.sent.map((each) => each.status);

let tokenFile: string | undefined;
const scratch = mkdtempSync(join(tmpdir(), "playground-typed-client-"));
try {
  /* -------------------------------------------------------------- */
  console.log("the page and its state");
  const page = await fetch(base);
  const html = await page.text();
  check("the page answers 200", page.status === 200, String(page.status));
  for (const id of ["regenerate", "drift", "calls", "validation", "query"]) {
    check(`the page has #${id}`, html.includes(`id="${id}"`));
  }
  // The whole-app document lists the demo API and not the section's plumbing
  // (its page and support routes are `.describe({ hidden: true })`).
  const whole = (await (
    await fetch(`${base.replace(/\/client$/, "")}/openapi.json`)
  ).json()) as { document: { paths: Record<string, unknown> } };
  const documented = Object.keys(whole.document.paths);
  check(
    "openapi.json: the demo API is documented",
    documented.includes("/playground/client/api/users/{id}"),
  );
  check(
    "openapi.json: the section's plumbing routes are hidden",
    ["", "/state", "/run/{scenario}", "/regenerate", "/drift"].every(
      (each) => !documented.includes(`/playground/client${each}`),
    ) &&
      !documented.includes("/playground/openapi.json") &&
      !documented.includes("/playground/cache/state"),
    documented.filter((p) => !p.startsWith("/jobs-api")).join(" "),
  );
  // The cache lab's cached routes are documented with their responses, so
  // the document carries no "no responses declared" warning for them.
  const warned = (whole as { warnings?: { route?: string; message: string }[] })
    .warnings;
  check(
    "openapi.json: the cached cache-lab routes declare their responses",
    warned !== undefined &&
      !warned.some(
        (w) =>
          (w.route ?? "").startsWith("GET /playground/cache/http/") ||
          (w.route ?? "").startsWith("POST /playground/cache/http/"),
      ) &&
      Object.keys(whole.document.paths).filter((p) =>
        p.startsWith("/playground/cache/http/"),
      ).length === 5,
    JSON.stringify(warned?.filter((w) => (w.route ?? "").includes("/cache/"))),
  );
  // Sections and subsections (docs.ts): every operation carries a tag, and
  // every tag sits in one of the document's x-tagGroups, so Redoc hides none.
  const grouped = whole.document as {
    paths: Record<string, Record<string, { tags?: string[] }>>;
    "x-tagGroups"?: { name: string; tags: string[] }[];
  };
  const sections = grouped["x-tagGroups"] ?? [];
  const inSections = new Set(sections.flatMap((section) => section.tags));
  const untagged = Object.entries(grouped.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(
        ([, operation]) =>
          (operation.tags ?? []).length === 0 ||
          !(operation.tags ?? []).every((tag) => inSections.has(tag)),
      )
      .map(([method]) => `${method} ${path}`),
  );
  check(
    "openapi.json: every operation is tagged, its tags in the sections",
    JSON.stringify(sections.map((section) => section.name)) ===
      JSON.stringify(["Jobs API", "Cache lab", "Typed client", "Validation"]) &&
      untagged.length === 0 &&
      !(warned ?? []).some((w) => w.message.includes("no tag")),
    `${sections.map((section) => section.name).join(", ")}; untagged: ${untagged.join(" ")}`,
  );
  const state = (await (await fetch(`${base}/state`)).json()) as State;
  check(
    "/state: the generated module's hash is the committed one",
    state.generated.hash === committedHash && committedHash !== undefined,
    `${state.generated.hash} vs ${committedHash}`,
  );
  check(
    "/state: the zod module carries the same hash",
    headerHash(state.generated.zod) === committedHash,
  );
  check(
    "/state: the generated module is the committed file",
    state.generated.code === committed,
  );
  check("/state: the dev endpoint is on", state.dev.enabled === true);
  tokenFile = state.dev.tokenFile;
  const endpoint = state.dev.endpoint ?? "";
  check(
    "/state: the token file exists, mode 0600",
    tokenFile !== undefined &&
      existsSync(tokenFile) &&
      (statSync(tokenFile).mode & 0o777) === 0o600,
    tokenFile,
  );
  check(
    "/state: the endpoint is the section's",
    endpoint.endsWith("/playground/client/__bun/types"),
    endpoint,
  );
  check(
    "/state: the watch command names the endpoint and the token file",
    state.commands.watch?.includes(endpoint) === true &&
      state.commands.watch.includes(tokenFile ?? "?"),
    state.commands.watch,
  );
  check(
    "/state: every scenario, each with its code",
    state.scenarios.length === SCENARIOS.length &&
      state.scenarios.every((s) => s.snippet.includes("await")),
    String(state.scenarios.length),
  );
  check(
    "/state: the 404's code shows its checked type",
    state.scenarios
      .find((s) => s.name === "not-found")
      ?.snippet.includes(
        'Equal<typeof r.error.code, "NOT_FOUND" | "GONE"> = true',
      ) === true,
  );

  /* -------------------------------------------------------------- */
  console.log("calls");
  {
    const r = await run("ok");
    const o = rec(r.outcome);
    check(
      "ok: a 200 with Ada",
      o.status === 200 && rec(o.data).name === "Ada",
      JSON.stringify(o),
    );
    check("ok: one request sent", statuses(r).join() === "200");
  }
  {
    const o = rec((await run("not-found")).outcome);
    check(
      "not-found: a 404 with code NOT_FOUND",
      o.status === 404 && o.code === "NOT_FOUND",
      JSON.stringify(o),
    );
  }
  {
    const o = rec((await run("op")).outcome);
    check(
      "op: getUser is a 200, createUser a 409 CONFLICT",
      rec(o.getUser).status === 200 &&
        rec(o.createUser).status === 409 &&
        rec(o.createUser).code === "CONFLICT",
      JSON.stringify(o),
    );
  }
  {
    const o = rec((await run("throw-on-error")).outcome);
    check(
      "throw-on-error: the data, then an HttpError 404",
      o.user === "Ada" &&
        rec(o.thrown).name === "HttpError" &&
        rec(o.thrown).status === 404,
      JSON.stringify(o),
    );
  }
  {
    const o = rec((await run("undeclared")).outcome);
    check(
      "undeclared: UnexpectedStatusError, 418, declared [200]",
      o.name === "UnexpectedStatusError" &&
        o.status === 418 &&
        JSON.stringify(o.declared) === "[200]",
      JSON.stringify(o),
    );
  }
  {
    const r = await run("retry-after");
    const o = rec(r.outcome);
    check(
      "retry-after: a 503 with Retry-After: 1, then a 200",
      statuses(r).join() === "503,200" &&
        r.sent[0]?.response["retry-after"] === "1",
      JSON.stringify(r.sent),
    );
    check(
      "retry-after: the retry waited about the second it was asked to",
      typeof o.waitedMs === "number" && o.waitedMs >= 900 && o.waitedMs < 3000,
      String(o.waitedMs),
    );
    check(
      "retry-after: the second attempt succeeded",
      o.status === 200 && rec(o.data).attempts === 2,
      JSON.stringify(o),
    );
  }
  {
    const r = await run("timeout");
    const o = rec(r.outcome);
    check(
      "timeout: TimeoutError at 250 ms, well before the 2 s answer",
      o.name === "TimeoutError" && o.timeout === 250 && r.ms < 1500,
      `${JSON.stringify(o)} in ${r.ms} ms`,
    );
  }
  {
    const r = await run("middleware");
    const o = rec(r.outcome);
    check(
      "middleware: the server saw the x-request-id it set",
      r.server.length === 1 &&
        r.server[0]?.requestId?.startsWith("pg-1-") === true,
      JSON.stringify(r.server),
    );
    check(
      "middleware: the mocked call sent nothing",
      r.sent.length === 1 && rec(o.mocked).id === "mock",
      JSON.stringify(r.sent),
    );
    check(
      "middleware: it logged both calls",
      Array.isArray(o.log) && o.log.length === 2,
      JSON.stringify(o.log),
    );
  }

  /* -------------------------------------------------------------- */
  console.log("validation");
  {
    const r = await run("request-invalid");
    const o = rec(r.outcome);
    const issue = rec((o.issues as unknown[] | undefined)?.[0]);
    check(
      "request-invalid: a request ValidationError on body.email",
      o.name === "ValidationError" &&
        o.direction === "request" &&
        issue.target === "body" &&
        issue.path === "email",
      JSON.stringify(o),
    );
    check(
      "request-invalid: nothing was sent, and the server saw nothing",
      r.sent.length === 0 && r.server.length === 0,
      JSON.stringify({ sent: r.sent, server: r.server }),
    );
  }
  {
    const r = await run("response-invalid");
    const o = rec(r.outcome);
    check(
      "response-invalid: delivered as it arrived (role owner)",
      o.status === 200 && rec(o.delivered).role === "owner",
      JSON.stringify(o),
    );
    check(
      "response-invalid: one warning, naming the role",
      r.warnings.length === 1 && r.warnings[0].includes("role"),
      JSON.stringify(r.warnings),
    );
  }

  /* -------------------------------------------------------------- */
  console.log("the query layer");
  {
    const o = rec((await run("query-key")).outcome);
    check(
      "query-key: keyed by the route, the manifest's tags filled",
      JSON.stringify(o.queryKey) ===
        JSON.stringify([
          "GET /api/users/:id",
          { params: { id: "42" }, query: {} },
        ]) &&
        JSON.stringify(rec(o.meta).tags) ===
          JSON.stringify(["user:42", "users"]) &&
        o.sameObject === true,
      JSON.stringify(o),
    );
  }
  {
    const r = await run("etag-304");
    const o = rec(r.outcome);
    check(
      "etag-304: a 200, then a conditional request answered 304",
      statuses(r).join() === "200,304" &&
        r.sent[1]?.headers["if-none-match"] === r.sent[0]?.response.etag,
      JSON.stringify(r.sent),
    );
    check(
      "etag-304: the same object kept, dataUpdatedAt moved",
      o.sameObject === true && o.dataUpdatedAtMoved === true,
      JSON.stringify(o),
    );
  }
  {
    const r = await run("invalidates");
    const o = rec(r.outcome);
    check(
      "invalidates: list, create, the list refetched, then the tidy delete",
      r.sent.map((each) => `${each.method} ${each.status}`).join() ===
        "GET 200,POST 201,GET 200,DELETE 204",
      JSON.stringify(r.sent),
    );
    check(
      "invalidates: the refetched list has the new user",
      typeof o.before === "number" && o.after === o.before + 1,
      JSON.stringify(o),
    );
  }
  {
    const r = await run("cache-tag");
    const o = rec(r.outcome);
    const seven = (o.seven ?? []) as string[];
    const eight = (o.eight ?? []) as string[];
    check(
      "cache-tag: org 7 carries team:blue from its Cache-Tag header, org 8 does not",
      seven.includes("team:blue") &&
        eight.includes("team:green") &&
        !eight.includes("team:blue"),
      JSON.stringify(o),
    );
    check(
      "cache-tag: the first answer's Cache-Tag named team:blue",
      r.sent[0]?.response["cache-tag"]?.includes("team:blue") === true,
      JSON.stringify(r.sent[0]),
    );
    const count = (url: string) =>
      r.sent.filter((each) => each.url === url).length;
    check(
      "cache-tag: invalidating team:blue refetched org 7 only",
      count("/api/orgs/7") === 2 && count("/api/orgs/8") === 1,
      JSON.stringify(r.sent.map((each) => each.url)),
    );
  }
  {
    const r = await run("live");
    const o = rec(r.outcome);
    const lists = r.sent.filter((each) => each.url === "/api/users").length;
    check(
      "live: another client's POST /api/users refetched the observed list over the live channel",
      r.ok &&
        typeof o.before === "number" &&
        o.after === (o.before as number) + 1 &&
        lists >= 2,
      JSON.stringify({ o, sent: r.sent.map((each) => each.url) }),
    );
  }
  {
    const r = await run("sse");
    const o = rec(r.outcome);
    const events = (o.events ?? []) as { event: string; id?: string }[];
    check(
      "sse: three typed events, in order, with their ids, and no warning",
      r.ok &&
        events.map((e) => `${e.id} ${e.event}`).join() ===
          "1 progress,2 progress,3 done" &&
        o.lastEventId === "3" &&
        r.warnings.length === 0,
      JSON.stringify({ o, warnings: r.warnings }),
    );
  }
  {
    const r = await run("sse-resume");
    const o = rec(r.outcome);
    check(
      "sse-resume: Last-Event-ID 1 replays 2 and 3; an unknown id gets the gap",
      r.ok &&
        ((o.replayed ?? []) as string[]).join() === "2 progress,3 done" &&
        o.gaps === 1,
      JSON.stringify(o),
    );
    check(
      "sse-resume: the server saw both Last-Event-IDs",
      r.server.map((hit) => hit.lastEventId).join() === "1,from-another-server",
      JSON.stringify(r.server),
    );
  }
  {
    const r = await run("channel");
    const o = rec(r.outcome);
    const said = rec(o.said);
    check(
      "channel: the request resolved with its echoed reply, typed by the chat contract",
      r.ok &&
        o.state === "open" &&
        said.by === "bun-client" &&
        said.text === "hello, room",
      JSON.stringify(r.outcome),
    );
    check(
      "channel: the empty say was refused before it was written",
      ((o.refused ?? []) as string[]).some((line) => line.startsWith("text:")),
      JSON.stringify(o.refused),
    );
  }
  {
    const r = await run("graphql");
    const o = rec(r.outcome);
    const partial = rec(o.partial);
    const errors = (partial.errors ?? []) as { message: string }[];
    check(
      "graphql: complete data typed by the document, then the renamed user over GET",
      r.ok &&
        rec(rec(o.complete).user).name === "Ada" &&
        rec(rec(o.renamed).rename).name === "Ada Lovelace" &&
        rec(rec(o.viaGet).user).name === "Ada Lovelace",
      JSON.stringify(r.outcome),
    );
    check(
      "graphql: an unknown user is ok with errors (partial data), not a failed status",
      partial.ok === true &&
        rec(partial.data).user === null &&
        errors[0]?.message === "No user with that id",
      JSON.stringify(partial),
    );
    check(
      "graphql: throwOnGraphQLErrors threw the same error",
      JSON.stringify(o.thrown) === '["No user with that id"]',
      JSON.stringify(o.thrown),
    );
    check(
      "graphql: the endpoint saw four POSTs and one GET, in order",
      (o.endpointSaw as { method: string; operationName: string }[])
        .map((e) => `${e.method} ${e.operationName}`)
        .join() === "POST User,POST User,POST Rename,GET User,POST User",
      JSON.stringify(o.endpointSaw),
    );
  }
  check(
    "an unknown scenario is a 404",
    (await post("/run/nope")).status === 404,
  );

  /* -------------------------------------------------------------- */
  console.log("the dev endpoint, generate --url and regenerate");
  check(
    "the endpoint without the token is refused as not found",
    (await fetch(endpoint)).status === 404,
  );
  {
    const run = cli([
      "generate",
      "--url",
      endpoint,
      "--token-file",
      tokenFile ?? "",
    ]);
    check(
      "generate --url with the token file gives the committed file, byte for byte",
      (await run.exit) === 0 && run.out.join("") === committed,
      run.err.join(""),
    );
  }
  {
    const { body } = await post<Regenerated>("/regenerate");
    check(
      "regenerate: from the dev endpoint, identical, no diff, --check 0",
      body.source === "dev endpoint" &&
        body.generate.exit === 0 &&
        body.same &&
        body.diff.length === 0 &&
        body.check.exit === 0,
      JSON.stringify(body),
    );
  }

  /* -------------------------------------------------------------- */
  console.log("watch, through the add-a-route button");
  const out = join(scratch, "api.gen.ts");
  const stop = new AbortController();
  const watch = cli(
    ["watch", "--url", endpoint, "--token-file", tokenFile ?? "", "--out", out],
    stop.signal,
  );
  check(
    "watch writes the committed module on start",
    await waitFor(
      "watch's first write",
      async () => existsSync(out) && (await Bun.file(out).text()) === committed,
      15_000,
    ),
    watch.err.join(""),
  );
  check(
    "the extra route is not served yet",
    (await fetch(`${base}/api/users/42/badge`)).status === 404,
  );
  check("add a route answers 200", (await post("/drift")).status === 200);
  const badge = await fetch(`${base}/api/users/42/badge`);
  check(
    "the extra route is served",
    badge.status === 200 &&
      ((await badge.json()) as { badge?: string }).badge === "early adopter",
  );
  check(
    "watch rewrites its file with the new route",
    await waitFor(
      "watch's second write",
      async () =>
        (await Bun.file(out).text()).includes('"GET /api/users/:id/badge"'),
      15_000,
    ),
    watch.out.join("") + watch.err.join(""),
  );
  const rewritten = await Bun.file(out).text();
  {
    const { body } = await post<Regenerated>("/regenerate");
    check(
      "regenerate after: the new hash, as watch wrote it",
      body.generate.hash !== committedHash &&
        body.generate.hash === headerHash(rewritten),
      `${body.generate.hash} vs ${headerHash(rewritten)}`,
    );
    check(
      "regenerate after: the new route is in the diff's added lines, nothing removed but the hash",
      body.diff.some(
        (line) =>
          line.op === "+" && line.text.includes('"GET /api/users/:id/badge"'),
      ) &&
        body.diff
          .filter((line) => line.op === "-")
          .every((line) => line.text.includes("typesHash")),
      JSON.stringify(body.diff.filter((line) => line.op !== " ")),
    );
    check(
      "regenerate after: --check still 0, the code did not change",
      body.check.exit === 0,
    );
  }
  stop.abort();
  check("watch stops with exit 0", (await watch.exit) === 0);
  console.log(
    `  watch said: ${watch.out.join("").trim().split("\n").join(" | ")}`,
  );

  /* -------------------------------------------------------------- */
  console.log("stopping (SIGINT)");
  child.kill("SIGINT");
  const exited = await Promise.race([
    child.exited,
    Bun.sleep(60_000).then(() => "timeout" as const),
  ]);
  check("the playground exits 0 on SIGINT", exited === 0, String(exited));
  await reader;
  check("it logged its shutdown", output.includes("stopping…"));
  check(
    "the token file is gone",
    tokenFile !== undefined && !existsSync(tokenFile),
    tokenFile,
  );
} catch (error) {
  failures++;
  console.log("  FAIL the smoke check threw:", error);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGINT");
    await child.exited;
  }
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
