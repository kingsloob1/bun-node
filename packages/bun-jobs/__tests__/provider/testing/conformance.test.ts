import type { DriverConfig } from "../../../lib/index";
import type {
  ConformanceReport,
  FakePlatform,
} from "../../../lib/provider/testing/index";
import type { SummonRequest } from "../../../lib/summon/index";
import type { AcmeDefect, AcmeOptions } from "./acme";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { ConfigError, createDriver, JobsError } from "../../../lib/index";
import { fakeInternals } from "../../../lib/provider/testing/fake";
import {
  assertConformance,
  runProviderConformance,
} from "../../../lib/provider/testing/index";
import { buildReport } from "../../../lib/provider/testing/report";
import { SUMMON_MARKER } from "../../../lib/summon/marker";
import { crossProcessBackends } from "../../helpers/backends";
import { acmeConfig, acmeFake, acmeProvider, acmeSummoner } from "./acme";

/**
 * The conformance kit proving itself (summon-compute §13.10, "What the
 * conformance kit must prove"), with no cloud credentials:
 *
 * - a known-good `defineComputeProvider` provider and a `defineSummoner`
 *   summoner pass every `must` check, the real controller-and-worker handoff
 *   and the two-process race included;
 * - one provider broken in exactly one way per `must` group fails exactly
 *   that group;
 * - `assertConformance` throws on a failed `must` and not on a `should`
 *   warning, and the report names every check and says it ran against a
 *   fake.
 */

setDefaultTimeout(120_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** The fakes a test opened, closed after it. */
const platforms: FakePlatform[] = [];
afterEach(async () => {
  for (const platform of platforms.splice(0)) {
    await platform.close();
  }
});

/** A fresh Acme fake, closed after the test. */
async function fake(): Promise<FakePlatform> {
  const platform = await acmeFake();
  platforms.push(platform);
  return platform;
}

/** The ids of the checks that failed (a failed `should` reads `warn`). */
function failed(report: ConformanceReport): string[] {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.id);
}

/** The groups of the checks that failed. */
function failedGroups(report: ConformanceReport): string[] {
  return [...new Set(failed(report).map((id) => id.split(".")[1]!))];
}

/** Runs the kit on an Acme provider over a fresh fake. */
async function acme(
  options: Parameters<typeof acmeProvider>[0] = {},
  extra: {
    /** Checks to skip. */
    skip?: { id: string; reason: string }[];
    /** The handoff's backend. */
    driver?: DriverConfig;
  } = {},
): Promise<ConformanceReport> {
  const platform = await fake();
  return await runProviderConformance(acmeProvider(options), {
    config: acmeConfig(platform),
    invalidConfigs: [
      {
        config: { url: platform.url, apiToken: "x".repeat(16) },
        path: "region",
      },
      { config: { region: "eu" }, path: "url" },
    ],
    platform,
    ...extra,
  });
}

