import type {
  BunRunnerOptions,
  RunRecord,
  SpawnOptions,
  WorkerTarget,
} from "../lib/index";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as lib from "../lib/index";
import {
  BunQueue,
  BunQueueWorker,
  BunRunner,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * The `child-process` environment policy (isolation PR-i0).
 *
 * A child used to receive `...process.env`: every secret the host held — the
 * database URL, cloud keys — was in every job's environment. It now receives
 * an allowlist: a fixed base set ({@link EXPECTED_BASE}), the names in
 * `passEnv`, the literal values in `env`, and the runner protocol's own
 * `BUN_JOBS_*` variables. `env: "inherit"` restores the old behaviour.
 *
 * Every assertion reads the environment **from the child itself** (the
 * `env-report` handler returns its `process.env`), never from the options the
 * parent was given. The probe process (`child-env-probe.ts`) is started with
 * variables in its *startup* environment and then changes its live one, so a
 * child built from the startup environment — what `Bun.spawn` passes when it
 * is given no `env` — is caught too.
 */

/** The base set, spelled out here so a change to it is a change to this test. */
const EXPECTED_BASE = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

/** The protocol's variables, which every child gets whatever the policy. */
const PROTOCOL = new Set(Object.values(lib.CHILD_ENV));

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const PROBE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "child-env-probe.ts",
);

/** A directory with a `.env` file in it, for the child to (not) load. */
let dotenvDir: { path: string; cleanup: () => Promise<void> };
/** A directory with no `.env`, for the probe itself to run in. */
let plainDir: { path: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  dotenvDir = await makeTmpDir("child-env-dotenv");
  plainDir = await makeTmpDir("child-env-plain");
  await writeFile(
    join(dotenvDir.path, ".env"),
    "ISO0_DOTENV_SECRET=from-dotenv\n",
  );
});

afterAll(async () => {
  await dotenvDir.cleanup();
  await plainDir.cleanup();
});

/** What the child reported, or the error its run failed with. */
interface ChildReport {
  /** The child's own `process.env`. */
  env: Record<string, string>;
  /** Whether it could read its parent's `/proc/<ppid>/environ`; `null` off Linux. */
  parentEnviron: boolean | null;
}

/**
 * Starts the probe with a startup environment of its own and the runner's
 * `spawn` options, and returns what its child saw.
 */
