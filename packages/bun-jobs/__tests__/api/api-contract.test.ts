import type { BunPlugin } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_LEVELS } from "@kingsleyweb/bun-common";
import * as Contract from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import * as Config from "../../lib/api/config";
import { JOBS_API_PROTOCOL_VERSION as META_PROTOCOL } from "../../lib/api/routes/meta";
import { JOB_STATES as COMMON_STATES } from "../../lib/api/schemas/common";
import { JobIdRefSchema, NewJobIdSchema } from "../../lib/api/schemas/jobs";
import {
  RunnerInfoSchema,
  RunRecordSchema,
} from "../../lib/api/schemas/runners";
import { workerListQuerySchema } from "../../lib/api/schemas/workers";
import { JOB_INCLUDES as SERIALIZE_INCLUDES } from "../../lib/api/serialize";
import * as Channels from "../../lib/api/ws/channels";
import {
  QUEUE_EVENT_NAMES,
  RUNNER_EVENT_NAMES,
  EVENT_TYPES as WS_EVENT_TYPES,
} from "../../lib/api/ws/events";
import * as Protocol from "../../lib/api/ws/protocol";
import {
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
} from "../../lib/drivers/readApis";
import * as Root from "../../lib/index";
import { ConfigError } from "../../lib/index";
import * as Redact from "../../lib/runner/redact";
import * as SharedConstants from "../../lib/shared/constants";
import { assertSegment } from "../../lib/shared/keys";
import * as Workers from "../../lib/shared/workers";

/**
 * The browser-safe contract, `@kingsleyweb/bun-jobs/api/contract`: that it
 * imports nothing but itself (so a browser bundle of it holds no server
 * code), and that the server's constants *are* its constants — one
 * definition, re-exported — rather than copies that could disagree.
 */

/** The contract's directory. */
const CONTRACT_DIR = new URL("../../lib/api/contract/", import.meta.url)
  .pathname;

/** Every source file in the contract directory. */
async function contractFiles(): Promise<string[]> {
  return (await readdir(CONTRACT_DIR))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(CONTRACT_DIR, file));
}