describe("a known-good provider conforms", () => {
  it("launch, passes argv: every must check passes, the handoff and the race included", async () => {
    const report = await acme();
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(report.ok).toBe(true);
    assertConformance(report);
    const status = Object.fromEntries(
      report.checks.map((check) => [check.id, check.status]),
    );
    for (const id of [
      "summon.routing.through-ctx-fetch",
      "summon.dedupe.same-key-one-unit",
      "summon.errors.throttled",
      "summon.timeouts.no-timer-left",
      "summon.secrets.no-leak",
      "summon.argv.round-trip",
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.cas.one-call",
    ]) {
      expect(status[id], id).toBe("pass");
    }
    expect(
      report.checks.find((check) => check.id === "summon.argv.round-trip")
        ?.detail,
    ).toBe(
      "all 10 arguments arrived in order, the 3 repeated --bun-jobs-summon-queue= among them",
    );
    expect(
      report.checks.find((check) => check.id === "summon.handoff.released")
        ?.detail,
    ).toBe("by id");
    expect(report.subject).toBe("@acme/bun-jobs-provider-acme@1.0.0");
    // Every errors check had the controller's verdict, not only the provider's answer.
    for (const check of report.checks.filter((one) =>
      one.id.startsWith("summon.errors."),
    )) {
      expect(check.detail, check.id).toBeUndefined();
    }
  });

  it("passes none: the attempt is released by the worker's start time", async () => {
    const report = await acme({ passes: "none" });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(
      report.checks.find((check) => check.id === "summon.handoff.released")
        ?.detail,
    ).toBe("by start time");
    expect(
      report.checks.find((check) => check.id === "summon.argv.round-trip"),
    ).toMatchObject({ status: "skip" });
  });

  it("scale: a target set twice is one count, release sets zero, and an idle controller scales down", async () => {
    const calls: Parameters<NonNullable<AcmeOptions["onCall"]>>[0][] = [];
    /** The fake's live count when the round trip's summon reached the provider. */
    let liveBefore: number | undefined;
    const report = await acme({
      style: "scale",
      onCall: (call) => {
        calls.push(call);
        if (
          call.kind === "summon" &&
          (call.request.queues?.length ?? 1) > 1 &&
          liveBefore === undefined
        ) {
          liveBefore = fakeInternals(platforms.at(-1)!).liveCount();
        }
      },
    });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    // The round trip's count goes back by releasing the unit it summoned:
    // its queues and group, to the count before it.
    const roundTrip = calls.findIndex(
      (call) => call.kind === "summon" && call.request.queues?.length === 3,
    );
    expect(roundTrip).toBeGreaterThanOrEqual(0);
    expect(liveBefore).toBeDefined();
    const summoned = calls[roundTrip]!.request as SummonRequest;
    expect(summoned.target).toBe(liveBefore! + 1);
    const released = calls
      .slice(roundTrip + 1)
      .find((call) => call.kind === "release");
    expect(released?.request).toEqual({
      namespace: summoned.namespace,
      queue: "work",
      queues: ["work", "work.b", "work_c-2"],
      group: "conformance",
      target: liveBefore!,
    });
    const status = Object.fromEntries(
      report.checks.map((check) => [check.id, check.status]),
    );
    expect(status["summon.scale.target-idempotent"]).toBe("pass");
    expect(status["summon.scale.release-to-zero"]).toBe("pass");
    expect(status["summon.handoff.scale-down"]).toBe("pass");
    expect(status["summon.argv.round-trip"]).toBe("pass");
    expect(status["summon.concurrency.distinct-ids"]).toBe("skip");
  });

  it("a defineSummoner summoner conforms, its missing hooks skipped", async () => {
    const platform = await fake();
    const report = await runProviderConformance(acmeSummoner(platform), {
      platform,
    });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.subject).toBe("custom:acme@0.0.0");
    const status = Object.fromEntries(
      report.checks.map((check) => [check.id, check.status]),
    );
    expect(status["summon.handoff.drained"]).toBe("pass");
    expect(status["summon.cas.one-call"]).toBe("pass");
    expect(status["summon.config.accepts"]).toBe("skip");
    expect(status["summon.status.knows-handles"]).toBe("skip");
    expect(status["summon.validate.healthy"]).toBe("skip");
    expect(status["summon.secrets.no-leak"]).toBe("skip");
  });
});

/**
 * Written to PR-p1's review fixes on `feat/provider-core` (after a91243a),
 * and failing on a91243a itself until that commit is merged here: the
 * redactor masks a URL's userinfo, a `Headers` and a `Map`; and a controller
 * built while an asynchronous config validates adopts the scale style
 * without an attempt to adopt it at (review finding 1).
 */
describe("the host's fixed behaviour, as the kit sees it", () => {
  it("a token in a URL's userinfo, a Headers and a Map in a log field is masked: secrets pass", async () => {
    const report = await acme(
      { defect: "redacted" },
      { skip: [{ id: "summon.cas.one-call", reason: "not under test" }] },
    );
    expect(
      report.checks.find((check) => check.id === "summon.secrets.no-leak"),
      report.toMarkdown(),
    ).toMatchObject({ status: "pass" });
  });

  it("an async-config scale provider: an idle controller releases the count", async () => {
    const report = await acme({ style: "scale", asyncConfig: true });
    expect(failed(report), report.toMarkdown()).toEqual([]);
  });
});

/**
 * Each defect breaks exactly one `must` group, and the report fails exactly
 * that group: the negative controls the gate asks for (a secret in a log
 * line, the global fetch, a timestamp under a strict token, a token over
 * `maxLength`, a plain `Error`, a timer left after the abort, identity
 * dropped under `passes: "argv"`, scale with no `release`), plus one each
 * for the identity, config, concurrency, status, lifetime, validate and
 * argv groups. Dropping identity is the one defect two groups catch: with
 * no arguments at all, the argument round trip fails as well as the
 * handoff, and both say why.
 */