async function probe(spawn: SpawnOptions): Promise<ChildReport> {
  const proc = Bun.spawn([process.execPath, PROBE, JSON.stringify(spawn)], {
    cwd: plainDir.path,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/",
      LANG: "C.UTF-8",
      ISO0_STARTUP_SECRET: "set-at-startup",
      ISO0_DELETED: "deleted-at-runtime",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out
    .split("\n")
    .reverse()
    .find((text) => text.startsWith("{"));
  if (!line) {
    throw new Error(`the probe printed no report; stderr:\n${err}`);
  }
  const report = JSON.parse(line) as {
    result?: ChildReport;
    error?: { name: string; message: string };
  };
  if (!report.result) {
    throw new Error(`the probe's run failed: ${JSON.stringify(report.error)}`);
  }
  return report.result;
}

describe("child-process environment: a real child, from a probe process", () => {
  it("passes only the base set and the protocol by default", async () => {
    const { env } = await probe({ cwd: dotenvDir.path });

    // The secrets, wherever they came from, are gone.
    expect(env.ISO0_STARTUP_SECRET).toBeUndefined();
    expect(env.ISO0_RUNTIME_SET).toBeUndefined();
    expect(env.ISO0_DELETED).toBeUndefined();
    // The child's own `.env` loading is off too: a secret in the cwd's
    // `.env` would otherwise come straight back.
    expect(env.ISO0_DOTENV_SECRET).toBeUndefined();

    // What it needs to run is there, with the parent's live values.
    expect(env.PATH).toBe(process.env.PATH ?? "");
    expect(env.HOME).toBe(process.env.HOME ?? "/");
    expect(env.LANG).toBe("C.UTF-8");

    // The protocol still works: the marker and the run's identity.
    expect(env.BUN_JOBS_CHILD).toBe("1");
    expect(env.BUN_JOBS_MODE).toBe("child-process");
    expect(env.BUN_JOBS_RUNNER_ID).toBe("env-probe");
    expect(env.BUN_JOBS_RUN_ID).toBeString();

    // And nothing else at all: every name is in the base set or the protocol.
    const extra = Object.keys(env).filter(
      (name) => !EXPECTED_BASE.includes(name) && !PROTOCOL.has(name as never),
    );
    expect(extra).toEqual([]);
  }, 30_000);

  it("leaves the parent's startup environment readable to a same-user child: the documented limit", async () => {
    // Not a property to keep, a limit to state: the allowlist decides the
    // child's environment, and a child running as the parent's user can
    // still read the parent's through procfs. `uid`/`gid` close it
    // (`spawn-hardening.test.ts`). If this starts failing, the docs that
    // describe the limit are what to change.
    const report = await probe({});
    if (report.parentEnviron !== null) {
      expect(report.parentEnviron).toBe(true);
    }
  }, 30_000);

  it("copies passEnv names from the live environment, not the startup one", async () => {
    const { env } = await probe({
      passEnv: ["ISO0_RUNTIME_SET", "ISO0_STARTUP_SECRET", "ISO0_DELETED"],
    });

    expect(env.ISO0_RUNTIME_SET).toBe("set-at-runtime");
    expect(env.ISO0_STARTUP_SECRET).toBe("set-at-startup");
    // Deleted before the run: a child built from the startup environment
    // would still have it.
    expect(env.ISO0_DELETED).toBeUndefined();
  }, 30_000);

  it("sets env's literal values over the base set", async () => {
    const { env } = await probe({
      env: { ISO0_LITERAL: "literal", LANG: "en_GB.UTF-8" },
    });

    expect(env.ISO0_LITERAL).toBe("literal");
    expect(env.LANG).toBe("en_GB.UTF-8");
    expect(env.ISO0_STARTUP_SECRET).toBeUndefined();
  }, 30_000);

  it('restores the old behaviour with env: "inherit", from the live environment', async () => {
    // The negative control: the probe *can* see every one of these secrets,
    // so their absence above is the policy, not a blind probe.
    const { env } = await probe({ env: "inherit", cwd: dotenvDir.path });

    expect(env.ISO0_STARTUP_SECRET).toBe("set-at-startup");
    expect(env.ISO0_RUNTIME_SET).toBe("set-at-runtime");
    // Live, not startup: `Bun.spawn` without `env` would still pass it.
    expect(env.ISO0_DELETED).toBeUndefined();
    // Bun's own `.env` loading in the child, as before.
    expect(env.ISO0_DOTENV_SECRET).toBe("from-dotenv");
    expect(env.BUN_JOBS_CHILD).toBe("1");
    expect(env.BUN_JOBS_MODE).toBe("child-process");
  }, 30_000);
});

describe("child-process environment: in this process", () => {
  const started: BunRunner<any, any>[] = [];
  const closers: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    delete process.env.ISO0_HOST_SECRET;
    await Promise.allSettled(started.map((r) => r.stop({ force: true })));
    started.length = 0;
    for (const close of closers.splice(0).reverse()) {
      await close().catch(() => undefined);
    }
  });

  /** Runs `env-report` once in a child with `spawn`, returning its env. */
  async function runnerEnv(
    spawn: SpawnOptions,
  ): Promise<Record<string, string>> {
    const runner = new BunRunner({
      id: "env-runner",
      namespace: testNamespace(),
      file: handler("env-report"),
      executionMode: "child-process",
      driver: new MemoryDriver(),
      waitToExit: false,
      logger: noopLogger,
      spawn,
    } as BunRunnerOptions<any>);
    started.push(runner);
    interface Settled {
      record: RunRecord;
      result?: unknown;
    }
    const done = new Promise<Settled>((resolve) => {
      const finish = (record: RunRecord, result?: unknown): void =>
        resolve({ record, result });
      runner.once("finished", finish);
      runner.once("failed", (record) => resolve({ record }));
    });
    await runner.start();
    await runner.trigger();
    const { record, result } = await done;
    expect(record.status).toBe("success");
    return (result as ChildReport).env;
  }

  it("hides a secret set on process.env from a runner's child", async () => {
    process.env.ISO0_HOST_SECRET = "host-secret";
    expect((await runnerEnv({})).ISO0_HOST_SECRET).toBeUndefined();
  }, 30_000);

  it("copies only variables from passEnv, never an inherited property", async () => {
    // `process.env.toString` is `Object.prototype.toString`: a name lookup
    // that does not check it is a set variable copies a function.
    const env = await runnerEnv({ passEnv: ["toString", "constructor"] });
    expect(Object.hasOwn(env, "toString")).toBe(false);
    expect(Object.hasOwn(env, "constructor")).toBe(false);
  }, 30_000);

  it("removes a base variable given as undefined in env", async () => {
    const env = await runnerEnv({ env: { HOME: undefined, ISO0_X: "x" } });
    expect(env.HOME).toBeUndefined();
    expect(env.ISO0_X).toBe("x");
    expect(env.PATH).toBeString();
  }, 30_000);

  /** A queue worker on a child-process target, returning one job's env. */
  async function targetEnv(
    target: WorkerTarget,
  ): Promise<Record<string, string>> {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("env", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker("env", handler("job-env-report"), {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      target,
      waitToExit: false,
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();
    const job = await queue.add("env", {}, { removeOnComplete: false });
    let value: unknown;
    await waitFor(
      async () => {
        const stored = await queue.getJob(job.id);
        value = stored?.returnValue;
        return stored?.state === "completed";
      },
      { timeout: 20_000, message: "the job never completed" },
    );
    return value as Record<string, string>;
  }

  it("hides the host's secrets from a queue's child-process target", async () => {
    process.env.ISO0_HOST_SECRET = "host-secret";
    const env = await targetEnv("child-process");
    expect(env.ISO0_HOST_SECRET).toBeUndefined();
    expect(env.BUN_JOBS_CHILD).toBe("1");
    expect(env.BUN_JOBS_MODE).toBe("child-process");
  }, 30_000);

  it("passes a target's passEnv and env, and inherits on request", async () => {
    process.env.ISO0_HOST_SECRET = "host-secret";
    const passed = await targetEnv({
      kind: "child-process",
      spawn: { passEnv: ["ISO0_HOST_SECRET"], env: { ISO0_LIT: "lit" } },
    });
    expect(passed.ISO0_HOST_SECRET).toBe("host-secret");
    expect(passed.ISO0_LIT).toBe("lit");

    const inherited = await targetEnv({
      kind: "child-process",
      spawn: { env: "inherit" },
    });
    expect(inherited.ISO0_HOST_SECRET).toBe("host-secret");
  }, 40_000);

  it("leaves a worker-thread target's environment alone: a thread is no boundary", async () => {
    // Deliberately unchanged (plan §9 Q7): a `Worker` shares the process, so
    // hiding variables from it would promise a boundary that is not there.
    process.env.ISO0_HOST_SECRET = "host-secret";
    const env = await targetEnv("worker-thread");
    expect(env.ISO0_HOST_SECRET).toBe("host-secret");
  }, 30_000);
});

describe("child-process environment: configuration", () => {
  it("exports the base set it documents", () => {
    expect([...lib.CHILD_BASE_ENV]).toEqual(EXPECTED_BASE);
  });

  const runner = (spawn: unknown) =>
    new BunRunner({
      id: "bad-env",
      namespace: testNamespace(),
      file: handler("env-report"),
      executionMode: "child-process",
      driver: new MemoryDriver(),
      logger: noopLogger,
      spawn,
    } as BunRunnerOptions<any>);

  const worker = (spawn: unknown) =>
    new BunQueueWorker("bad", handler("job-env-report"), {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      target: { kind: "child-process", spawn } as WorkerTarget,
    });

  for (const [label, build] of [
    ["a runner", runner],
    ["a queue target", worker],
  ] as const) {
    it(`refuses a bad env policy on ${label}, at construction`, () => {
      expect(() => build({ env: "all" })).toThrow(ConfigError);
      expect(() => build({ env: "all" })).toThrow(
        /env must be "inherit" or an object of string values/,
      );
      expect(() => build({ env: { PORT: 8080 } })).toThrow(
        /env\.PORT must be a string or undefined/,
      );
      expect(() => build({ passEnv: "PATH" })).toThrow(
        /passEnv must be an array of variable names/,
      );
      expect(() => build({ passEnv: ["A=B"] })).toThrow(
        /passEnv entry "A=B" is not a variable name/,
      );
      expect(() => build({ env: "inherit", passEnv: ["X"] })).toThrow(
        /passEnv has no effect with env: "inherit"/,
      );
      // The valid shapes construct.
      expect(() => build({ env: "inherit" })).not.toThrow();
      expect(() =>
        build({ env: { A: "1", B: undefined }, passEnv: ["C"] }),
      ).not.toThrow();
    });
  }
});
