import type {
  LocalComputeOptions,
  ProviderCallContext,
  SummonFacet,
  SummonRequest,
  SummonResult,
  UnitStatus,
} from "../../lib/provider/index";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  ConfigError,
  CHILD_BASE_ENV as ROOT_CHILD_BASE_ENV,
} from "../../lib/index";
import { providerCallContext } from "../../lib/provider/context";
import {
  CHILD_BASE_ENV,
  localCompute,
  ProviderError,
  removeCgroupTree,
} from "../../lib/provider/index";
import { factProblem } from "../../lib/provider/redact";
import { unitEnv } from "../../lib/providers/local/config";
import { liveUnits, startUnit } from "../../lib/providers/local/units";
import { buildChildEnv } from "../../lib/shared/childEnv";
import { SUMMON_ARGS } from "../../lib/summon/args";
import { makeTmpDir } from "../helpers";

/**
 * `localCompute` on real child processes: the options, the environment a
 * unit really receives, its arguments, `status()`, `cancel()`, `maxUnits`,
 * dedupe, the lifetime backstop, the output sinks, `validate()`, and that
 * no unit outlives its host. Timings are lower bounds and generous upper
 * bounds only: these run beside other suites on a loaded machine.
 */

setDefaultTimeout(60_000);

const UNIT = join(import.meta.dir, "../fixtures/local/unit.ts");
const HOST = join(import.meta.dir, "../fixtures/local/host.ts");
const ENV_HOST = join(import.meta.dir, "../fixtures/local/env-host.ts");

/** Host processes a test started, killed after it if still running. */
const hosts: Bun.Subprocess[] = [];
afterEach(() => {
  for (const proc of hosts.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  }
});

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A temporary directory, removed after the file. */
async function tmp(): Promise<string> {
  const dir = await makeTmpDir("bun-jobs-local");
  cleanups.push(dir.cleanup);
  return dir.path;
}

/** Facets and handles a test started, cancelled after it. */
const started: { facet: SummonFacet; handles: string[] }[] = [];
/** Pids a test's units reported, killed after it if still alive. */
const pids: number[] = [];
afterEach(async () => {
  for (const { facet, handles } of started.splice(0)) {
    await facet.cancel?.(handles, context()).catch(() => {});
  }
  for (const pid of pids.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});

/** The pid of the `sleep 987` a spawner unit started, from its log. */
async function childPid(file: string, withinMs = 20_000): Promise<number> {
  const by = Date.now() + withinMs;
  while (Date.now() < by) {
    const log = existsSync(`${file}.log`)
      ? readFileSync(`${file}.log`, "utf8")
      : "";
    const match = /^child (\d+)$/m.exec(log);
    if (match !== null) {
      const pid = Number(match[1]);
      pids.push(pid);
      return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error(`no child pid in ${file}.log within ${withinMs} ms`);
}

/** A call context with a live signal, or `signal`. */
function context(signal?: AbortSignal): ProviderCallContext {
  return providerCallContext(
    signal ?? new AbortController().signal,
    noopLogger,
  );
}

let seq = 0;

/** A summon request as the controller builds one. */
function request(overrides: Partial<SummonRequest> = {}): SummonRequest {
  const id = overrides.id ?? `sm_local${++seq}x${Date.now()}`;
  return {
    namespace: "local-test",
    queue: "work",
    id,
    dedupeKey: id.replace(/[^A-Z0-9-]/gi, "-"),
    count: 1,
    target: 1,
    demand: {
      at: Date.now(),
      paused: false,
      waiting: 1,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: null,
      demand: 1,
      outstanding: 1,
      capped: false,
      exact: true,
    },
    reason: "manual",
    env: {},
    argv: [
      `${SUMMON_ARGS.id}=${id}`,
      `${SUMMON_ARGS.kind}=local`,
      `${SUMMON_ARGS.namespace}=local-test`,
      `${SUMMON_ARGS.queue}=work`,
      `${SUMMON_ARGS.maxLifetimeMs}=60000`,
      `${SUMMON_ARGS.graceMs}=500`,
    ],
    maxLifetimeMs: 60_000,
    ...overrides,
  };
}

/** Summons through `facet`, remembering what it started for cleanup. */
async function summon(
  facet: SummonFacet,
  req: SummonRequest = request(),
  ctx: ProviderCallContext = context(),
): Promise<SummonResult> {
  const result = await facet.summon(req, ctx);
  if ("handles" in result && result.handles !== undefined) {
    started.push({ facet, handles: [...result.handles] });
  }
  return result;
}

/** The handles of a result, asserting it started some. */
function handlesOf(result: SummonResult): string[] {
  expect(result.status).toBe("started");
  return (result as { handles: string[] }).handles;
}

/** A unit fixture's report. */
interface Report {
  /** Its pid. */
  pid: number;
  /** Its argv after the script. */
  argv: string[];
  /** Its environment. */
  env: Record<string, string>;
  /** What `summonedFromArgs()` read. */
  summon: { id: string; namespace?: string; queue?: string } | null;
}

/** Waits for a unit's report file and reads it. */
async function report(file: string, withinMs = 20_000): Promise<Report> {
  const by = Date.now() + withinMs;
  while (Date.now() < by) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Report;
        pids.push(parsed.pid);
        return parsed;
      } catch {
        // Half written: read again.
      }
    }
    await Bun.sleep(20);
  }
  throw new Error(`no report at ${file} within ${withinMs} ms`);
}

