import type { Subprocess } from "bun";
import type { SummonClaim } from "../lib/summon/claim";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createDriver, SUMMON_ARGS } from "../lib/index";
import { tallySummonClaim } from "../lib/summon/claim";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `runSummoned` stopped while a worker's summon claim has committed but the
 * worker does not know it yet (`worker.summon` unset): the unit's own exit
 * mark cannot see that claim, so the worker's close must write the unit's
 * reason and code on it (`SET_EXIT_MARK`) — never its own `"closed"`, `0`,
 * which reads a failed unit as a clean close. From the #313 round-3 review's
 * probes, as tests.
 *
 * And the same window when the claim call itself fails after its write
 * committed (the reply lost): the worker's claim is then undecided, not won,
 * and its close must still mark the place it holds — else the controller
 * reads a clean exit as a death once the holder's grace has passed (#313
 * round 4). With the negative controls: a worker holding no place writes
 * nothing on the claim, whether its claim is undecided or lost.
 */

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "run-summoned-claim-window.ts",
);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});
const BACKENDS = await crossProcessBackends({ cleanups });

/** One line the fixture printed. */
interface Line {
  /** What happened. */
  event: string;
  /** `claim-committed`: whether the worker knew of its claim then. */
  summonKnown?: boolean;
  /** `claim-call-returning`: whether the unit had begun closing by then. */
  closingSeen?: boolean;
  /** `result`: the unit's reason. */
  reason?: string;
  /** `result`: the unit's exit code. */
  code?: number;
  /** `claim`: whether renders' claim has a holder. */
  held?: boolean;
  /** `claim`: the exit mark on it, or `null`. */
  exit?: Record<string, unknown> | null;
  /** `claim`: the whole entry as read back, or `null`. */
  value?: SummonClaim | null;
  /** `claim`: renders' worker id. */
  worker?: string;
  /** `log`: the message of a warning or an error. */
  message?: string;
}

const running: Subprocess[] = [];
afterEach(() => {
  for (const proc of running.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  }
});