/** Every module specifier a file names: static, `export … from`, type-only and dynamic alike. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

describe("job-id escaping for channel names", () => {
  it("is defined once, in the contract: the socket and the root use that very function", () => {
    expect(Contract.encodeJobId).toBeFunction();
    expect(Contract.decodeJobId).toBeFunction();
    expect(Channels.encodeJobId).toBe(Contract.encodeJobId);
    expect(Channels.decodeJobId).toBe(Contract.decodeJobId);
    expect(Root.encodeJobId).toBe(Contract.encodeJobId);
    expect(Root.decodeJobId).toBe(Contract.decodeJobId);
  });

  it("escapes as encodeURIComponent does, and a lone surrogate as %uXXXX", () => {
    for (const id of [
      "plain",
      "a/b c",
      "100%",
      "\u{1F600}",
      "x\uDC00y",
      "\uD83D",
    ]) {
      expect(Contract.decodeJobId(Contract.encodeJobId(id))).toBe(id);
    }
    expect(Contract.encodeJobId("a/b c")).toBe(encodeURIComponent("a/b c"));
    expect(Contract.encodeJobId("x\uDC00y")).toBe("x%uDC00y");
    expect(Channels.jobChannel("mail", "\uD83D")).toBe("queue/mail/job/%uD83D");
    expect(() => Contract.decodeJobId("%u0041")).toThrow(URIError);
  });
});

describe("the contract's import graph", () => {
  it("names only its own sibling files, in every file, type imports included", async () => {
    const files = await contractFiles();
    expect(files.map((file) => file.slice(CONTRACT_DIR.length)).sort()).toEqual(
      ["constants.ts", "index.ts", "types.ts", "ws.ts"],
    );
    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const specifier of specifiersOf(source)) {
        expect({ file, specifier }).toEqual({
          file,
          specifier: expect.stringMatching(/^\.\/(?:constants|types|ws)$/),
        });
      }
      // What the transpiler sees as runtime imports: only `./constants`.
      const runtime = new Bun.Transpiler({ loader: "ts" })
        .scanImports(source)
        .map((entry) => entry.path);
      expect(runtime.every((path) => path === "./constants")).toBe(true);
    }
  });

  it("the scan sees an import the contract must not have (the control)", () => {
    expect(
      specifiersOf(
        'import type { X } from "../drivers/index";\nexport * from "node:fs";',
      ),
    ).toEqual(["../drivers/index", "node:fs"]);
  });

  it("bundles for the browser with every resolution inside the contract, and runs", async () => {
    const resolved: string[] = [];
    const confine: BunPlugin = {
      name: "confine-to-contract",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point-build") {
            return undefined;
          }
          resolved.push(args.path);
          const target = join(args.resolveDir, `${args.path}.ts`);
          if (!args.path.startsWith("./") || !target.startsWith(CONTRACT_DIR)) {
            throw new Error(`the contract imports ${args.path}`);
          }
          return { path: target };
        });
      },
    };
    const result = await Bun.build({
      entrypoints: [join(CONTRACT_DIR, "index.ts")],
      target: "browser",
      format: "esm",
      external: [],
      plugins: [confine],
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    // Type-only imports are erased: the one runtime edge is the constants.
    expect([...new Set(resolved)]).toEqual(["./constants"]);

    const bundle = await result.outputs[0]!.text();
    expect(bundle).not.toMatch(/\b(?:require|import)\s*\(/);
    expect(bundle).not.toMatch(/from\s*["']/);

    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-contract-"));
    try {
      const file = join(dir, "contract.mjs");
      await Bun.write(file, bundle);
      const loaded = (await import(file)) as typeof Contract;
      expect(loaded.JOBS_API_WS_SUBPROTOCOL).toBe("bun-jobs.v1");
      expect(loaded.JOBS_API_PROTOCOL_VERSION).toBe(1);
      expect(loaded.JOBS_API_WS_MAX_CHANNELS_PER_FRAME).toBe(256);
      expect([...loaded.EVENT_TYPES]).toEqual([...Contract.EVENT_TYPES]);
      expect([...loaded.JOBS_API_MUTATIONS]).toEqual([
        ...Contract.JOBS_API_MUTATIONS,
      ]);
      // The worker-control tables a management UI builds its form from reach
      // the browser too — they are values, not types, so a bundle must carry
      // them.
      expect([...loaded.WORKER_STATES]).toEqual([...Contract.WORKER_STATES]);
      expect([...loaded.WORKER_STOP_PERSISTENCE]).toEqual([
        ...Contract.WORKER_STOP_PERSISTENCE,
      ]);
      expect([...loaded.WORKER_TARGET_KINDS]).toEqual([
        ...Contract.WORKER_TARGET_KINDS,
      ]);
      expect([...loaded.WORKER_CONFIG_KEYS]).toEqual([
        ...Contract.WORKER_CONFIG_KEYS,
      ]);
      expect([...loaded.WORKER_EVENT_TYPES]).toEqual([
        ...Contract.WORKER_EVENT_TYPES,
      ]);
      expect(loaded.WORKER_CONFIG_BOUNDS).toEqual(
        Contract.WORKER_CONFIG_BOUNDS,
      );
      expect([...loaded.EXECUTION_MODES]).toEqual([
        ...Contract.EXECUTION_MODES,
      ]);
      expect([...loaded.RUNNER_CONFIG_KEYS]).toEqual([
        ...Contract.RUNNER_CONFIG_KEYS,
      ]);
      expect(loaded.RUNNER_CONFIG_BOUNDS).toEqual(
        Contract.RUNNER_CONFIG_BOUNDS,
      );
      // The run-log tables a log view builds its stream filter and its level
      // colouring from are values too, so the bundle must carry them.
      expect([...loaded.RUN_LOG_STREAMS]).toEqual([
        ...Contract.RUN_LOG_STREAMS,
      ]);
      expect([...loaded.RUN_LOG_LEVELS]).toEqual([...Contract.RUN_LOG_LEVELS]);
      // The hint's rate and the redaction marker, so a log view can name
      // both rather than hard-code them. Literals, not `Contract.*`: an
      // export missing from both would otherwise compare undefined to
      // undefined and pass.
      expect(loaded.RUN_LOG_HINT_MS).toBe(500);
      expect(loaded.DEFAULT_REDACT_REPLACEMENT).toBe("[REDACTED]");
      // A range picker builds its preset list, and clamps itself, from these
      // at runtime — the whole point of moving them out of the UI — so the
      // browser bundle must carry them as values, not erase them as types.
      expect([...loaded.ANALYTICS_PRESETS]).toEqual([
        ...Contract.ANALYTICS_PRESETS,
      ]);
      expect(loaded.DEFAULT_ANALYTICS_PRESET).toBe(
        Contract.DEFAULT_ANALYTICS_PRESET,
      );
      expect([...loaded.ANALYTICS_RESOLUTIONS]).toEqual([
        ...Contract.ANALYTICS_RESOLUTIONS,
      ]);
      expect(loaded.DEFAULT_ANALYTICS_RESOLUTION).toBe(
        Contract.DEFAULT_ANALYTICS_RESOLUTION,
      );
      expect([...loaded.DURATION_HISTOGRAM_BOUNDS]).toEqual([
        ...Contract.DURATION_HISTOGRAM_BOUNDS,
      ]);
      // A job list builds its sort control from the list at runtime; literals,
      // so an export missing from both could not pass as undefined twice.
      expect([...loaded.JOB_LIST_SORTS]).toEqual(["natural", "createdAt"]);
      expect(loaded.MAX_ADDED_BY_STATE_SPAN_MS).toBe(86_400_000);
      for (const name of [
        "SECOND_BUCKET_MS",
        "MINUTE_BUCKET_MS",
        "DEFAULT_SECOND_RETENTION_MS",
        "MAX_SECOND_RETENTION_MS",
        "MINUTE_RETENTION_MS",
        "MAX_ANALYTICS_SPAN_MS",
        "MIN_ANALYTICS_SPAN_MS",
        "MAX_ANALYTICS_BUCKETS",
        "MAX_ANALYTICS_SERIES",
        "MAX_ANALYTICS_ROWS",
        // A worker page caps a multi-key selection by it at runtime.
        "MAX_JOB_FILTER_VALUES",
        // An added-by-state card clamps its range picker by it.
        "MAX_ADDED_BY_STATE_SPAN_MS",
      ] as const) {
        expect({ name, value: loaded[name] }).toEqual({
          name,
          value: Contract[name],
        });
      }
      // A browser client can name the job channel of any id, a lone
      // surrogate's included, and read one back.
      const lone = "job-\uD800-x";
      expect(loaded.encodeJobId(lone)).toBe("job-%uD800-x");
      expect(loaded.decodeJobId(loaded.encodeJobId(lone))).toBe(lone);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a bundle reaching outside the contract fails (the control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-contract-"));
    try {
      const entry = join(dir, "entry.ts");
      await Bun.write(entry, 'export { sep } from "node:path";\n');
      const outside: BunPlugin = {
        name: "confine",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point-build") {
              return undefined;
            }
            throw new Error(`reaches ${args.path}`);
          });
        },
      };
      const failed = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        plugins: [outside],
        throw: false,
      });
      expect(failed.success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("one definition of each constant", () => {
  it("the server's constants are the contract's own values, not copies", () => {
    expect(Config.JOBS_API_ACTIONS).toBe(Contract.JOBS_API_ACTIONS);
    expect(Config.JOBS_API_MUTATIONS).toBe(Contract.JOBS_API_MUTATIONS);
    expect(Config.JOBS_API_OPT_IN_ACTIONS).toBe(
      Contract.JOBS_API_OPT_IN_ACTIONS,
    );
    expect(META_PROTOCOL).toBe(Contract.JOBS_API_PROTOCOL_VERSION);
    expect(Protocol.JOBS_API_WS_SUBPROTOCOL).toBe(
      Contract.JOBS_API_WS_SUBPROTOCOL,
    );
    expect(Protocol.JOBS_API_WS_CLOSE).toBe(Contract.JOBS_API_WS_CLOSE);
    expect(Protocol.JOBS_API_WS_MAX_CHANNELS_PER_FRAME).toBe(
      Contract.JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
    );
    expect(WS_EVENT_TYPES).toBe(Contract.EVENT_TYPES);
    expect(COMMON_STATES).toBe(Contract.JOB_STATES);
    expect(SERIALIZE_INCLUDES).toBe(Contract.JOB_INCLUDES);
    // And the package root re-exports the same values.
    expect(Root.JOBS_API_ACTIONS).toBe(Contract.JOBS_API_ACTIONS);
    expect(Root.JOBS_API_WS_CLOSE).toBe(Contract.JOBS_API_WS_CLOSE);
    expect(Root.JOBS_API_PROTOCOL_VERSION).toBe(
      Contract.JOBS_API_PROTOCOL_VERSION,
    );
  });

  it("the id caps are the ones the schemas apply", () => {
    expect(NewJobIdSchema.json.maxLength).toBe(Contract.MAX_JOB_ID_LENGTH);
    expect(JobIdRefSchema.json.maxLength).toBe(Contract.MAX_JOB_REF_LENGTH);
    expect(Contract.MAX_JOB_ID_LENGTH).toBe(191);
  });

  it("caps a job-list worker filter at the worker listing's own bound", () => {
    // `MAX_JOB_FILTER_VALUES` promises the same bound the worker listing's
    // `key` filter has, so a selection copied from one to the other fits.
    // The job list's schema applies it when it gains `workerKey`/`workerId`;
    // until then this pins the promise to the listing it is copied from.
    const { key } = workerListQuerySchema().json.properties as Record<
      string,
      { maxItems?: number }
    >;
    expect(key?.maxItems).toBe(Contract.MAX_JOB_FILTER_VALUES);
    expect(Contract.MAX_JOB_FILTER_VALUES).toBe(100);
  });

  it("lists the event names the socket's schema tables declare, in their order", () => {
    expect([...Contract.QUEUE_EVENT_TYPES]).toEqual(QUEUE_EVENT_NAMES);
    expect([...Contract.RUNNER_EVENT_TYPES]).toEqual(RUNNER_EVENT_NAMES);
    // `control` belongs to the runner and the worker alike, so the filter
    // lists it once: a subscription matches on `type`, and the envelope's
    // `kind` tells the two apart.
    const distinct: string[] = [
      ...new Set<string>([
        ...QUEUE_EVENT_NAMES,
        ...RUNNER_EVENT_NAMES,
        ...Contract.WORKER_EVENT_TYPES,
      ]),
    ];
    expect<string[]>([...Contract.EVENT_TYPES]).toEqual(distinct);
  });

  it("bounds every editable worker setting, and only those, with a usable range", () => {
    // The UI builds its form from the pair, so a key with no bound would give
    // it an input it cannot validate, and a bound with no key an input for a
    // setting that cannot be written.
    expect(Object.keys(Contract.WORKER_CONFIG_BOUNDS).sort()).toEqual(
      [...Contract.WORKER_CONFIG_KEYS].sort(),
    );
    for (const key of Contract.WORKER_CONFIG_KEYS) {
      const { min, max } = Contract.WORKER_CONFIG_BOUNDS[key];
      expect({
        key,
        ok: Number.isInteger(min) && Number.isInteger(max),
      }).toEqual({ key, ok: true });
      expect({ key, ordered: min < max }).toEqual({ key, ordered: true });
    }
    // A worker that never reports is invisible, and so uncontrollable.
    expect(Contract.WORKER_CONFIG_BOUNDS.reportInterval.min).toBeGreaterThan(0);
    // The cross-field rule `heartbeatInterval <= lockDuration / 2` has to be
    // satisfiable at the extremes, or the bounds contradict it.
    expect(
      Contract.WORKER_CONFIG_BOUNDS.heartbeatInterval.min * 2,
    ).toBeLessThanOrEqual(Contract.WORKER_CONFIG_BOUNDS.lockDuration.min);
    expect(
      Contract.WORKER_CONFIG_BOUNDS.heartbeatInterval.max * 2,
    ).toBeLessThanOrEqual(Contract.WORKER_CONFIG_BOUNDS.lockDuration.max);
  });

  it("bounds the runner setting that takes a number, and lists the modes a form offers", () => {
    // Only `maxConcurrency` is numeric; the other two settings are the two
    // enumerations beside it, which a form reads instead of a range.
    expect(Object.keys(Contract.RUNNER_CONFIG_BOUNDS)).toEqual([
      "maxConcurrency",
    ]);
    for (const [key, { min, max }] of Object.entries(
      Contract.RUNNER_CONFIG_BOUNDS,
    )) {
      expect({
        key,
        ok: Number.isInteger(min) && Number.isInteger(max),
      }).toEqual({ key, ok: true });
      expect({ key, ordered: min < max }).toEqual({ key, ordered: true });
    }
    // The floor is the runner's own (`resolveRunnerOptions` refuses anything
    // below 1, `lib/runner/options.ts:70`). The ceiling is the API's alone:
    // the runner imposes none, and its "unlimited" is
    // `Number.POSITIVE_INFINITY`, which a caller asks for as `null`.
    expect(Contract.RUNNER_CONFIG_BOUNDS.maxConcurrency.min).toBe(1);
    expect(Contract.RUNNER_CONFIG_KEYS).toEqual([
      "executionMode",
      "runMode",
      "maxConcurrency",
    ]);
    // Every key a form shows is either bounded or enumerated — none is left
    // with no way to build an input for it.
    const enumerated = new Set(["executionMode", "runMode"]);
    for (const key of Contract.RUNNER_CONFIG_KEYS) {
      expect({
        key,
        covered: key in Contract.RUNNER_CONFIG_BOUNDS || enumerated.has(key),
      }).toEqual({ key, covered: true });
    }
  });

  it("the execution modes are one list, which the runner schema enumerates", () => {
    expect([...Contract.EXECUTION_MODES]).toEqual([
      "spawn",
      "worker",
      "in-process",
    ]);
    // `ExecutionModeSchema` is built from that very constant, so a route's
    // documented enum cannot drift from what a client is typed against.
    for (const schema of [RunRecordSchema, RunnerInfoSchema]) {
      const properties = schema.json.properties as
        | Record<string, { enum?: unknown[] }>
        | undefined;
      const field = schema === RunRecordSchema ? "mode" : "executionMode";
      expect({ field, values: properties?.[field]?.enum }).toEqual({
        field,
        values: [...Contract.EXECUTION_MODES],
      });
    }
  });

  it("names the worker actions, and opts in only the two that reconfigure a process", () => {
    const workerActions = Contract.JOBS_API_ACTIONS.filter((action) =>
      action.startsWith("workers."),
    );
    expect(workerActions).toEqual([
      "workers.list",
      "workers.read",
      "workers.pause",
      "workers.resume",
      "workers.stop",
      "workers.start",
      "workers.configure",
    ]);
    expect(Contract.JOBS_API_ACTIONS).toContain("runners.configure");
    // Reading is not a mutation; every instruction is.
    for (const action of [
      "workers.pause",
      "workers.resume",
      "workers.stop",
      "workers.start",
      "workers.configure",
      "runners.configure",
    ] as const) {
      expect({
        action,
        mutation: Contract.JOBS_API_MUTATIONS.has(action),
      }).toEqual({ action, mutation: true });
    }
    for (const action of ["workers.list", "workers.read"] as const) {
      expect({
        action,
        mutation: Contract.JOBS_API_MUTATIONS.has(action),
      }).toEqual({ action, mutation: false });
    }
    // Of the worker actions only configure is opt-in: stop/start stay
    // default-on, because `queues.pause` — which stops every worker on a
    // queue — is.
    expect([...Contract.JOBS_API_OPT_IN_ACTIONS].sort()).toEqual([
      "jobs.add",
      "jobs.update",
      "queues.applyDefaults",
      "queues.defaults",
      "runners.configure",
      "workers.configure",
    ]);
  });

  it("names reading a run's logs, as a read: not a mutation, and not opt-in", () => {
    const runnerActions = Contract.JOBS_API_ACTIONS.filter((action) =>
      action.startsWith("runners."),
    );
    expect(runnerActions).toEqual([
      "runners.list",
      "runners.read",
      "runners.logs",
      "runners.trigger",
      "runners.pause",
      "runners.resume",
      "runners.kill",
      "runners.reschedule",
      "runners.resetStats",
      "runners.clearHistory",
      "runners.configure",
    ]);
    // Reading a run's output changes nothing and writes no caller payload, so
    // it is on by default exactly as `jobs.logs` is. Both halves of the
    // read/opt-in split have to say so: absent from the mutations, and absent
    // from the opt-in set, which `resolveConfig` subtracts to build the
    // default allow-list.
    expect(Contract.JOBS_API_MUTATIONS.has("runners.logs")).toBe(false);
    expect(Contract.JOBS_API_OPT_IN_ACTIONS.has("runners.logs")).toBe(false);
    expect(Contract.JOBS_API_MUTATIONS.has("jobs.logs")).toBe(false);
    expect(Contract.JOBS_API_OPT_IN_ACTIONS.has("jobs.logs")).toBe(false);
    // The opt-in set is still exactly the actions that write a payload,
    // reconfigure a process or change a queue's job defaults: a read must
    // never have joined it.
    expect([...Contract.JOBS_API_OPT_IN_ACTIONS].sort()).toEqual([
      "jobs.add",
      "jobs.update",
      "queues.applyDefaults",
      "queues.defaults",
      "runners.configure",
      "workers.configure",
    ]);
    // Every opt-in action is a mutation, and no action is in one list only by
    // accident: the two lists are consistent for the whole set, not just the
    // new one.
    for (const action of Contract.JOBS_API_OPT_IN_ACTIONS) {
      expect({
        action,
        mutation: Contract.JOBS_API_MUTATIONS.has(action),
      }).toEqual({ action, mutation: true });
    }
  });

  it("names the two clear actions as mutations that are on by default", () => {
    // Both delete what they clear for good, and both are default-on all the
    // same, exactly as the destructive actions already there are: removing a
    // job and resetting a runner's counters.
    for (const action of [
      "jobs.clearLogs",
      "runners.clearHistory",
      "jobs.remove",
      "runners.resetStats",
    ] as const) {
      expect({
        action,
        known: Contract.JOBS_API_ACTIONS.includes(action),
        mutation: Contract.JOBS_API_MUTATIONS.has(action),
        optIn: Contract.JOBS_API_OPT_IN_ACTIONS.has(action),
      }).toEqual({ action, known: true, mutation: true, optIn: false });
    }
    // Each sits beside the action it is kin to, so a listing groups them.
    const actions: readonly string[] = Contract.JOBS_API_ACTIONS;
    expect(actions.indexOf("jobs.clearLogs")).toBe(
      actions.indexOf("jobs.remove") + 1,
    );
    expect(actions.indexOf("runners.clearHistory")).toBe(
      actions.indexOf("runners.resetStats") + 1,
    );
    // Neither clear action joined the opt-in set.
    expect([...Contract.JOBS_API_OPT_IN_ACTIONS].sort()).toEqual([
      "jobs.add",
      "jobs.update",
      "queues.applyDefaults",
      "queues.defaults",
      "runners.configure",
      "workers.configure",
    ]);
  });

  it("defines the run-log streams once, and restates the logger's levels", () => {
    // The streams are defined in the contract alone: the runtime re-exports
    // that very array rather than keeping a copy, so the two cannot drift.
    expect(SharedConstants.RUN_LOG_STREAMS).toBe(Contract.RUN_LOG_STREAMS);
    // The levels are bun-common's six, restated because the contract cannot
    // import bun-common either. A level added to the logger and not here would
    // reach the wire as a value no client is typed against.
    expect([...Contract.RUN_LOG_LEVELS]).toEqual([...LOG_LEVELS]);
    expect([...Contract.RUN_LOG_LEVELS]).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
  });

  it("is the one definition of the run-log hint's rate and the redaction marker", () => {
    // Both are defined in the contract and imported by the runtime
    // (`lib/shared/constants.ts` re-exports the rate, `lib/runner/redact.ts`
    // imports the marker), so they cannot drift — this pins that the runtime
    // still takes them from there, and pins the values a client relies on.
    // Restate either in its runtime module and change it, and this fails.
    expect(SharedConstants.RUN_LOG_HINT_MS).toBe(Contract.RUN_LOG_HINT_MS);
    expect(Root.RUN_LOG_HINT_MS).toBe(Contract.RUN_LOG_HINT_MS);
    expect(Contract.RUN_LOG_HINT_MS).toBe(500);
    expect(Redact.DEFAULT_REDACT_REPLACEMENT).toBe(
      Contract.DEFAULT_REDACT_REPLACEMENT,
    );
    expect(Root.DEFAULT_REDACT_REPLACEMENT).toBe(
      Contract.DEFAULT_REDACT_REPLACEMENT,
    );
    expect(Contract.DEFAULT_REDACT_REPLACEMENT).toBe("[REDACTED]");
    // And the marker is what redaction actually writes, not just a name.
    const redact = Redact.createRedactor({});
    expect(redact?.("password=hunter2")).toBe(
      `password=${Contract.DEFAULT_REDACT_REPLACEMENT}`,
    );
  });

  it("restates the runtime's minute bucketing, to the millisecond", () => {
    // `readApis.ts` is the runtime's authority on what a minute bucket is and
    // how long one is kept, and the contract may import nothing — so the pair
    // exists twice and must agree, exactly as the run-log tables do. A
    // deployment reads `MINUTE_RETENTION_MS` to know how far back a chart can
    // go; if the runtime pruned sooner, the chart would ask for buckets that
    // are not there and show a silent hole.
    expect(Contract.MINUTE_BUCKET_MS).toBe(THROUGHPUT_BUCKET_MS);
    expect(Contract.MINUTE_RETENTION_MS).toBe(THROUGHPUT_RETENTION_MS);
    // The control: the comparison is on the value, so a drift of one
    // millisecond in either direction is caught — not merely a type or a
    // missing export.
    expect(Contract.MINUTE_BUCKET_MS + 1).not.toBe(THROUGHPUT_BUCKET_MS);
    expect(Contract.MINUTE_RETENTION_MS - 1).not.toBe(THROUGHPUT_RETENTION_MS);
    // And the second bucket is the unit the finest resolution names.
    expect(Contract.SECOND_BUCKET_MS).toBe(1_000);
    expect(Contract.MINUTE_BUCKET_MS).toBe(60 * Contract.SECOND_BUCKET_MS);
  });

  it("the analytics numbers agree with one another", () => {
    // Every resolution is a positive whole number of seconds, finest first,
    // and each has a bucket width in ms to go with it.
    expect([...Contract.ANALYTICS_RESOLUTIONS]).toEqual([1, 60]);
    const widths: Record<number, number> = {
      1: Contract.SECOND_BUCKET_MS,
      60: Contract.MINUTE_BUCKET_MS,
    };
    for (const resolution of Contract.ANALYTICS_RESOLUTIONS) {
      expect({ resolution, width: widths[resolution] }).toEqual({
        resolution,
        width: resolution * 1_000,
      });
    }
    // The default is one of them — a default nobody may ask for would be a
    // 400 on every request that omits `resolution`.
    expect([...Contract.ANALYTICS_RESOLUTIONS]).toContain(
      Contract.DEFAULT_ANALYTICS_RESOLUTION,
    );
    // The default preset is one of the presets, and every preset fits inside
    // the span cap: a picker built from this list must not be able to compose
    // a request the API refuses.
    expect([...Contract.ANALYTICS_PRESETS]).toContain(
      Contract.DEFAULT_ANALYTICS_PRESET,
    );
    for (const preset of Contract.ANALYTICS_PRESETS) {
      const span = preset * 1_000;
      expect({
        preset,
        fits:
          span >= Contract.MIN_ANALYTICS_SPAN_MS &&
          span <= Contract.MAX_ANALYTICS_SPAN_MS,
      }).toEqual({ preset, fits: true });
    }
    // Shortest first, so a picker renders them in order without sorting.
    expect([...Contract.ANALYTICS_PRESETS]).toEqual(
      [...Contract.ANALYTICS_PRESETS].sort((a, b) => a - b),
    );
    // The control: a preset wider than a day would be caught by the check
    // above, rather than passing because the list is merely non-empty.
    const tooWide = 48 * 60 * 60;
    expect(tooWide * 1_000 <= Contract.MAX_ANALYTICS_SPAN_MS).toBe(false);
    // Per-second retention: a default at or under the ceiling, both inside
    // what minute buckets cover, and the span cap is the minute retention.
    expect(Contract.DEFAULT_SECOND_RETENTION_MS).toBe(5 * 60_000);
    expect(Contract.MAX_SECOND_RETENTION_MS).toBe(15 * 60_000);
    expect(Contract.DEFAULT_SECOND_RETENTION_MS).toBeLessThanOrEqual(
      Contract.MAX_SECOND_RETENTION_MS,
    );
    expect(Contract.MAX_SECOND_RETENTION_MS).toBeLessThan(
      Contract.MINUTE_RETENTION_MS,
    );
    expect(Contract.MAX_ANALYTICS_SPAN_MS).toBe(Contract.MINUTE_RETENTION_MS);
    // The bucket cap has to admit the whole span at the coarsest resolution,
    // or a day-long request could not be served at all.
    expect(
      Contract.MAX_ANALYTICS_SPAN_MS / Contract.MINUTE_BUCKET_MS,
    ).toBeLessThanOrEqual(Contract.MAX_ANALYTICS_BUCKETS);
    // …and must refuse a day at one second, which is what makes the fallback
    // to 60 s buckets (`reason: "maxBuckets"`) the documented behaviour.
    expect(
      Contract.MAX_ANALYTICS_SPAN_MS / Contract.SECOND_BUCKET_MS,
    ).toBeGreaterThan(Contract.MAX_ANALYTICS_BUCKETS);
    // The per-second window itself fits in one series at one second, or the
    // finest resolution could never be served.
    expect(
      Contract.MAX_SECOND_RETENTION_MS / Contract.SECOND_BUCKET_MS,
    ).toBeLessThanOrEqual(Contract.MAX_ANALYTICS_BUCKETS);
    // The caps the user settled.
    expect(Contract.MAX_ANALYTICS_SERIES).toBe(20);
    expect(Contract.MAX_ANALYTICS_ROWS).toBe(100);
    // A listing truncates and an explicit over-ask is refused, so the row cap
    // has to be the looser of the two or the section could not fill a page.
    expect(Contract.MAX_ANALYTICS_ROWS).toBeGreaterThan(
      Contract.MAX_ANALYTICS_SERIES,
    );
  });

  it("the added-by-state range and the job-list sorts agree with what the routes enforce", () => {
    // A day, the analytics picker's own limit, so one picker serves both
    // halves of a card. Its own name, but equal today: until the route's range
    // reader takes its own cap, it reads the analytics one, and the two must
    // not disagree.
    expect(Contract.MAX_ADDED_BY_STATE_SPAN_MS).toBe(24 * 60 * 60 * 1_000);
    expect(Contract.MAX_ADDED_BY_STATE_SPAN_MS).toBe(
      Contract.MAX_ANALYTICS_SPAN_MS,
    );
    expect(Contract.MAX_ADDED_BY_STATE_SPAN_MS).toBeGreaterThan(
      Contract.MIN_ANALYTICS_SPAN_MS,
    );
    // Every preset a shared picker offers fits the added-by-state cap too.
    for (const preset of Contract.ANALYTICS_PRESETS) {
      expect({
        preset,
        fits: preset * 1_000 <= Contract.MAX_ADDED_BY_STATE_SPAN_MS,
      }).toEqual({ preset, fits: true });
    }
    // The default sort is listed first — the natural order every existing
    // client already gets — and `createdAt` is the one addition.
    expect(Contract.JOB_LIST_SORTS[0]).toBe("natural");
    expect([...Contract.JOB_LIST_SORTS]).toEqual(["natural", "createdAt"]);
  });

  it("the duration histogram's bins are 24 powers of two, ratio 2", () => {
    const bounds: number[] = [...Contract.DURATION_HISTOGRAM_BOUNDS];
    expect(bounds).toHaveLength(24);
    expect(bounds[0]).toBe(1);
    expect(bounds.at(-1)).toBe(2 ** 23);
    expect(bounds).toEqual(
      Array.from({ length: 24 }, (_unused, index) => 2 ** index),
    );
    // Every edge is exactly twice the one before: the ratio is what bounds a
    // quantile read to a factor of 2, so it is the property to assert rather
    // than the literal list alone.
    for (let index = 1; index < bounds.length; index++) {
      expect({ index, ratio: bounds[index]! / bounds[index - 1]! }).toEqual({
        index,
        ratio: 2,
      });
    }
    // The control: a list with one edge nudged is not this list, so the
    // assertions above are comparing values rather than shape.
    const nudged = bounds.map((value, index) =>
      index === 7 ? value + 1 : value,
    );
    expect(nudged).not.toEqual(bounds);
    expect(nudged[7]! / nudged[6]!).not.toBe(2);
  });

  it("adds no action for analytics: the action list is exactly what shipped", () => {
    // Every new action string breaks a host that passes an explicit `actions`
    // allow-list, and the analytics series expose nothing `metrics.read`,
    // `runners.read` and `workers.read` do not. So "no action was added" is an
    // invariant with a test, not a note in a review: this list is the whole
    // list, and a 49th entry fails here. (The last four added were the clear
    // actions, `jobs.clearLogs` and `runners.clearHistory`, and the queue job
    // defaults, `queues.defaults` and `queues.applyDefaults`, each a
    // deliberate new permission rather than an analytics series.)
    expect([...Contract.JOBS_API_ACTIONS]).toEqual([
      "meta.read",
      "docs.read",
      "queues.list",
      "queues.read",
      "queues.pause",
      "queues.resume",
      "queues.drain",
      "queues.clean",
      "queues.limits",
      "queues.defaults",
      "queues.applyDefaults",
      "metrics.read",
      "workers.list",
      "workers.read",
      "workers.pause",
      "workers.resume",
      "workers.stop",
      "workers.start",
      "workers.configure",
      "jobs.list",
      "jobs.read",
      "jobs.logs",
      "jobs.add",
      "jobs.update",
      "jobs.retry",
      "jobs.retryAll",
      "jobs.remove",
      "jobs.clearLogs",
      "jobs.promote",
      "jobs.fail",
      "repeatables.list",
      "repeatables.remove",
      "repeatables.disable",
      "repeatables.enable",
      "definitions.list",
      "runners.list",
      "runners.read",
      "runners.logs",
      "runners.trigger",
      "runners.pause",
      "runners.resume",
      "runners.kill",
      "runners.reschedule",
      "runners.resetStats",
      "runners.clearHistory",
      "runners.configure",
      "events.connect",
      "events.subscribe",
    ]);
    // Reading metrics is one action, and it is a read: not a mutation, not
    // opt-in, and not split per series.
    expect(
      Contract.JOBS_API_ACTIONS.filter((action) =>
        action.startsWith("metrics."),
      ),
    ).toEqual(["metrics.read"]);
    expect(Contract.JOBS_API_MUTATIONS.has("metrics.read")).toBe(false);
    expect(Contract.JOBS_API_OPT_IN_ACTIONS.has("metrics.read")).toBe(false);
    // No action anywhere is named after this feature.
    for (const action of Contract.JOBS_API_ACTIONS) {
      expect({ action, analytics: action.includes("analytics") }).toEqual({
        action,
        analytics: false,
      });
    }
    // The control: the same comparison with one plausible new action appended
    // fails, so the assertion above really would catch `metrics.analytics`.
    expect([...Contract.JOBS_API_ACTIONS, "metrics.analytics"]).not.toEqual([
      ...Contract.JOBS_API_ACTIONS,
    ]);
  });

  it("restates the runtime's worker tables value for value", () => {
    // `lib/shared/workers.ts` is the runtime's copy and the contract may
    // import nothing, so the two exist separately and must stay identical.
    // The dependency may only run one way — the runtime may import the
    // contract, never the reverse, which the import-graph test above holds.
    expect([...Contract.WORKER_STATES]).toEqual([...Workers.WORKER_STATES]);
    expect([...Contract.WORKER_CONFIG_KEYS]).toEqual([
      ...Workers.WORKER_CONFIG_KEYS,
    ]);
    expect(Contract.WORKER_CONFIG_BOUNDS).toEqual(Workers.WORKER_CONFIG_BOUNDS);
    expect([...Contract.WORKER_EVENT_TYPES]).toEqual([
      ...Workers.WORKER_EVENT_TYPES,
    ]);
    expect([...Contract.WORKER_CONTROL_ACTIONS]).toEqual([
      ...Workers.WORKER_CONTROL_ACTIONS,
    ]);
    expect([...Contract.WORKER_STOP_PERSISTENCE]).toEqual([
      ...Workers.WORKER_STOP_PERSISTENCE,
    ]);
    expect([...Contract.WORKER_TARGET_KINDS]).toEqual([
      ...Workers.WORKER_TARGET_KINDS,
    ]);
    // Every bound the runtime enforces is the one a UI would show, to the
    // number: a copy that merely has the same keys is not enough.
    for (const key of Workers.WORKER_CONFIG_KEYS) {
      expect({ key, bound: Contract.WORKER_CONFIG_BOUNDS[key] }).toEqual({
        key,
        bound: Workers.WORKER_CONFIG_BOUNDS[key],
      });
    }
  });

  it("the documented name pattern and length are the drivers' key-segment rule", () => {
    const pattern = new RegExp(Contract.NAME_PARAM_PATTERN, "u");
    const accepts = (value: string) => {
      try {
        assertSegment(value, "name");
        return true;
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return false;
      }
    };
    const samples = [
      "mail",
      "a.b-c_d",
      "UPPER",
      "x".repeat(Contract.MAX_NAME_LENGTH),
      ".",
      "..",
      "...",
      ".hidden",
      "bad/name",
      "bad name",
      "bad:name",
      "ümlaut",
      "",
    ];
    for (const sample of samples) {
      expect({ sample, documented: pattern.test(sample) }).toEqual({
        sample,
        documented: accepts(sample),
      });
    }
    expect(accepts("x".repeat(Contract.MAX_NAME_LENGTH + 1))).toBe(false);
    expect(new RegExp(Contract.NAME_SEGMENT_PATTERN).source).toBe("^[\\w.-]+$");
  });
});