/** Whether a process exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` is gone; `false` if it is still there after `withinMs`. */
async function gone(pid: number, withinMs = 20_000): Promise<boolean> {
  const by = Date.now() + withinMs;
  while (Date.now() < by) {
    if (!alive(pid)) {
      return true;
    }
    await Bun.sleep(25);
  }
  return !alive(pid);
}

/** Polls `status()` until `until` holds for the unit, or `withinMs` passes. */
async function statusUntil(
  facet: SummonFacet,
  handle: string,
  until: (unit: UnitStatus) => boolean,
  withinMs = 20_000,
): Promise<UnitStatus> {
  const by = Date.now() + withinMs;
  let unit: UnitStatus | undefined;
  while (Date.now() < by) {
    [unit] = await facet.status!([handle], context());
    if (unit !== undefined && until(unit)) {
      return unit;
    }
    await Bun.sleep(25);
  }
  return unit!;
}

/** A configured local provider running the unit fixture in `mode`. */
function unitProvider(
  mode: string,
  file: string,
  options: Partial<LocalComputeOptions> = {},
): ReturnType<typeof localCompute> {
  return localCompute({
    entry: UNIT,
    args: [mode, file],
    output: "ignore",
    shutdown: { graceMs: 500 },
    ...options,
  });
}

/** The issue paths of a `ConfigError` thrown by `fn`. */
function issuePaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).context?.issues as
      | { path?: unknown }[]
      | undefined;
    return (issues ?? []).map((issue) => String(issue.path));
  }
  throw new Error("expected a ConfigError");
}