describe("a provider broken in one way fails exactly that group", () => {
  const cases: [AcmeDefect, string | string[], string][] = [
    ["identity", "identity", "summon.identity.version"],
    ["config", "config", "summon.config.rejects-invalid"],
    ["capabilities", "capabilities", "summon.capabilities.scale-has-release"],
    ["routing", "routing", "summon.routing.through-ctx-fetch"],
    ["purity", "purity", "summon.purity.identical-requests"],
    ["dedupe", "dedupe", "summon.dedupe.token-is-key"],
    ["concurrency", "concurrency", "summon.concurrency.distinct-ids"],
    ["errors", "errors", "summon.errors.transient"],
    ["timeouts", "timeouts", "summon.timeouts.no-timer-left"],
    ["status", "status", "summon.status.cancel-stops-pending"],
    ["lifetime", "lifetime", "summon.lifetime.enforced"],
    ["validate", "validate", "summon.validate.starts-nothing"],
    ["secrets", "secrets", "summon.secrets.no-leak"],
    ["handoff", ["argv", "handoff"], "summon.handoff.released"],
    ["argv", "argv", "summon.argv.round-trip"],
    ["argv-drop-grace", "argv", "summon.argv.round-trip"],
    ["argv-sorted", "argv", "summon.argv.round-trip"],
    ["already-running", "argv", "summon.argv.round-trip"],
  ];
  for (const [defect, group, check] of cases) {
    it(`${defect}: fails ${check}, and no group but ${[group].flat().join(" and ")}`, async () => {
      const report = await acme({ defect });
      expect(failedGroups(report), report.toMarkdown()).toEqual(
        Array.isArray(group) ? group : [group],
      );
      expect(failed(report)).toContain(check);
      expect(report.ok).toBe(false);
      expect(() => assertConformance(report)).toThrow(check);
    });
  }

  it("errors: every mapped fault fails, and a 200 with no capacity still answers unavailable", async () => {
    const report = await acme({ defect: "errors" });
    expect(failed(report).sort()).toEqual(
      [
        "summon.errors.auth",
        "summon.errors.conflict",
        "summon.errors.misconfigured",
        "summon.errors.quota",
        "summon.errors.throttled",
        "summon.errors.transient",
      ].sort(),
    );
  });

  it("mislabeled: each fault reported as a wrong kind fails both halves, the provider's answer and the controller's verdict", async () => {
    const report = await acme({ defect: "mislabeled" });
    expect(failedGroups(report), report.toMarkdown()).toEqual(["errors"]);
    const detail = (id: string): string =>
      report.checks.find((check) => check.id === id)?.detail ?? "";
    expect(detail("summon.errors.throttled")).toContain(
      "threw ProviderError(transient)",
    );
    expect(detail("summon.errors.throttled")).toContain(
      "the controller then recorded failed, not unavailable",
    );
    expect(detail("summon.errors.throttled")).toContain(
      "the controller then counted it toward the circuit",
    );
    expect(detail("summon.errors.quota")).toContain(
      "the controller then did not count it toward the circuit",
    );
    expect(detail("summon.errors.auth")).toContain(
      "the controller then did not open the circuit at once",
    );
    expect(detail("summon.errors.misconfigured")).toContain(
      "the controller then did not open the circuit at once",
    );
    expect(detail("summon.errors.conflict")).toContain(
      "recorded unavailable, not failed",
    );
    expect(detail("summon.errors.transient")).toContain(
      "the controller then did not count it toward the circuit",
    );
  });

  it("retry-units: a retry-after taken as milliseconds fails the throttled and quota waits", async () => {
    const report = await acme({ defect: "retry-units" });
    expect(failed(report), report.toMarkdown()).toEqual([
      "summon.errors.throttled",
      "summon.errors.quota",
    ]);
    expect(
      report.checks.find((check) => check.id === "summon.errors.throttled")
        ?.detail,
    ).toMatch(
      /the controller then backed off \d+ ms, under the platform's retry-after of 2000 ms/,
    );
    expect(
      report.checks.find((check) => check.id === "summon.errors.quota")?.detail,
    ).toMatch(/ProviderError\(quota\) carries retryAfterMs 2, far under/);
    expect(
      report.checks.find((check) => check.id === "summon.errors.throttled")
        ?.detail,
    ).toContain("carries retryAfterMs 2, far under the platform's 2000 ms");
  });

  it("retry-huge: an absurd retry-after fails the provider's half; the controller clamps it and backs off anyway", async () => {
    const report = await acme({ defect: "retry-huge" });
    expect(failed(report), report.toMarkdown()).toEqual([
      "summon.errors.throttled",
      "summon.errors.quota",
    ]);
    for (const kind of ["throttled", "quota"]) {
      const detail = report.checks.find(
        (check) => check.id === `summon.errors.${kind}`,
      )?.detail;
      expect(detail, kind).toContain("over a day");
      // Clamped, the wait is at least the platform's and no longer than the
      // clamp: the verdict holds (a controller without the clamp fails here).
      expect(detail, kind).not.toContain("past its clamp");
      expect(detail, kind).not.toContain("backed off");
      expect(detail, kind).not.toContain("the controller then recorded");
    }
  });

  it("prose-code: a sentence for a platformCode warns, and the controller's detail falls back to PROVIDER_<KIND>", async () => {
    const report = await acme({ defect: "prose-code" });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks.find((check) => check.id === "summon.errors.platform-code"),
    ).toMatchObject({ level: "should", status: "warn" });
    // The verdict's detail expectation follows the fallback, so every kind passes.
    for (const kind of [
      "transient",
      "throttled",
      "quota",
      "auth",
      "misconfigured",
      "conflict",
    ]) {
      expect(
        report.checks.find((check) => check.id === `summon.errors.${kind}`)
          ?.status,
        kind,
      ).toBe("pass");
    }
  });

  it("lookalike: an error shaped like ProviderError, but not one, fails the provider's half only", async () => {
    const report = await acme({ defect: "lookalike" });
    expect(failed(report).sort(), report.toMarkdown()).toEqual(
      [
        "summon.errors.auth",
        "summon.errors.conflict",
        "summon.errors.misconfigured",
        "summon.errors.quota",
        "summon.errors.throttled",
        "summon.errors.transient",
      ].sort(),
    );
    for (const check of report.checks.filter((one) => one.status === "fail")) {
      expect(check.detail).toContain("shaped like a ProviderError but not one");
      // The controller reads it by its shape, so its verdict is right.
      expect(check.detail).not.toContain("the controller");
    }
  });

  it("errors: a plain Error is transient to the controller, which counts it, and still fails the provider's half", async () => {
    const report = await acme({ defect: "errors" });
    const transient = report.checks.find(
      (check) => check.id === "summon.errors.transient",
    )!;
    expect(transient.status).toBe("fail");
    expect(transient.detail).toContain("not a ProviderError: map it");
    expect(transient.detail).not.toContain("the controller recorded");
    expect(transient.detail).not.toContain("did not count");
  });

  it("argv: every argument of request.argv must arrive, in order, not only the queues", async () => {
    const detail = async (defect: AcmeDefect): Promise<string> => {
      const report = await acme(
        { defect },
        { skip: [{ id: "summon.cas.one-call", reason: "not under test" }] },
      );
      const check = report.checks.find(
        (one) => one.id === "summon.argv.round-trip",
      );
      return check?.detail ?? "";
    };
    expect(await detail("argv-drop-grace")).toBe(
      "the unit never received argument 10 of 10 (--bun-jobs-summon-grace-ms=): pass request.argv to the unit whole and in order",
    );
    expect(await detail("argv-sorted")).toContain(
      "the unit received request.argv out of order",
    );
  });

  it("argv, scale: a release of the round trip's unit that throws fails the check, and only it", async () => {
    const report = await acme({ style: "scale", defect: "release-shared" });
    expect(failed(report), report.toMarkdown()).toEqual([
      "summon.argv.round-trip",
    ]);
    expect(
      report.checks.find((check) => check.id === "summon.argv.round-trip")
        ?.detail,
    ).toBe(
      "the release of the round trip's unit (target 0) threw ProviderError (PROVIDER_TRANSIENT), so the count was not restored",
    );
  });

  it("argv, scale: already-running is a skip, since a scale platform's unit may be up", async () => {
    const report = await acme({ style: "scale", defect: "already-running" });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(
      report.checks.find((check) => check.id === "summon.argv.round-trip"),
    ).toMatchObject({
      status: "skip",
      detail:
        "the platform answered already-running and started no unit, so no arguments reached one",
    });
  });

  it("capabilities: the groups a controller would refuse are skipped, not failed", async () => {
    const report = await acme({ defect: "capabilities" });
    for (const check of report.checks.filter((one) =>
      /^summon\.(?:handoff|cas|scale)\./.test(one.id),
    )) {
      expect(check.status, check.id).toBe("skip");
      expect(check.detail).toContain("summon.capabilities.scale-has-release");
    }
  });
});