/** Runs the fixture to its exit and answers its lines, failing on a hang. */
async function run(
  env: Record<string, string>,
  namespace: string,
  id: string,
  queues: string[],
): Promise<Line[]> {
  const proc = Bun.spawn(
    [
      process.execPath,
      FIXTURE,
      `${SUMMON_ARGS.id}=${id}`,
      `${SUMMON_ARGS.kind}=test`,
      `${SUMMON_ARGS.namespace}=${namespace}`,
      ...queues.map((queue) => `${SUMMON_ARGS.queue}=${queue}`),
    ],
    {
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  running.push(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const lines = stdout
    .split("\n")
    .filter((text) => text.startsWith("{"))
    .map((text) => JSON.parse(text) as Line);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  return lines;
}

/** The first line of `event`, failing with every line if there is none. */
function lineOf(lines: Line[], event: string): Line {
  const line = lines.find((one) => one.event === event);
  if (line === undefined) {
    throw new Error(
      `no "${event}" line; the fixture printed:\n${lines.map((one) => JSON.stringify(one)).join("\n")}`,
    );
  }
  return line;
}

/** Every line, for a failed assertion's message. */
const all = (lines: Line[]): string =>
  lines.map((line) => JSON.stringify(line)).join("\n");

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `runSummoned: a claim committed but not yet known, on ${backend.name}`,
    () => {
      /** Runs one case in a namespace of its own, removed after. */
      const runIn = async (
        tag: string,
        env: Record<string, string>,
        queues: string[],
      ): Promise<Line[]> => {
        const namespace = testNamespace(`claim-window-${tag}-${backend.name}`);
        try {
          return await run(
            { DRIVER: JSON.stringify(backend.config), ...env },
            namespace,
            `sm_cw${tag}${backend.name}`,
            queues,
          );
        } finally {
          const store = createDriver(backend.config);
          await store.connect();
          await store.purge(namespace).catch(() => {});
          await store.close();
        }
      };

      /** One window case: how the unit stops, and what must come of it. */
      interface WindowCase {
        /** What the test is named after. */
        name: string;
        /** The fixture's `STOP` and `READY`. */
        env: Record<string, string>;
        /** The queues the summon arguments name. */
        queues: string[];
        /** The unit's result. */
        result: { reason: string; code: number };
        /** The exit mark renders' claim must carry. */
        exit: Record<string, unknown>;
      }

      const cases: WindowCase[] = [
        {
          name: "a signal while it is starting",
          env: { STOP: "signal" },
          queues: ["thumbs", "renders"],
          result: { reason: "signal", code: 0 },
          exit: { reason: "signal", code: 0, forced: true },
        },
        {
          name: "a sibling's failed start while it is starting",
          env: { STOP: "fail" },
          queues: ["thumbs", "renders", "maps"],
          result: { reason: "error", code: 1 },
          exit: { reason: "error", code: 1, forced: true },
        },
        {
          name: "a signal once it is ready",
          env: { STOP: "signal", READY: "1" },
          queues: ["thumbs", "renders"],
          result: { reason: "signal", code: 0 },
          exit: { reason: "signal", code: 0 },
        },
        {
          name: "a sibling's failed start once it is ready",
          env: { STOP: "fail", READY: "1" },
          queues: ["thumbs", "renders", "maps"],
          result: { reason: "error", code: 1 },
          exit: { reason: "error", code: 1 },
        },
      ];

      for (const [index, one] of cases.entries()) {
        it(`${one.name}: the claim carries the unit's reason, not "closed"`, async () => {
          const lines = await runIn(
            `w${index}`,
            { MODE: "window", COMMIT_DELAY: "300", ...one.env },
            one.queues,
          );
          // The stop landed inside the window: the claim had committed, the
          // worker did not know it yet, and the unit was closing before its
          // claim call returned.
          expect(lineOf(lines, "claim-committed").summonKnown).toBe(false);
          expect(lineOf(lines, "claim-call-returning").closingSeen).toBe(true);
          if (one.env.READY === "1") {
            expect(
              lines.findIndex((line) => line.event === "renders-ready"),
            ).toBeLessThan(
              lines.findIndex((line) => line.event === "claim-committed"),
            );
          } else {
            expect(lines.some((line) => line.event === "renders-ready")).toBe(
              false,
            );
          }
          expect(lineOf(lines, "result")).toMatchObject(one.result);
          const claim = lineOf(lines, "claim");
          expect(claim.held, all(lines)).toBe(true);
          expect(claim.exit, all(lines)).toMatchObject(one.exit);
        }, 60_000);
      }

      // The claim call fails after its write committed: the worker never
      // learns it won, so its claim stays undecided through the close.
      for (const [index, one] of cases.entries()) {
        it(`${one.name}, its claim call failing after the write: the claim is marked, and the tally reads no death`, async () => {
          const lines = await runIn(
            `t${index}`,
            {
              MODE: "window",
              COMMIT_DELAY: "100",
              CLAIM_THROW: "1",
              ...one.env,
            },
            one.queues,
          );
          expect(lineOf(lines, "claim-committed").summonKnown).toBe(false);
          expect(lineOf(lines, "result")).toMatchObject(one.result);
          const claim = lineOf(lines, "claim");
          expect(claim.held, all(lines)).toBe(true);
          expect(claim.exit, all(lines)).toMatchObject(one.exit);
          // The controller's view once the holder's grace is long past, its
          // record gone: the unit's exit, never a death.
          const holder = claim.value!.holders[0]!;
          expect(holder.worker).toBe(claim.worker!);
          const tally = tallySummonClaim(
            claim.value!,
            new Set(),
            holder.until + 60_000,
            5_000,
            0,
          );
          expect(tally, all(lines)).toMatchObject(
            one.result.code === 0
              ? { succeeded: 1, exitedWithError: 0, died: 0, starting: 0 }
              : { succeeded: 0, exitedWithError: 1, died: 0, starting: 0 },
          );
        }, 60_000);
      }

      // Negative controls: a worker holding no place in the claim — another
      // worker has it — writes nothing there, its claim undecided (its claim
      // read failed) or lost.
      for (const read of ["throw", "pass"] as const) {
        it(`a claim another worker holds stays untouched, renders' claim ${read === "throw" ? "undecided" : "lost"}`, async () => {
          const lines = await runIn(
            `f${read}`,
            { MODE: "foreign", CLAIM_READ: read },
            ["thumbs", "renders"],
          );
          lineOf(lines, "claim-read");
          expect(lineOf(lines, "result")).toMatchObject({
            reason: "signal",
            code: 0,
          });
          const claim = lineOf(lines, "claim");
          expect(claim.value, all(lines)).toMatchObject({ capacity: 1 });
          expect(claim.value!.holders, all(lines)).toHaveLength(1);
          const [holder] = claim.value!.holders;
          expect(holder!.worker).toBe("foreign-worker");
          expect(holder!.exit, all(lines)).toBeUndefined();
        }, 60_000);
      }

      it("(smoke) a sibling failing to start by timing alone never leaves the claim reading a clean close", async () => {
        // A supplemental smoke test; the injected cases above are the proof
        // of the window. Swept across it: depending on the backend and load,
        // the failure lands before the claim is written, while it is in
        // flight, or after the worker knows it. Which of those a given run
        // hits is not asserted, so this can pass without hitting the window.
        const outcomes: string[] = [];
        // Under load the claim can land later than the last of these, so no
        // run of the sweep reaches it; then later failures are tried, until
        // one does or the slowest has run.
        const sweep = [5, 10, 20, 35, 50, 65, 80];
        const later = [150, 300, 600, 1200, 2400];
        const reached = () =>
          outcomes.some((outcome) => !outcome.endsWith(":none"));
        while (sweep.length > 0 || (!reached() && later.length > 0)) {
          const failMs = (sweep.length > 0 ? sweep : later).shift()!;
          const lines = await runIn(
            `n${failMs}`,
            { MODE: "natural", FAIL_MS: String(failMs) },
            ["thumbs", "renders"],
          );
          expect(lineOf(lines, "result"), all(lines)).toMatchObject({
            reason: "error",
            code: 1,
          });
          const claim = lineOf(lines, "claim");
          if (claim.held) {
            expect(
              claim.exit,
              `FAIL_MS=${failMs}\n${all(lines)}`,
            ).toMatchObject({ reason: "error", code: 1 });
          }
          outcomes.push(
            `${failMs}:${claim.held ? JSON.stringify(claim.exit) : "none"}`,
          );
        }
        // At least one run got as far as its claim (known or in flight), so
        // the claim assertion ran at least once.
        expect(reached(), outcomes.join(" ")).toBe(true);
      }, 180_000);
    },
  );
}