describe("localCompute: loading", () => {
  // Its module imports the ./provider entry and calls defineComputeProvider
  // as it loads: whichever module a process loads first, it must work.
  for (const first of [
    "@kingsleyweb/bun-jobs/provider",
    "@kingsleyweb/bun-jobs/lib/providers/local.ts",
    "@kingsleyweb/bun-jobs/lib/providers/local/config.ts",
    "@kingsleyweb/bun-jobs/lib/providers/local/units.ts",
    "@kingsleyweb/bun-jobs",
  ]) {
    it(`loads when ${first} is the first module`, async () => {
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(first)}); const p = await import("@kingsleyweb/bun-jobs/provider"); console.log(typeof p.localCompute({ entry: "/w.ts" }).summon.summon, Object.keys(m).length > 0);`,
        ],
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ out: out.trim(), err: err.trim(), code }).toEqual({
        out: "function true",
        err: "",
        code: 0,
      });
    });
  }
});

describe("localCompute: options", () => {
  it("fills every default", () => {
    const local = localCompute({ entry: UNIT });
    expect(local.config).toMatchObject({
      entry: UNIT,
      cwd: process.cwd(),
      args: [],
      bun: process.execPath,
      env: {},
      passEnv: [],
      maxUnits: availableParallelism(),
      bootBudgetMs: 30_000,
      maxLifetimeMs: null,
      signal: "SIGTERM",
      graceMs: 10_000,
      output: { kind: "inherit" },
    });
    expect(local.config.cgroup).toBeUndefined();
  });

  it("resolves the entry: a file URL, its string form, or a path relative to cwd", async () => {
    const dir = await tmp();
    expect(localCompute({ entry: pathToFileURL(UNIT) }).config.entry).toBe(
      UNIT,
    );
    expect(localCompute({ entry: pathToFileURL(UNIT).href }).config.entry).toBe(
      UNIT,
    );
    const relative = localCompute({ entry: "./w.ts", cwd: dir });
    expect(relative.config.entry).toBe(join(dir, "w.ts"));
    expect(relative.config.cwd).toBe(dir);
  });

  it("refuses each malformed option, naming it", () => {
    expect(issuePaths(() => localCompute({} as LocalComputeOptions))).toEqual([
      "entry",
    ]);
    expect(
      issuePaths(() => localCompute({ entry: new URL("https://x.test/w.ts") })),
    ).toEqual(["entry"]);
    expect(
      issuePaths(() => localCompute({ entry: "https://x.test/w.ts" })),
    ).toEqual(["entry"]);
    const bad: [
      Partial<LocalComputeOptions> & Record<string, unknown>,
      string,
    ][] = [
      [{ maxUnits: 0 }, "maxUnits"],
      [{ maxUnits: 1.5 }, "maxUnits"],
      [{ bootBudget: -1 }, "bootBudget"],
      [{ maxLifetime: 0 }, "maxLifetime"],
      [{ shutdown: { graceMs: -1 } }, "shutdown"],
      [{ shutdown: { signal: "SIGKILL" as "SIGTERM" } }, "shutdown"],
      [{ env: "all" as "inherit" }, "env"],
      [{ env: ["A"] as unknown as Record<string, string> }, "env"],
      [{ passEnv: ["A=B"] }, "passEnv"],
      [{ env: "inherit", passEnv: ["A"] }, "passEnv"],
      [{ env: { A: 1 as unknown as string } }, "env"],
      [{ output: "stdout" as "inherit" }, "output"],
      [{ cgroup: "relative/jobs" }, "cgroup"],
      [{ args: [1 as unknown as string] }, "args"],
      [{ bun: "" }, "bun"],
      [{ cwd: "" }, "cwd"],
    ];
    for (const [options, path] of bad) {
      expect(
        issuePaths(() => localCompute({ entry: UNIT, ...options })),
      ).toEqual([path]);
    }
  });

  it("takes names to pass, literal values, removals, inherit, and a cap on lifetime", () => {
    expect(
      localCompute({ entry: UNIT, passEnv: ["DATABASE_URL"] }).config,
    ).toMatchObject({ env: {}, passEnv: ["DATABASE_URL"] });
    expect(
      localCompute({ entry: UNIT, env: { A: "1", TZ: undefined } }).config.env,
    ).toEqual({ A: "1", TZ: undefined });
    expect(localCompute({ entry: UNIT, env: "inherit" }).config.env).toBe(
      "inherit",
    );
    // The child-process target's own list, not a copy of it.
    expect(CHILD_BASE_ENV).toBe(ROOT_CHILD_BASE_ENV);
    expect(CHILD_BASE_ENV).toContain("NODE_EXTRA_CA_CERTS");
    expect(CHILD_BASE_ENV).not.toContain("HTTP_PROXY");
    const capped = localCompute({ entry: UNIT, maxLifetime: 600_000 });
    expect(capped.summon.capabilities.maxLifetimeMs).toBe(600_000);
  });
});

describe("localCompute: declarations", () => {
  it("declares a launch style, per-instance token dedupe, argv, its budget, shutdown and capacity", () => {
    const local = localCompute({
      entry: UNIT,
      maxUnits: 3,
      bootBudget: 12_000,
      shutdown: { signal: "SIGINT", graceMs: 4_000 },
    });
    expect(local.provider).toMatchObject({
      name: "@kingsleyweb/bun-jobs:local",
      kind: "local",
    });
    expect(local.summon.capabilities).toEqual({
      style: "launch",
      dedupe: {
        kind: "token",
        maxLength: 64,
        charset: "A-Za-z0-9-",
        scope: "instance",
        ttlMs: 3_600_000,
        strict: false,
      },
      passes: "argv",
      bootBudgetMs: 12_000,
      shutdown: { signal: "SIGINT", graceMs: 4_000 },
      maxLifetimeMs: null,
      enforcesLifetime: true,
      maxCountPerCall: 3,
    });
  });

  it("describes itself with facts the status route serves, and no environment value", () => {
    const local = localCompute({
      entry: UNIT,
      maxUnits: 2,
      env: { DATABASE_URL: "postgres://user:hunter2hunter2@db/x" },
      passEnv: ["REDIS_URL"],
    });
    const facts = local.describe();
    expect(facts).toEqual({
      host: expect.any(String),
      pid: String(process.pid),
      maxUnits: "2",
      entry: UNIT,
      runtime: `bun ${Bun.version}`,
      env: "allowlist",
      output: "inherit",
    });
    for (const [key, value] of Object.entries(facts)) {
      expect(factProblem(key, value)).toBeUndefined();
    }
    expect(JSON.stringify(facts)).not.toContain("hunter2");
  });
});

describe("localCompute: a unit", () => {
  it("runs the entry with its args, then the summon arguments, which summonedFromArgs reads", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("exit", file);
    const req = request();
    const [handle] = handlesOf(await summon(local.summon, req));
    expect(handle).toMatch(new RegExp(`^local-${process.pid}-\\d+$`));
    const seen = await report(file);
    expect(seen.argv).toEqual(["exit", file, ...req.argv]);
    expect(seen.summon).toMatchObject({
      id: req.id,
      namespace: "local-test",
      queue: "work",
    });
    const done = await statusUntil(
      local.summon,
      handle!,
      (unit) => unit.state !== "running",
    );
    expect(done).toEqual({ handle: handle!, state: "exited", exitCode: 0 });
  });

  it("gets the allowlist from the live environment, never a deleted or unlisted variable", async () => {
    const dir = await tmp();
    process.env.LOCAL_TEST_SECRET = "s3cret-value-from-the-host";
    process.env.LOCAL_TEST_LISTED = "listed-value";
    process.env.LOCAL_TEST_DELETED = "deleted-value";
    delete process.env.LOCAL_TEST_DELETED;
    process.env.BUN_JOBS_CHILD = "1";
    try {
      const allow = await report(
        await (async () => {
          const file = join(dir, "allow.json");
          await summon(
            unitProvider("exit", file).summon,
            request({ env: { FROM_POLICY: "policy-value" } }),
          );
          return file;
        })(),
      );
      expect(allow.env.PATH).toBe(process.env.PATH!);
      expect(allow.env.HOME).toBe(process.env.HOME!);
      expect(allow.env.FROM_POLICY).toBe("policy-value");
      expect(allow.env.LOCAL_TEST_SECRET).toBeUndefined();
      expect(allow.env.LOCAL_TEST_LISTED).toBeUndefined();
      expect(allow.env.LOCAL_TEST_DELETED).toBeUndefined();
      expect(allow.env.BUN_JOBS_CHILD).toBeUndefined();
      // The runner-child marker removed, so provenance is read.
      expect(allow.summon).not.toBeNull();

      const listedFile = join(dir, "listed.json");
      await summon(
        unitProvider("exit", listedFile, {
          passEnv: ["LOCAL_TEST_LISTED", "LOCAL_TEST_DELETED"],
        }).summon,
      );
      const listed = await report(listedFile);
      expect(listed.env.LOCAL_TEST_LISTED).toBe("listed-value");
      expect(listed.env.LOCAL_TEST_DELETED).toBeUndefined();
      expect(listed.env.LOCAL_TEST_SECRET).toBeUndefined();
      expect(listed.env.PATH).toBe(process.env.PATH!);

      const valuesFile = join(dir, "values.json");
      await summon(
        unitProvider("exit", valuesFile, {
          env: { GIVEN: "given-value", HOME: undefined },
        }).summon,
      );
      const values = await report(valuesFile);
      expect(values.env.GIVEN).toBe("given-value");
      expect(values.env.HOME).toBeUndefined();
      expect(values.env.PATH).toBe(process.env.PATH!);
      expect(values.env.LOCAL_TEST_SECRET).toBeUndefined();

      const inheritFile = join(dir, "inherit.json");
      await summon(
        unitProvider("exit", inheritFile, { env: "inherit" }).summon,
      );
      const inherited = await report(inheritFile);
      expect(inherited.env.LOCAL_TEST_SECRET).toBe(
        "s3cret-value-from-the-host",
      );
      expect(inherited.env.LOCAL_TEST_DELETED).toBeUndefined();
      expect(inherited.env.BUN_JOBS_CHILD).toBeUndefined();
    } finally {
      delete process.env.LOCAL_TEST_SECRET;
      delete process.env.LOCAL_TEST_LISTED;
      delete process.env.BUN_JOBS_CHILD;
    }
  });

  it("builds the same environment as the child-process target's buildChildEnv", () => {
    // One table through both builders, so they cannot drift apart again.
    const source: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      TZ: "UTC",
      SECRET: "s3cret",
      LISTED: "listed",
      EMPTY: "",
      GONE: undefined,
    };
    const cases: {
      env?: "inherit" | Record<string, string | undefined>;
      passEnv?: string[];
    }[] = [
      {},
      { passEnv: ["LISTED", "MISSING", "GONE", "EMPTY"] },
      // Inherited from Object.prototype, not variables: never copied.
      { passEnv: ["toString", "constructor", "hasOwnProperty", "valueOf"] },
      { env: { GIVEN: "given", TZ: undefined, HOME: "/elsewhere" } },
      { env: { LISTED: undefined }, passEnv: ["LISTED"] },
      { env: "inherit" },
    ];
    for (const policy of cases) {
      const { config } = localCompute({ entry: UNIT, ...policy });
      expect(unitEnv(config, {}, CHILD_BASE_ENV, source)).toEqual(
        buildChildEnv(policy, source),
      );
    }
    const prototypeNames = unitEnv(
      localCompute({ entry: UNIT, passEnv: ["toString", "constructor"] })
        .config,
      {},
      CHILD_BASE_ENV,
    );
    expect(Object.hasOwn(prototypeNames, "toString")).toBe(false);
    expect(Object.hasOwn(prototypeNames, "constructor")).toBe(false);
  });

  it("never passes a variable the host started with and then deleted, whatever the policy", async () => {
    const dir = await tmp();
    for (const mode of ["allowlist", "inherit"]) {
      const file = join(dir, `${mode}.json`);
      const proc = Bun.spawn({
        cmd: [process.execPath, ENV_HOST, file, mode],
        env: { ...process.env, LOCAL_TEST_STARTUP: "from-startup" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      });
      hosts.push(proc);
      expect(await proc.exited).toBe(0);
      const seen = await report(file);
      expect(seen.env.LOCAL_TEST_STARTUP).toBeUndefined();
      expect(seen.env.PATH).toBe(process.env.PATH!);
    }
  });

  it("keeps a .env in the unit's cwd out under the allowlist, not under inherit", async () => {
    const dir = await tmp();
    writeFileSync(join(dir, ".env"), "LOCAL_TEST_DOTENV=from-dotenv\n");
    const allowFile = join(dir, "allow.json");
    await summon(unitProvider("exit", allowFile, { cwd: dir }).summon);
    expect((await report(allowFile)).env.LOCAL_TEST_DOTENV).toBeUndefined();
    const inheritFile = join(dir, "inherit.json");
    await summon(
      unitProvider("exit", inheritFile, { cwd: dir, env: "inherit" }).summon,
    );
    // Inherit is the host's behaviour, Bun's own .env loading included.
    expect((await report(inheritFile)).env.LOCAL_TEST_DOTENV).toBe(
      "from-dotenv",
    );
  });

  it("reports a crash: failed, its exit code, and its last stderr line", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("crash", file);
    const [handle] = handlesOf(await summon(local.summon));
    const crashed = await statusUntil(
      local.summon,
      handle!,
      (unit) => unit.state !== "running" && unit.detail !== `exit 3`,
    );
    expect(crashed).toEqual({
      handle: handle!,
      state: "failed",
      exitCode: 3,
      detail: "fatal: cannot open libvk.so.1",
    });
  });

  it("says SIGKILL, not max-lifetime, for a unit that killed itself, then and later", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("selfkill", file);
    const [handle] = handlesOf(
      await summon(local.summon, request({ maxLifetimeMs: 1_000 })),
    );
    const expected: UnitStatus = {
      handle: handle!,
      state: "failed",
      exitCode: 137,
      detail: "SIGKILL",
    };
    expect(
      await statusUntil(
        local.summon,
        handle!,
        (unit) => unit.state !== "running",
      ),
    ).toEqual(expected);
    // Past the lifetime: still the unit's own death, not the backstop's.
    await Bun.sleep(1_500);
    expect((await local.summon.status!([handle!], context()))[0]).toEqual(
      expected,
    );
  });

  it("refuses a request for no units, rather than starting one", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("exit", file);
    for (const count of [0, -1, 1.5]) {
      await expect(
        local.summon.summon(request({ count }), context()),
      ).rejects.toBeInstanceOf(ConfigError);
    }
    await Bun.sleep(200);
    expect(existsSync(file)).toBe(false);
  });

  it("answers unknown for a handle it never started", async () => {
    const local = unitProvider("exit", "/dev/null");
    expect(await local.summon.status!(["local-1-1"], context())).toEqual([
      { handle: "local-1-1", state: "unknown" },
    ]);
  });
});

describe("localCompute: cancel", () => {
  it("sends the stop signal and resolves once the unit has exited", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("sleep", file);
    const [handle] = handlesOf(await summon(local.summon));
    const { pid } = await report(file);
    expect(alive(pid)).toBe(true);
    await local.summon.cancel!([handle!], context());
    expect(alive(pid)).toBe(false);
    expect(readFileSync(`${file}.log`, "utf8")).toContain("signal SIGTERM");
    // It handled the signal and exited 0.
    expect((await local.summon.status!([handle!], context()))[0]).toMatchObject(
      { state: "exited", exitCode: 0 },
    );
  });

  it("kills a unit that ignores the stop signal after the grace: 137, cancelled", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("stubborn", file, {
      shutdown: { graceMs: 300 },
    });
    const [handle] = handlesOf(await summon(local.summon));
    const { pid } = await report(file);
    const before = Date.now();
    await local.summon.cancel!([handle!], context());
    expect(Date.now() - before).toBeGreaterThanOrEqual(290);
    expect(alive(pid)).toBe(false);
    expect(readFileSync(`${file}.log`, "utf8")).toContain("ignored SIGTERM");
    expect((await local.summon.status!([handle!], context()))[0]).toEqual({
      handle: handle!,
      state: "exited",
      exitCode: 137,
      detail: "cancelled",
    });
  });

  it("uses the configured stop signal", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("sleep", file, {
      shutdown: { signal: "SIGINT", graceMs: 2_000 },
    });
    const [handle] = handlesOf(await summon(local.summon));
    await report(file);
    await local.summon.cancel!([handle!], context());
    expect(readFileSync(`${file}.log`, "utf8")).toContain("signal SIGINT");
  });

  it("stops waiting when its call is aborted, and still kills the unit", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("stubborn", file, {
      shutdown: { graceMs: 1_500 },
    });
    const [handle] = handlesOf(await summon(local.summon));
    const { pid } = await report(file);
    const abort = new AbortController();
    const cancelling = local.summon.cancel!([handle!], context(abort.signal));
    abort.abort();
    await cancelling;
    // The escalation goes on without the call.
    expect(await gone(pid)).toBe(true);
  });
});

describe("localCompute: what a unit starts", () => {
  it("cancel stops the unit's own children too", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("spawner", file);
    const [handle] = handlesOf(await summon(local.summon));
    const child = await childPid(file);
    expect(alive(child)).toBe(true);
    await local.summon.cancel!([handle!], context());
    expect(await gone(child)).toBe(true);
  });

  it("the lifetime kill stops the unit's own children too", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("stubborn-spawner", file, {
      shutdown: { graceMs: 200 },
    });
    // Long enough for a loaded machine to start the unit and its child
    // before the lifetime ends.
    const [handle] = handlesOf(
      await summon(local.summon, request({ maxLifetimeMs: 3_000 })),
    );
    const child = await childPid(file);
    const { pid } = await report(file);
    expect(await gone(pid)).toBe(true);
    expect(await gone(child)).toBe(true);
    expect(
      await statusUntil(
        local.summon,
        handle!,
        (unit) => unit.state !== "running",
      ),
    ).toMatchObject({ state: "failed", exitCode: 137, detail: "max-lifetime" });
  });

  it("sends no signal to a unit's group once it has exited: not on cancel, not at its lifetime", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("exit", file);
    // A lifetime long enough for a loaded machine to start the unit and see
    // it exit first; the check then waits past it and its grace.
    const startedAt = Date.now();
    const [handle] = handlesOf(
      await summon(local.summon, request({ maxLifetimeMs: 2_000 })),
    );
    const { pid } = await report(file);
    await statusUntil(
      local.summon,
      handle!,
      (unit) => unit.state !== "running",
    );
    const sent: [number, unknown][] = [];
    const original = process.kill;
    process.kill = ((target: number, signal?: string | number) => {
      sent.push([target, signal]);
      return original.call(process, target, signal);
    }) as typeof process.kill;
    try {
      await local.summon.cancel!([handle!], context());
      // Past the lifetime and its grace (500 ms): the timers went with the
      // unit.
      await Bun.sleep(Math.max(0, startedAt + 2_000 + 500 + 500 - Date.now()));
    } finally {
      process.kill = original;
    }
    expect(sent.filter(([target]) => Math.abs(target) === pid)).toEqual([]);
  });
});

describe("localCompute: capacity and dedupe", () => {
  it("starts what maxUnits allows and answers unavailable once full", async () => {
    const dir = await tmp();
    const local = localCompute({
      entry: UNIT,
      args: ["sleep", join(dir, "r.json")],
      output: "ignore",
      maxUnits: 2,
      shutdown: { graceMs: 500 },
    });
    const first = handlesOf(await summon(local.summon, request({ count: 3 })));
    expect(first).toHaveLength(2);
    const full = await summon(local.summon);
    expect(full).toEqual({
      status: "unavailable",
      reason: "max-units: 2 of 2 running",
    });
    await local.summon.cancel!([first[0]!], context());
    expect(handlesOf(await summon(local.summon))).toHaveLength(1);
    const checks = await local.validate();
    expect(checks.find((check) => check.id === "capacity")).toEqual({
      id: "capacity",
      status: "warn",
      detail: "2 of 2 units running",
    });
  });

  it("answers a repeated key with the units it started, concurrently too", async () => {
    const dir = await tmp();
    const local = unitProvider("sleep", join(dir, "r.json"), { maxUnits: 8 });
    const req = request();
    const first = handlesOf(await summon(local.summon, req));
    expect(await summon(local.summon, req)).toEqual({
      status: "deduped",
      handles: first,
    });

    const together = request();
    const answers = await Promise.all(
      Array.from(
        { length: 8 },
        async () => await summon(local.summon, together),
      ),
    );
    expect(
      answers.filter((answer) => answer.status === "started"),
    ).toHaveLength(1);
    const handles = new Set(
      answers.flatMap((answer) =>
        "handles" in answer ? (answer.handles ?? []) : [],
      ),
    );
    expect(handles.size).toBe(1);
  });
});

describe("localCompute: failures", () => {
  it("maps a missing entry, a missing cwd and a missing bun to misconfigured", async () => {
    const dir = await tmp();
    const missing = localCompute({ entry: join(dir, "nope.ts") });
    const entryError = await missing.summon
      .summon(request(), context())
      .catch((error: unknown) => error);
    expect(entryError).toBeInstanceOf(ProviderError);
    expect(entryError).toMatchObject({
      kind: "misconfigured",
      platformCode: "ENOENT",
    });

    const noCwd = localCompute({ entry: UNIT, cwd: join(dir, "gone") });
    expect(
      await noCwd.summon.summon(request(), context()).catch((e: unknown) => e),
    ).toMatchObject({ kind: "misconfigured", platformCode: "ENOENT" });

    const noBun = localCompute({ entry: UNIT, bun: join(dir, "bun") });
    expect(
      await noBun.summon.summon(request(), context()).catch((e: unknown) => e),
    ).toMatchObject({ kind: "misconfigured", platformCode: "ENOENT" });
  });

  it("rejects a call whose signal has aborted, starting nothing", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("exit", file);
    const abort = new AbortController();
    abort.abort(new Error("timed out"));
    await expect(
      local.summon.summon(request(), context(abort.signal)),
    ).rejects.toThrow("timed out");
    await Bun.sleep(300);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "maps a cgroup that cannot be joined to misconfigured",
    async () => {
      const local = localCompute({
        entry: UNIT,
        cgroup: "/sys/fs/cgroup/bun-jobs-local-test-missing",
      });
      expect(
        await local.summon
          .summon(request(), context())
          .catch((e: unknown) => e),
      ).toMatchObject({ kind: "misconfigured", platformCode: "ENOENT" });
    },
  );
});

describe("localCompute: lifetime", () => {
  it("kills a unit at its lifetime plus the grace, and reports max-lifetime", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("stubborn", file, {
      shutdown: { graceMs: 200 },
    });
    const before = Date.now();
    // Long enough for a loaded machine to start the unit before it ends.
    const [handle] = handlesOf(
      await summon(local.summon, request({ maxLifetimeMs: 2_000 })),
    );
    const { pid } = await report(file);
    expect(await gone(pid)).toBe(true);
    expect(Date.now() - before).toBeGreaterThanOrEqual(2_190);
    expect(readFileSync(`${file}.log`, "utf8")).toContain("ignored SIGTERM");
    expect(
      await statusUntil(
        local.summon,
        handle!,
        (unit) => unit.state !== "running",
      ),
    ).toEqual({
      handle: handle!,
      state: "failed",
      exitCode: 137,
      detail: "max-lifetime",
    });
  });
});

describe("localCompute: output", () => {
  it("appends both streams to a file", async () => {
    const dir = await tmp();
    const local = unitProvider("chatty", join(dir, "r.json"), {
      output: { file: "units.log" },
      cwd: dir,
    });
    const [handle] = handlesOf(await summon(local.summon));
    await statusUntil(
      local.summon,
      handle!,
      (unit) => unit.state !== "running",
    );
    const by = Date.now() + 10_000;
    let text = "";
    while (Date.now() < by) {
      text = existsSync(join(dir, "units.log"))
        ? readFileSync(join(dir, "units.log"), "utf8")
        : "";
      if (text.split("\n").filter(Boolean).length >= 4) {
        break;
      }
      await Bun.sleep(25);
    }
    expect(text.split("\n").filter(Boolean).sort()).toEqual([
      "err one",
      "err two",
      "out one",
      "out two",
    ]);
  });

  it("logs each line to a logger, stderr at warn, bound with the unit", async () => {
    const dir = await tmp();
    const { logger, events } = createTestLogger();
    const local = unitProvider("chatty", join(dir, "r.json"), {
      output: { logger },
    });
    const [handle] = handlesOf(await summon(local.summon));
    const by = Date.now() + 10_000;
    while (Date.now() < by && events.length < 4) {
      await Bun.sleep(25);
    }
    expect(
      events
        .map((event) => [event.level, event.message, event.bindings.unit])
        .sort(),
    ).toEqual([
      ["info", "out one", handle],
      ["info", "out two", handle],
      ["warn", "err one", handle],
      ["warn", "err two", handle],
    ]);
  });
});

describe("localCompute: output that cannot be written", () => {
  it("warns once, and the unit still runs", async () => {
    const dir = await tmp();
    const file = join(dir, "r.json");
    const local = unitProvider("exit", file, {
      output: { file: join(dir, "missing", "units.log") },
    });
    const warned: string[] = [];
    for (let n = 0; n < 2; n++) {
      const unit = startUnit(local.config, {
        handle: `local-test-out-${n}`,
        argv: [],
        env: { PATH: process.env.PATH ?? "" },
        lifetimeMs: 60_000,
        onExit: () => {},
        warnOnce: (() => {
          let once = false;
          return (message: string) => {
            if (!once) {
              once = true;
              warned.push(message);
            }
          };
        })(),
        instanceScope: (fn) => fn(),
        removeCgroupTree,
      });
      expect(await unit.exited).toBe(0);
    }
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("cannot open its output file");
  });
});

describe("localCompute: validate", () => {
  it("passes a healthy config, warning that a unit is not a sandbox", async () => {
    const checks = await localCompute({ entry: UNIT, maxUnits: 2 }).validate();
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ["cwd", "pass"],
      ["entry", "pass"],
      ["bun", "pass"],
      ["capacity", "pass"],
      ["isolation", "warn"],
    ]);
    expect(checks.find((check) => check.id === "bun")?.detail).toBe(
      `bun ${Bun.version}`,
    );
  });

  it("checks an output file can be written, creating nothing", async () => {
    const dir = await tmp();
    const ok = await localCompute({
      entry: UNIT,
      output: { file: join(dir, "units.log") },
    }).validate();
    expect(ok.find((check) => check.id === "output")?.status).toBe("pass");
    expect(existsSync(join(dir, "units.log"))).toBe(false);
    const bad = await localCompute({
      entry: UNIT,
      output: { file: join(dir, "missing", "units.log") },
    }).validate();
    expect(bad.find((check) => check.id === "output")?.status).toBe("fail");
  });

  it("fails a missing entry and a missing bun", async () => {
    const dir = await tmp();
    const checks = await localCompute({
      entry: join(dir, "nope.ts"),
      bun: join(dir, "bun"),
    }).validate();
    expect(checks.find((check) => check.id === "entry")?.status).toBe("fail");
    expect(checks.find((check) => check.id === "bun")?.status).toBe("fail");
  });

  it.skipIf(process.platform !== "linux")(
    "fails a cgroup that cannot be joined",
    async () => {
      const checks = await localCompute({
        entry: UNIT,
        cgroup: "/sys/fs/cgroup/bun-jobs-local-test-missing",
      }).validate();
      expect(checks.find((check) => check.id === "cgroup")).toMatchObject({
        status: "fail",
      });
    },
  );
});

/**
 * Where this user may create cgroups, when the machine delegates a subtree
 * (systemd's user slice), or `undefined`. Probed by creating and removing
 * one, so registering the tests leaves nothing behind.
 */
function delegatedBase(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const uid = process.getuid?.();
  const base = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
  const probe = join(base, `bun-jobs-local-probe-${process.pid}`);
  try {
    mkdirSync(probe);
    rmdirSync(probe);
    return base;
  } catch {
    return undefined;
  }
}

/** Removes every empty cgroup below `path`, deepest first, then `path`. */
function removeDepthFirst(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      try {
        removeDepthFirst(join(path, entry.name));
      } catch {
        // Still emptying.
      }
    }
  }
  rmdirSync(path);
}

/** Removes this file's test cgroup and everything the tests left in it, retrying while it empties. */
async function removeTestCgroup(path: string): Promise<void> {
  const by = Date.now() + 10_000;
  while (existsSync(path) && Date.now() < by) {
    try {
      removeDepthFirst(path);
    } catch {
      await Bun.sleep(50);
    }
  }
}

describe("localCompute: cgroup", () => {
  const base = delegatedBase();
  let made: string | undefined;
  /** This file's test cgroup, made on first use and removed after the file. */
  const testCgroup = (): string => {
    if (made === undefined) {
      made = join(base!, `bun-jobs-local-test-${process.pid}`);
      mkdirSync(made);
      const path = made;
      cleanups.push(async () => await removeTestCgroup(path));
    }
    return made;
  };
  const cgroup = base;

  it.skipIf(cgroup === undefined)(
    "starts a unit in a delegated cgroup, unprivileged",
    async () => {
      const file = join(await tmp(), "r.json");
      const local = unitProvider("exit", file, { cgroup: testCgroup() });
      expect(
        (await local.validate()).find((check) => check.id === "cgroup"),
      ).toMatchObject({ status: "pass" });
      const [handle] = handlesOf(await summon(local.summon));
      const { pid } = await report(file);
      expect(
        await statusUntil(
          local.summon,
          handle!,
          (unit) => unit.state !== "running",
        ),
      ).toMatchObject({ state: "exited", exitCode: 0 });
      expect(pid).toBeGreaterThan(0);
    },
  );

  it.skipIf(cgroup === undefined)(
    "removes a unit's cgroup even when the unit made a cgroup inside it",
    async () => {
      const file = join(await tmp(), "r.json");
      const local = unitProvider("subcgroup", file, { cgroup: testCgroup() });
      const [handle] = handlesOf(await summon(local.summon));
      const child = await childPid(file);
      await statusUntil(
        local.summon,
        handle!,
        (unit) => unit.state !== "running",
      );
      const own = /^cgroup (.+)$/m.exec(
        readFileSync(`${file}.log`, "utf8"),
      )![1]!;
      expect(own).toBe(join(testCgroup(), handle!));
      // Its cgroup was killed with it, the inner one included.
      expect(await gone(child)).toBe(true);
      const by = Date.now() + 10_000;
      while (existsSync(own) && Date.now() < by) {
        await Bun.sleep(50);
      }
      expect(existsSync(join(own, "inner"))).toBe(false);
      expect(existsSync(own)).toBe(false);
    },
  );

  it.skipIf(cgroup === undefined)(
    "holds a unit to the cgroup's memory.max",
    async () => {
      writeFileSync(join(testCgroup(), "memory.max"), String(64 * 1024 * 1024));
      try {
        writeFileSync(join(testCgroup(), "memory.swap.max"), "0");
      } catch {
        // No swap controller: memory.max alone binds.
      }
      const file = join(await tmp(), "r.json");
      const local = unitProvider("hog", file, { cgroup: testCgroup() });
      const [handle] = handlesOf(await summon(local.summon));
      expect(
        await statusUntil(
          local.summon,
          handle!,
          (unit) => unit.state !== "running",
        ),
      ).toMatchObject({ state: "failed", exitCode: 137 });
      expect(existsSync(`${file}.log`)).toBe(false);
    },
  );
});

describe("localCompute: no unit outlives its host", () => {
  /** Runs the host fixture until it prints `ready`, and answers its units' pids. */
  async function host(
    unitMode: string,
    hostMode: string,
    graceMs = 500,
  ): Promise<{
    proc: ReturnType<typeof Bun.spawn>;
    pids: number[];
    lines: string[];
    dir: string;
  }> {
    const dir = await tmp();
    const proc = Bun.spawn({
      cmd: [process.execPath, HOST, unitMode, dir, hostMode, String(graceMs)],
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      // An uncaught throw's report goes to stderr: kept out of the output.
      stderr: "ignore",
    });
    hosts.push(proc);
    const lines: string[] = [];
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        lines.push(...decoder.decode(chunk).split("\n").filter(Boolean));
      }
    })();
    const by = Date.now() + 30_000;
    while (!lines.includes("ready") && Date.now() < by) {
      await Bun.sleep(20);
    }
    expect(lines).toContain("ready");
    const found = await Promise.all(
      [1, 2].map(async (n) => (await report(join(dir, `unit-${n}.json`))).pid),
    );
    // A host in `exit`, `throw` or `reject` mode is already ending: its
    // units' reports are what show they ran.
    if (!["exit", "throw", "reject"].includes(hostMode)) {
      for (const pid of found) {
        expect(alive(pid)).toBe(true);
      }
    }
    return { proc, pids: found, lines, dir };
  }

  it("kills every unit when the host exits", async () => {
    const { proc, pids: units } = await host("sleep", "exit");
    expect(await proc.exited).toBe(0);
    for (const pid of units) {
      expect(await gone(pid)).toBe(true);
    }
  });

  it("stops every unit gracefully on SIGTERM, then ends the host by the signal", async () => {
    const { proc, pids: units, dir } = await host("sleep", "wait");
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    for (const pid of units) {
      expect(await gone(pid)).toBe(true);
    }
    for (const n of [1, 2]) {
      expect(readFileSync(join(dir, `unit-${n}.json.log`), "utf8")).toContain(
        "signal SIGTERM",
      );
    }
  });

  it("kills a unit that ignores the stop signal after its grace", async () => {
    const { proc, pids: units, dir } = await host("stubborn", "wait", 300);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    for (const pid of units) {
      expect(await gone(pid)).toBe(true);
    }
    expect(readFileSync(join(dir, "unit-1.json.log"), "utf8")).toContain(
      "ignored SIGTERM",
    );
  });

  it("leaves the host's own SIGTERM listener in charge, and still stops the units", async () => {
    const { proc, pids: units, lines } = await host("sleep", "listen");
    proc.kill("SIGTERM");
    for (const pid of units) {
      expect(await gone(pid)).toBe(true);
    }
    const by = Date.now() + 10_000;
    while (!lines.includes("host-signal") && Date.now() < by) {
      await Bun.sleep(20);
    }
    expect(lines).toContain("host-signal");
    // The host decides when it ends: it is still running.
    expect(proc.exitCode).toBeNull();
    proc.kill("SIGKILL");
    await proc.exited;
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    it(`stops every unit on the host's ${signal} too, units being detached from its terminal`, async () => {
      const { proc, pids: units, dir } = await host("sleep", "wait");
      proc.kill(signal);
      expect(await proc.exited).toBe(code);
      for (const pid of units) {
        expect(await gone(pid)).toBe(true);
      }
      expect(readFileSync(join(dir, "unit-1.json.log"), "utf8")).toContain(
        "signal SIGTERM",
      );
    });
  }

  for (const mode of ["throw", "reject"]) {
    it(`kills every unit when the host dies of an uncaught ${mode === "throw" ? "throw" : "rejection"}`, async () => {
      const { proc, pids: units } = await host("sleep", mode);
      expect(await proc.exited).toBe(1);
      for (const pid of units) {
        expect(await gone(pid)).toBe(true);
      }
    });
  }

  it("kills what the units started when the host exits", async () => {
    const { proc, dir } = await host("spawner", "exit");
    expect(await proc.exited).toBe(0);
    for (const n of [1, 2]) {
      expect(await gone(await childPid(join(dir, `unit-${n}.json`)))).toBe(
        true,
      );
    }
  });

  it("starts nothing once the host is stopping on a signal", async () => {
    const { proc, lines } = await host("stubborn", "summoning", 1_500);
    const answers = (): { status: string; at: number }[] =>
      lines
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { status: string; at: number });
    const by = Date.now() + 20_000;
    while (
      answers().filter((answer) => answer.status === "started").length < 2 &&
      Date.now() < by
    ) {
      await Bun.sleep(20);
    }
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    const all = answers();
    const first = all.findIndex((answer) => answer.status === "unavailable");
    // The grace is 1.5 s and a summon comes every 200 ms: some are refused.
    expect(first).toBeGreaterThan(0);
    expect(
      all.slice(first).filter((answer) => answer.status !== "unavailable"),
    ).toEqual([]);
  });

  it("removes its listeners once no unit runs", async () => {
    const file = join(await tmp(), "r.json");
    const local = unitProvider("exit", file);
    const [handle] = handlesOf(await summon(local.summon));
    await statusUntil(
      local.summon,
      handle!,
      (unit) => unit.state !== "running",
    );
    const by = Date.now() + 5_000;
    while (liveUnits().count > 0 && Date.now() < by) {
      await Bun.sleep(20);
    }
    expect(liveUnits()).toEqual({ count: 0, guarded: false });
  });
});