/**
 * The round trip is what a shared unit needs (summon 0.2): a `must` for a
 * provider declaring 0.2, and a `should` for one written for 0.1, so a
 * provider that conformed before still does (the user's decision, Q1).
 */
describe("the round trip's level follows the declared summon API", () => {
  const notUnderTest = {
    skip: [{ id: "summon.cas.one-call", reason: "not under test" }],
  };
  const roundTrip = (report: ConformanceReport) =>
    report.checks.find((check) => check.id === "summon.argv.round-trip")!;

  it("summon 0.2: a broken round trip is a failed must", async () => {
    const report = await acme(
      { defect: "argv", summonApi: "0.2" },
      notUnderTest,
    );
    expect(roundTrip(report)).toMatchObject({ level: "must", status: "fail" });
    expect(report.ok).toBe(false);
    expect(() => assertConformance(report)).toThrow("summon.argv.round-trip");
  });

  it("summon 0.1: a broken round trip is a should warning, and the report still passes", async () => {
    const report = await acme(
      { defect: "argv", summonApi: "0.1" },
      notUnderTest,
    );
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(roundTrip(report)).toMatchObject({
      level: "should",
      status: "warn",
    });
    expect(roundTrip(report).detail).toContain(
      "(a should for a provider declaring summon 0.1; a must from summon 0.2, and a shared unit needs it)",
    );
    expect(report.ok).toBe(true);
    expect(() => assertConformance(report)).not.toThrow();
  });

  it("summon 0.1: a sound round trip passes, as a should", async () => {
    const report = await acme({ summonApi: "0.1" }, notUnderTest);
    expect(failed(report), report.toMarkdown()).toEqual([]);
    expect(roundTrip(report)).toMatchObject({
      level: "should",
      status: "pass",
    });
  });
});

