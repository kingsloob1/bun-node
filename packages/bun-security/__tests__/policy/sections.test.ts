/**
 * The policy's `bans`, `ladder`, `shape` and `deception` sections, and
 * PR-S3's counted-rule fields (`weight`, `action: "ladder"`): what is
 * accepted, what is refused and where, and what they compile to.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  DEFAULT_WEIGHTS,
  SecurityPolicyError,
} from "../../lib/index";
import type { PolicyIssue, SecurityPolicy } from "../../lib/index";
import { policyInternals } from "../../lib/policy/compile";

/** The issues `compilePolicy` refuses `policy` with. */
function issuesOf(policy: unknown): PolicyIssue[] {
  try {
    compilePolicy(policy as SecurityPolicy);
    return [];
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) throw error;
    return [...error.issues];
  }
}

/** The issues' paths, as `a.b.0` text. */
const pathsOf = (policy: unknown) =>
  issuesOf(policy).map((issue) => issue.path.join("."));

const RULE = { id: "r", event: "request", threshold: 1, window: "1m" } as const;

describe("accepted", () => {
  it("every field of every section", () => {
    expect(
      issuesOf({
        bans: {
          code: "go_away",
          retryAfter: true,
          maxActive: 10,
          mode: "dryRun",
        },
        ladder: {
          halfLife: "30m",
          steps: [
            { score: 2.5, action: "challenge", duration: "5m" },
            { score: 8, action: "ban" },
          ],
          base: "10m",
          factor: 1,
          maxBan: "1d",
          memory: "1d",
          weights: { "honeypot.hit": 20, throttled: 0.5 },
          mode: "enforce",
        },
        shape: {
          caseSensitive: true,
          maxPathBytes: 1024,
          maxQueryBytes: 1024,
          maxQueryParams: 10,
          maxQueryDepth: 2,
          methods: ["GET", "POST", "PROPFIND"],
          hosts: ["api.example.com", "127.0.0.1:8080", "[::1]:443"],
          maxHeaders: 50,
          maxHeaderBytes: 4096,
          headerLimits: { cookie: 32768, authorization: 8192 },
          maxBodySize: 1_048_576,
          routes: [
            {
              routes: ["POST /upload"],
              maxBodySize: 10_000_000,
              contentTypes: ["multipart/*", "application/octet-stream"],
            },
            { routes: ["/files/*"], allowEncodedSlash: true },
          ],
          mode: "dryRun",
        },
        deception: {
          honeypots: {
            paths: ["/.git/*", "/phpmyadmin"],
            answer: "not-found",
            mode: "enforce",
          },
          canaries: [
            { id: "backup-key", apiKey: "key_1" },
            { id: "seed-user", user: "u_9" },
          ],
        },
        countedRules: [
          { ...RULE, duration: "1h", weight: 2.5 },
          { ...RULE, id: "l", action: "ladder", weight: 0 },
        ],
      }),
    ).toEqual([]);
    expect(
      issuesOf({ ladder: false, shape: false, deception: { honeypots: true } }),
    ).toEqual([]);
  });
});

