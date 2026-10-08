import type { Subprocess } from "bun";
import type { SummonFacet, UnitStatus } from "../../lib/provider/index";
import type { ConformanceReport } from "../../lib/provider/testing/index";
import process from "node:process";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { ConfigError } from "../../lib/index";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  localCompute,
} from "../../lib/provider/index";
import {
  assertConformance,
  CONFORMANCE_WORKER,
  runProviderConformance,
} from "../../lib/provider/testing/index";
import { crossProcessBackends } from "../helpers/backends";

/**
 * `localCompute` through the conformance kit, on every backend processes
 * share, the handoff and the race included: the proof it behaves like any
 * provider. It has no platform API, so the kit runs self-hosted (no
 * `platform`): the provider starts the kit's fixture worker itself.
 *
 * Then the kit's self-hosted mode proving itself: a self-hosted provider
 * broken one way fails the check that reads that way.
 */

setDefaultTimeout(240_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const backends = await crossProcessBackends({ cleanups });

/** The checks a self-hosted run must pass, not skip. */
const MUST_PASS = [
  "summon.config.accepts",
  "summon.config.rejects-invalid",
  "summon.capabilities.well-formed",
  "summon.dedupe.same-key-one-unit",
  "summon.concurrency.distinct-ids",
  "summon.concurrency.same-id-one-unit",
  "summon.timeouts.rejects-on-abort",
  "summon.timeouts.no-timer-left",
  "summon.status.knows-handles",
  "summon.status.cancel-stops-pending",
  "summon.lifetime.enforced",
  "summon.describe.facts",
  "summon.validate.healthy",
  "summon.argv.round-trip",
  "summon.handoff.started",
  "summon.handoff.released",
  "summon.handoff.drained",
  "summon.cas.one-call",
];

/** A check's status in a report. */
function statusOf(report: ConformanceReport, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

describe("localCompute conforms", () => {
  for (const backend of backends) {
    it.skipIf(!backend.available)(
      `on ${backend.name}, handoff and race included`,
      async () => {
        const report = await runProviderConformance(localCompute, {
          config: {
            entry: CONFORMANCE_WORKER,
            // The concurrency check starts 16 at once.
            maxUnits: 32,
            output: "ignore",
            shutdown: { graceMs: 2_000 },
          },
          invalidConfigs: [
            { config: {}, path: "entry" },
            {
              config: { entry: CONFORMANCE_WORKER, maxUnits: 0 },
              path: "maxUnits",
            },
            { config: { entry: CONFORMANCE_WORKER, env: 3 }, path: "env" },
            {
              config: { entry: CONFORMANCE_WORKER, passEnv: "PATH" },
              path: "passEnv",
            },
          ],
          platform: "none",
          driver: backend.config,
        });
        assertConformance(report);
        expect(
          MUST_PASS.filter((id) => statusOf(report, id) !== "pass"),
        ).toEqual([]);
        expect(report.toMarkdown()).toContain("Result: conforms");
      },
    );
  }
});

/** What a broken self-hosted provider gets wrong. */
type Defect =
  | "drops-argv"
  | "ignores-abort"
  | "leaves-timer"
  | "no-status"
  | "fetches"
  | "claims-lifetime";

/**
 * A minimal self-hosted provider, written the way a third party would:
 * `Bun.spawn` of the configured entry with the request's argv and env.
 * With a `defect`, broken in exactly that way.
 */
function selfHosted(defect?: Defect) {
  return defineComputeProvider<{ entry: string }>({
    name: "self-hosted-test",
    version: "1.0.0",
    kind: "self-test",
    apiVersion: {
      core: COMPUTE_PROVIDER_API.core,
      summon: COMPUTE_PROVIDER_API.summon,
    },
    summon: (config) => {
      const units = new Map<string, Subprocess>();
      const tokens = new Map<string, string>();
      let next = 0;
      const live = (proc: Subprocess) =>
        proc.exitCode === null && proc.signalCode === null;
      const facet: SummonFacet = {
        capabilities: {
          style: "launch",
          dedupe: {
            kind: "token",
            maxLength: 64,
            charset: "A-Za-z0-9-",
            scope: "process",
            strict: false,
          },
          passes: "argv",
          bootBudgetMs: 30_000,
          shutdown: { signal: "SIGTERM", graceMs: 1_000 },
          maxLifetimeMs: null,
          // Declared, and then not done: the lifetime check must catch it.
          enforcesLifetime: defect === "claims-lifetime",
        },
        summon: async (request, context) => {
          if (defect !== "ignores-abort" && context.signal.aborted) {
            throw new Error("aborted");
          }
          if (defect === "fetches") {
            // A provider with a platform after all, run as self-hosted.
            await context.fetch("http://127.0.0.1:9/").catch(() => {});
          }
          const known = tokens.get(request.dedupeKey);
          if (known !== undefined) {
            return { status: "deduped", handles: [known] };
          }
          const handle = `self-${++next}`;
          tokens.set(request.dedupeKey, handle);
          units.set(
            handle,
            Bun.spawn({
              cmd: [
                process.execPath,
                config.entry,
                ...(defect === "drops-argv" ? [] : request.argv),
              ],
              env: { PATH: process.env.PATH ?? "", ...request.env },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          if (defect === "leaves-timer") {
            setTimeout(() => {}, 60_000);
          }
          return { status: "started", handles: [handle] };
        },
        cancel: async (handles) => {
          await Promise.all(
            handles.map(async (handle) => {
              const proc = units.get(handle);
              proc?.kill("SIGKILL");
              await proc?.exited;
            }),
          );
        },
      };
      if (defect !== "no-status") {
        facet.status = async (handles): Promise<UnitStatus[]> =>
          handles.map((handle) => {
            const proc = units.get(handle);
            if (proc === undefined) {
              return { handle, state: "unknown" };
            }
            if (live(proc)) {
              return { handle, state: "running" };
            }
            return proc.exitCode === 0
              ? { handle, state: "exited", exitCode: 0 }
              : { handle, state: "failed", exitCode: proc.exitCode ?? 137 };
          });
      }
      return facet;
    },
  });
}

/** Runs the kit self-hosted on a broken provider, the slow groups skipped where they are not the point. */
async function run(
  defect?: Defect,
  skip: string[] = [],
): Promise<ConformanceReport> {
  return await runProviderConformance(selfHosted(defect), {
    config: { entry: CONFORMANCE_WORKER },
    platform: "none",
    skip: skip.map((id) => ({ id, reason: "not this test's point" })),
  });
}

/** The ids of the checks that failed. */
function failed(report: ConformanceReport): string[] {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.id);
}

describe("the kit's self-hosted mode (negative controls)", () => {
  it("refuses a run with no platform at all, rather than running self-hosted", async () => {
    // What plain JavaScript, or a cast, can still pass.
    await expect(
      runProviderConformance(selfHosted(), {
        config: { entry: CONFORMANCE_WORKER },
      } as never),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("passes a correct self-hosted provider, and skips what needs a platform", async () => {
    const report = await run();
    expect(failed(report)).toEqual([]);
    expect(statusOf(report, "summon.handoff.drained")).toBe("pass");
    expect(statusOf(report, "summon.routing.through-ctx-fetch")).toBe("skip");
    expect(statusOf(report, "summon.lifetime.enforced")).toBe("skip");
    expect(
      report.checks.find((check) => check.id === "summon.errors.auth")?.detail,
    ).toContain("no platform");
  });

  it("fails the round trip and the handoff of one that drops the summon arguments", async () => {
    const report = await run("drops-argv", ["summon.cas.one-call"]);
    // Two checks read the same defect: the round trip sees no argument
    // arrive, and the handoff's worker never names its attempt.
    expect(failed(report)).toEqual([
      "summon.argv.round-trip",
      "summon.handoff.released",
    ]);
    expect(
      report.checks.find((check) => check.id === "summon.argv.round-trip")
        ?.detail,
    ).toContain("pass request.argv to the unit");
    expect(
      report.checks.find((check) => check.id === "summon.handoff.released")
        ?.detail,
    ).toContain("request.argv");
  });

  it("fails rejects-on-abort for one that starts despite an aborted signal", async () => {
    const report = await run("ignores-abort", [
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.cas.one-call",
    ]);
    expect(failed(report)).toEqual(["summon.timeouts.rejects-on-abort"]);
  });

  it("fails no-timer-left for one that leaves a timer", async () => {
    const report = await run("leaves-timer", [
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.cas.one-call",
    ]);
    expect(failed(report)).toEqual(["summon.timeouts.no-timer-left"]);
  });

  it("fails routing for one that calls ctx.fetch, so a forgotten fake cannot pass", async () => {
    const report = await run("fetches", [
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.cas.one-call",
    ]);
    expect(failed(report)).toEqual(["summon.routing.through-ctx-fetch"]);
    expect(
      report.checks.find(
        (check) => check.id === "summon.routing.through-ctx-fetch",
      )?.detail,
    ).toContain("give the kit a fake");
  });

  it("fails lifetime for one that declares enforcesLifetime and does not enforce it", async () => {
    const report = await run("claims-lifetime", [
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.cas.one-call",
    ]);
    expect(failed(report)).toEqual(["summon.lifetime.enforced"]);
  });

  it("fails the handoff of one with no status(), which nothing else can follow", async () => {
    const report = await run("no-status", ["summon.cas.one-call"]);
    expect(failed(report)).toEqual(["summon.handoff.started"]);
    expect(statusOf(report, "summon.status.cancel-stops-pending")).toBe("skip");
  });
});