describe("what a run leaves behind", () => {
  it("scale: the scale-down check starts no worker process, and the run leaves nothing on the backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-kit-scale-"));
    cleanups.push(async () => await rm(dir, { recursive: true, force: true }));
    const config: DriverConfig = { type: "file", root: join(dir, "driver") };
    const report = await acme({ style: "scale" }, { driver: config });
    expect(failed(report), report.toMarkdown()).toEqual([]);
    const internals = fakeInternals(platforms.at(-1)!);
    // Two units handed to a process: the argument round trip's and the
    // handoff's worker. The scale-down check's unit stays a unit on the fake.
    expect(internals.handedOff).toHaveLength(2);
    expect(await leftovers(config, internals.namespaces)).toEqual([]);
  });

  it("gives the global timers back", async () => {
    const before = [
      globalThis.setTimeout,
      globalThis.clearTimeout,
      globalThis.setInterval,
      globalThis.clearInterval,
    ];
    await acme(
      { defect: "timeouts" },
      { skip: [{ id: "summon.cas.one-call", reason: "not under test" }] },
    );
    expect([
      globalThis.setTimeout,
      globalThis.clearTimeout,
      globalThis.setInterval,
      globalThis.clearInterval,
    ]).toEqual(before);
  });

  it("refuses a backend other processes cannot share, before any check runs", async () => {
    const platform = await fake();
    let thrown: unknown;
    try {
      await runProviderConformance(acmeProvider(), {
        config: acmeConfig(platform),
        platform,
        driver: { type: "memory" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain(
      "cannot be shared with another process",
    );
    expect(fakeInternals(platform).requests).toHaveLength(0);
  });
});

describe("the report", () => {
  it("assertConformance throws on a failed must, naming it, and not on a should warning", async () => {
    const platform = await fake();
    // A fact named like a credential: `describe.facts` is a `should`.
    const warned = await runProviderConformance(
      acmeSummoner(platform, { describe: () => ({ apiKeyHint: "none" }) }),
      {
        platform,
        skip: [
          { id: "summon.handoff.started", reason: "not under test" },
          { id: "summon.handoff.released", reason: "not under test" },
          { id: "summon.handoff.drained", reason: "not under test" },
          { id: "summon.handoff.scale-down", reason: "not under test" },
          { id: "summon.cas.one-call", reason: "not under test" },
        ],
      },
    );
    expect(
      warned.checks.find((check) => check.id === "summon.describe.facts"),
    ).toMatchObject({ level: "should", status: "warn" });
    expect(warned.ok).toBe(true);
    expect(() => assertConformance(warned)).not.toThrow();

    const broken = buildReport(
      "x@1.0.0",
      { declared: { core: "0.1" }, host: { core: "0.1", summon: "0.1" } },
      [
        { id: "summon.a.must", level: "must", status: "fail", detail: "no" },
        { id: "summon.b.should", level: "should", status: "warn" },
      ],
    );
    expect(broken.ok).toBe(false);
    let thrown: unknown;
    try {
      assertConformance(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JobsError);
    expect((thrown as JobsError).code).toBe("CONFORMANCE_FAILED");
    expect((thrown as JobsError).message).toContain("summon.a.must");
    expect((thrown as JobsError).context).toEqual({
      failed: ["summon.a.must"],
    });
  });

  it("toMarkdown names every check id, and says it was tested against a fake", async () => {
    const report = await acme(
      {},
      { skip: [{ id: "summon.cas.one-call", reason: "slow in this test" }] },
    );
    const markdown = report.toMarkdown();
    expect(markdown).toContain("Tested against a fake");
    for (const check of report.checks) {
      expect(markdown).toContain(`\`${check.id}\``);
    }
    expect(markdown).toContain("skipped: slow in this test");
    expect(
      report.checks.find((check) => check.id === "summon.cas.one-call"),
    ).toMatchObject({ status: "skip", detail: "skipped: slow in this test" });
  });

  it("reports the checks in a fixed order, with stable ids", async () => {
    const one = await acme(
      {},
      { skip: [{ id: "summon.cas.one-call", reason: "not under test" }] },
    );
    const two = await acme(
      { defect: "purity" },
      { skip: [{ id: "summon.cas.one-call", reason: "not under test" }] },
    );
    expect(two.checks.map((check) => check.id)).toEqual(
      one.checks.map((check) => check.id),
    );
    for (const check of one.checks) {
      expect(check.id).toMatch(/^summon\.[a-z-]+\.[a-z0-9-]+$/);
    }
  });

  it("a provider whose config is refused reports that, and skips everything that needs it", async () => {
    const platform = await fake();
    const report = await runProviderConformance(acmeProvider(), {
      config: { url: platform.url } as never,
      platform,
    });
    expect(failed(report)).toEqual(["summon.config.accepts"]);
    expect(
      report.checks
        .filter(
          (check) =>
            !check.id.startsWith("summon.identity.") &&
            check.id !== "summon.config.accepts",
        )
        .every((check) => check.status === "skip"),
    ).toBe(true);
  });
});

/**
 * The handoff and the race on every backend that carries work between
 * processes (summon-compute §13.10's gate: SQLite, the file driver, Redis
 * and Postgres, and the other servers when their URLs are set).
 */
/**
 * What a kit run left on a backend, by the exact namespaces it recorded
 * (never a prefix: other runs share the backend): each namespace's queues,
 * runners, summon marker and worker records.
 */
async function leftovers(
  config: DriverConfig,
  namespaces: readonly string[],
): Promise<string[]> {
  const driver = createDriver(config);
  await driver.connect();
  try {
    const found: string[] = [];
    for (const ns of namespaces) {
      const ref = { ns, queue: "work" };
      const queues = await driver.listQueues(ns);
      const runners = await driver.listRunners(ns);
      const marker = await driver.getQueueState?.(ref, SUMMON_MARKER);
      const workers = (await driver.listWorkers?.(ref, Date.now())) ?? [];
      if (
        queues.length > 0 ||
        runners.length > 0 ||
        marker != null ||
        workers.length > 0
      ) {
        found.push(
          `${ns}: ${queues.length} queue(s), ${runners.length} runner(s), marker ${marker == null ? "none" : "left"}, ${workers.length} worker record(s)`,
        );
      }
    }
    return found;
  } finally {
    await driver.close();
  }
}

const BACKENDS = await crossProcessBackends({ cleanups });
for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `the handoff and the race: ${backend.name}`,
    () => {
      it("a known-good provider's handoff and compare-and-set pass, and leave nothing behind", async () => {
        const report = await acme({}, { driver: backend.config });
        expect(failed(report), report.toMarkdown()).toEqual([]);
        // Every namespace the run created, by exact name, is gone.
        const { namespaces } = fakeInternals(platforms.at(-1)!);
        expect(namespaces).toHaveLength(1 + 1 + 7 + 2);
        expect(await leftovers(backend.config, namespaces)).toEqual([]);
        for (const id of [
          "summon.handoff.started",
          "summon.handoff.released",
          "summon.handoff.drained",
          "summon.cas.one-call",
        ]) {
          expect(
            report.checks.find((check) => check.id === id)?.status,
            id,
          ).toBe("pass");
        }
      });
    },
  );
}