describe("refused, each at its path", () => {
  it("bans and ladder", () => {
    expect(
      pathsOf({
        bans: {
          code: "Bad",
          retryAfter: "yes",
          maxActive: 0,
          mode: "x",
          extra: 1,
        },
        ladder: {
          halfLife: 3600,
          steps: [
            { score: 0, action: "ban" },
            { score: 3, action: "drop" },
            { score: 3, action: "ban", duration: "1ms" },
          ],
          factor: 0.5,
          weights: { "bad name": 1, ok: -1 },
        },
      }),
    ).toEqual([
      "bans.extra",
      "bans.code",
      "bans.retryAfter",
      "bans.maxActive",
      "bans.mode",
      "ladder.halfLife",
      "ladder.factor",
      "ladder.steps.0.score",
      "ladder.steps.1.action",
      "ladder.steps.2.score",
      "ladder.steps.2.duration",
      "ladder.weights.bad name",
      "ladder.weights.ok",
    ]);
    expect(pathsOf({ ladder: { steps: [] } })).toEqual(["ladder.steps"]);
  });

  it("shape", () => {
    expect(
      pathsOf({
        shape: {
          caseSensitive: 1,
          maxPathBytes: 0,
          methods: ["get"],
          hosts: ["API.example.com"],
          headerLimits: { Cookie: 1, ok: 0 },
          maxBodySize: -1,
          routes: [
            { maxBodySize: 1 },
            { routes: ["/x"], contentTypes: ["json"], allowEncodedSlash: "no" },
          ],
        },
      }),
    ).toEqual([
      "shape.caseSensitive",
      "shape.maxPathBytes",
      "shape.methods.0",
      "shape.hosts.0",
      "shape.headerLimits.Cookie",
      "shape.headerLimits.ok",
      "shape.maxBodySize",
      "shape.routes.0.routes",
      "shape.routes.1.contentTypes.0",
      "shape.routes.1.allowEncodedSlash",
    ]);
  });

  it("deception", () => {
    expect(
      pathsOf({
        deception: {
          honeypots: { paths: ["no-slash"], answer: "teapot" },
          canaries: [
            { id: "a", user: "u", apiKey: "k" },
            { id: "a" },
            { id: "bad id!", user: "x" },
          ],
          extra: true,
        },
      }),
    ).toEqual([
      "deception.extra",
      "deception.honeypots.paths.0",
      "deception.honeypots.answer",
      "deception.canaries.0",
      "deception.canaries.1.id",
      "deception.canaries.1",
      "deception.canaries.2.id",
    ]);
  });

  it("a counted rule's duration with ladder, its missing duration, a negative weight, and ladder with the ladder off", () => {
    expect(
      pathsOf({
        countedRules: [
          { ...RULE, action: "ladder", duration: "1h" },
          { ...RULE, id: "b" },
          { ...RULE, id: "c", duration: "1h", weight: -1 },
        ],
      }),
    ).toEqual([
      "countedRules.0.duration",
      "countedRules.1.duration",
      "countedRules.2.weight",
    ]);
    expect(
      pathsOf({ ladder: false, countedRules: [{ ...RULE, action: "ladder" }] }),
    ).toEqual(["countedRules.0.action"]);
  });
});

describe("compiled", () => {
  it("the defaults: bans 403 banned with no Retry-After, the ladder of layers.md §0.2, shape on, deception off", () => {
    const internals = policyInternals(compilePolicy({}));
    expect(internals.bans).toEqual({
      code: "banned",
      retryAfter: false,
      maxActive: 100_000,
      mode: "enforce",
    });
    expect(internals.ladder).toMatchObject({
      halfLife: 3_600_000,
      steps: [
        { score: 10, action: "ban", duration: undefined },
        { score: 3, action: "challenge", duration: 900_000 },
      ],
      base: 3_600_000,
      factor: 6,
      maxBan: 30 * 86_400_000,
      memory: 7 * 86_400_000,
      mode: "enforce",
    });
    expect(Object.fromEntries(internals.ladder?.weights ?? [])).toEqual(
      DEFAULT_WEIGHTS,
    );
    expect(internals.shape).toMatchObject({
      caseSensitive: false,
      maxPathBytes: 2048,
      maxQueryBytes: 8192,
      maxQueryParams: 256,
      maxQueryDepth: 5,
      methods: undefined,
      hosts: undefined,
      maxHeaders: 100,
      maxHeaderBytes: 8192,
      maxBodySize: undefined,
      mode: "enforce",
    });
    expect(internals.shape?.headerLimits.get("cookie")).toBe(16_384);
    expect(internals.deception.honeypots).toBeUndefined();
  });

  it("weights merge over the defaults; sections switch off", () => {
    const internals = policyInternals(
      compilePolicy({
        ladder: { weights: { "honeypot.hit": 1, throttled: 2 } },
        shape: { mode: "off" },
      }),
    );
    expect(internals.ladder?.weights.get("honeypot.hit")).toBe(1);
    expect(internals.ladder?.weights.get("throttled")).toBe(2);
    expect(internals.ladder?.weights.get("canary.used")).toBe(100);
    expect(internals.shape).toBeUndefined();
    expect(
      policyInternals(compilePolicy({ ladder: false })).ladder,
    ).toBeUndefined();
    expect(
      policyInternals(compilePolicy({ ladder: { mode: "off" } })).ladder,
    ).toBeUndefined();
  });
});
