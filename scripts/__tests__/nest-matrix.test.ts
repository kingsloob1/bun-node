import type { CheckResult, Manifest } from "../nest-matrix";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  baseDir,
  checkerEnv,
  checkPlans,
  consumerWorkDir,
  dotSegments,
  exitStatus,
  findInstalledCopies,
  findNestManifests,
  formatCheck,
  formatSummary,
  judgeBunTest,
  judgeCheck,
  judgeRunAll,
  main,
  matrixDir,
  NEST_PACKAGE_OVERRIDES,
  parseArgs,
  parseBunTest,
  parseCheck,
  parseRunAll,
  pinConsumerCheck,
  REPO_ROOT,
  rewriteManifest,
  rsyncCommand,
  summariseConsumer,
  widenRange,
} from "../nest-matrix";

const scratch = mkdtempSync(join(tmpdir(), "nest-matrix-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes `files` (relative path → content) under a new directory in the scratch. */
function tree(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The plan's measured runs, kept as evidence: real Bun output to parse. */
const RUNS = join(REPO_ROOT, "docs/plans/nestjs-12-parity/evidence/runs");

describe("parseArgs", () => {
  const ok = (argv: string[]) => {
    const r = parseArgs(argv);
    if (!r.ok) throw new Error(r.error);
    return r.args;
  };
  const error = (argv: string[]) => {
    const r = parseArgs(argv);
    if (r.ok) throw new Error(`accepted ${argv.join(" ")}`);
    return r.error;
  };

  it("takes the versions after --prepare and --run, until the next option", () => {
    const args = ok([
      "--prepare",
      "12.1.3",
      "11.2.7",
      "--run",
      "11.2.7",
      "--fresh",
    ]);
    expect(args.prepare).toEqual(["12.1.3", "11.2.7"]);
    expect(args.run).toEqual(["11.2.7"]);
    expect(args.fresh).toBe(true);
    expect(args.only).toEqual(["suite", "check", "examples", "ui", "consumer"]);
  });

  it("accepts --opt=value spellings", () => {
    const args = ok(["--run=12.0.0", "--dir=/srv/m", "--only=suite,check"]);
    expect(args.run).toEqual(["12.0.0"]);
    expect(args.dir).toBe("/srv/m");
    expect(args.only).toEqual(["suite", "check"]);
  });

  it("refuses a range, a tag, a stray version and unknown options", () => {
    expect(error(["--prepare", "^12.0.0"])).toContain("exact version");
    expect(error(["--prepare", "latest"])).toContain("exact version");
    expect(error(["--prepare=^12.0.0"])).toContain("exact version");
    expect(error(["12.1.3"])).toContain("must follow --prepare or --run");
    expect(error(["--dir", "/x", "12.1.3"])).toContain("must follow");
    expect(error(["--run", "12.1.3", "--bogus"])).toContain(
      "unknown option --bogus",
    );
    expect(error(["--only", "suite,lint", "--run", "1.0.0"])).toContain(
      "--only takes",
    );
  });

  it("refuses a flag with no versions, and an empty command line", () => {
    expect(error(["--prepare", "--run", "12.1.3"])).toContain(
      "--prepare needs at least one version",
    );
    expect(error([])).toContain("nothing to do");
    expect(error(["--dry-run"])).toContain("nothing to do");
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["--list"]).list).toBe(true);
  });
});

describe("the copy's path", () => {
  it("defaults to $HOME/bun-node-nest-matrix, and --dir beats NEST_MATRIX_DIR", () => {
    expect(baseDir(undefined, {}, "/home/u")).toBe(
      "/home/u/bun-node-nest-matrix",
    );
    expect(baseDir(undefined, { NEST_MATRIX_DIR: "/srv/env" }, "/home/u")).toBe(
      "/srv/env",
    );
    expect(
      baseDir("/srv/flag", { NEST_MATRIX_DIR: "/srv/env" }, "/home/u"),
    ).toBe("/srv/flag");
  });

  it("finds dot segments, and a version's dots are not one", () => {
    expect(dotSegments("/home/u/.cache/bun-node-nest-matrix/12.1.3")).toEqual([
      ".cache",
    ]);
    expect(dotSegments("/home/u/bun-node-nest-matrix/12.1.3")).toEqual([]);
    expect(dotSegments("/a/.b/c/.d")).toEqual([".b", ".d"]);
  });

  it("refuses a base with a dot segment, naming why", () => {
    expect(() =>
      matrixDir("/home/u/.cache/bun-node-nest-matrix", "12.1.3"),
    ).toThrow(/dot segment\(s\) \.cache.*res\.sendFile/);
    expect(matrixDir("/home/u/bun-node-nest-matrix", "12.1.3")).toBe(
      "/home/u/bun-node-nest-matrix/12.1.3",
    );
    expect(() => matrixDir("/srv", "../12.1.3")).toThrow(/exact version/);
  });

  it("main exits 2 on a dot base before touching anything", () => {
    const base = join(scratch, ".hidden");
    expect(main(["--prepare", "12.1.3", "--dir", base])).toBe(2);
    expect(() =>
      readFileSync(join(base, "12.1.3", "nest-matrix.json")),
    ).toThrow();
  });

  it("puts consumer-check's work beside the copy, never inside it", () => {
    const dir = "/home/u/bun-node-nest-matrix/12.1.3";
    expect(consumerWorkDir(dir)).toBe("/home/u/bun-node-nest-matrix/cc-12.1.3");
    expect(consumerWorkDir(dir).startsWith(`${dir}${sep}`)).toBe(false);
  });

  it("copies without node_modules, .git, dts or dist, and protects the marker", () => {
    const cmd = rsyncCommand("/src", "/dest");
    for (const e of [
      "node_modules",
      ".git",
      "dts",
      "dist",
      "/nest-matrix.json",
    ])
      expect(cmd).toContain(`--exclude=${e}`);
    expect(cmd.slice(-2)).toEqual(["/src/", "/dest/"]);
  });
});

describe("rewriteManifest", () => {
  const bunNest: Manifest = {
    name: "@kingsleyweb/bun-nest",
    peerDependencies: {
      "@nestjs/common": "^11.0.0",
      "@nestjs/core": "^11.0.0",
      "@nestjs/websockets": "^11.0.0",
      rxjs: "^7.1.0",
    },
    devDependencies: {
      "@nestjs/common": "^11.1.27",
      "@nestjs/core": "^11.1.27",
      "@nestjs/platform-express": "^11.1.27",
      "@nestjs/websockets": "^11.1.21",
      rxjs: "^7.8.1",
    },
    gitHead: "abc",
  };

  it("pins every @nestjs/* dependency exactly and widens the peers", () => {
    const { manifest, changes } = rewriteManifest(bunNest, "12.1.3", {
      widenPeers: true,
    });
    expect(manifest.devDependencies).toEqual({
      "@nestjs/common": "12.1.3",
      "@nestjs/core": "12.1.3",
      "@nestjs/platform-express": "12.1.3",
      "@nestjs/websockets": "12.1.3",
      rxjs: "^7.8.1",
    });
    expect(manifest.peerDependencies!["@nestjs/core"]).toBe(
      "^11.0.0 || ^12.0.0",
    );
    expect(manifest.peerDependencies!.rxjs).toBe("^7.1.0");
    expect(manifest.gitHead).toBe("abc");
    expect(changes).toContain(
      "devDependencies @nestjs/core: ^11.1.27 -> 12.1.3",
    );
    expect(changes).toContain(
      "peerDependencies @nestjs/core: ^11.0.0 -> ^11.0.0 || ^12.0.0",
    );
    expect(changes).toHaveLength(7);
    // The input is untouched, and a second pass changes nothing.
    expect(bunNest.devDependencies!["@nestjs/core"]).toBe("^11.1.27");
    expect(
      rewriteManifest(manifest, "12.1.3", { widenPeers: true }).changes,
    ).toEqual([]);
  });

  it("leaves peers alone unless asked, and when they already admit the version", () => {
    expect(
      rewriteManifest(bunNest, "12.1.3").manifest.peerDependencies,
    ).toEqual(bunNest.peerDependencies);
    const { changes } = rewriteManifest(bunNest, "11.2.7", {
      widenPeers: true,
    });
    expect(changes.filter((c) => c.startsWith("peer"))).toEqual([]);
  });

  it("widens a range only as far as it must", () => {
    expect(widenRange("^11.0.0", "12.1.3")).toBe("^11.0.0 || ^12.0.0");
    expect(widenRange("^11.1.20 || ^12.0.0", "12.0.0")).toBe(
      "^11.1.20 || ^12.0.0",
    );
    expect(widenRange("^11.1.20", "11.0.0")).toBe("^11.1.20 || ^11.0.0");
    const pre = widenRange("^12.0.0", "13.0.0-rc.1");
    expect(Bun.semver.satisfies("13.0.0-rc.1", pre)).toBe(true);
  });

  it("finds the manifests that name Nest, skipping node_modules, dot directories and docs/", () => {
    const nest = JSON.stringify({
      devDependencies: { "@nestjs/core": "^11.1.27" },
    });
    const root = tree("manifests", {
      "package.json": JSON.stringify({ devDependencies: { eslint: "^10" } }),
      "packages/a/package.json": nest,
      "packages/b/package.json": JSON.stringify({
        dependencies: { "@nestjs/common": "^11" },
      }),
      "packages/c/package.json": JSON.stringify({
        peerDependencies: { "@nestjs/core": "^11" },
      }),
      "node_modules/x/package.json": nest,
      "packages/a/node_modules/y/package.json": nest,
      ".hidden/package.json": nest,
      "docs/fixture/package.json": nest,
    });
    expect(findNestManifests(root)).toEqual([
      "packages/a/package.json",
      "packages/b/package.json",
    ]);
  });

  it("pins the consumer-check consumer to the column's Nest", () => {
    const config = pinConsumerCheck(
      { entries: [], consumerDependencies: ["zod@4", "@nestjs/core@11.0.0"] },
      "11.2.7",
    );
    expect(config.consumerDependencies).toEqual([
      "zod@4",
      "@nestjs/common@11.2.7",
      "@nestjs/core@11.2.7",
      "@nestjs/websockets@11.2.7",
    ]);
    expect(config.entries).toEqual([]);
  });

  it("consults NEST_PACKAGE_OVERRIDES before the blanket @nestjs/* pin", () => {
    // @nestjs/swagger's line is not Nest's (api-docs-generation phase d):
    // an 11 column pins swagger 11.4.6, a 12 column 12.0.4, never the
    // column's own version.
    const withSwagger: Manifest = {
      name: "x",
      devDependencies: {
        "@nestjs/common": "^12.2.0",
        "@nestjs/swagger": "12.0.4",
        zod: "^4",
      },
    };
    const eleven = rewriteManifest(withSwagger, "11.2.7");
    expect(eleven.manifest.devDependencies).toEqual({
      "@nestjs/common": "11.2.7",
      "@nestjs/swagger": "11.4.6",
      zod: "^4",
    });
    expect(eleven.changes).toContain(
      "devDependencies @nestjs/swagger: 12.0.4 -> 11.4.6",
    );
    // A 12 column pins 12.0.4 — already the manifest's range, so no change.
    const twelve = rewriteManifest(withSwagger, "12.0.0");
    expect(twelve.manifest.devDependencies!["@nestjs/swagger"]).toBe("12.0.4");
    expect(twelve.changes.filter((c) => c.includes("swagger"))).toEqual([]);
    expect(twelve.manifest.devDependencies!["@nestjs/common"]).toBe("12.0.0");
    // A major nobody named falls back to the blanket pin.
    expect(
      rewriteManifest(withSwagger, "13.1.0").manifest.devDependencies![
        "@nestjs/swagger"
      ],
    ).toBe("13.1.0");
    expect(NEST_PACKAGE_OVERRIDES["@nestjs/swagger"]!("11.1.20")).toBe(
      "11.4.6",
    );
  });
});

describe("installed copies", () => {
  it("counts every real @nestjs/core under any node_modules, not symlinks", () => {
    const pkg = (v: string) =>
      JSON.stringify({ name: "@nestjs/core", version: v });
    const root = tree("copies", {
      "node_modules/@nestjs/core/package.json": pkg("12.1.3"),
      "packages/bun-nest/node_modules/@nestjs/core/package.json": pkg("11.1.6"),
      "node_modules/other/node_modules/@nestjs/core/package.json":
        pkg("11.1.27"),
    });
    expect(findInstalledCopies(root, "@nestjs/core")).toEqual([
      "node_modules/@nestjs/core@12.1.3",
      "node_modules/other/node_modules/@nestjs/core@11.1.27",
      "packages/bun-nest/node_modules/@nestjs/core@11.1.6",
    ]);
  });
});

describe("output parsing", () => {
  it("reads the plan's Nest 12 suite run: 420 pass, 7 fail, 427 tests in 30 files", () => {
    const s = parseBunTest(
      readFileSync(join(RUNS, "bun-nest-suite.nest12.run1.log"), "utf8"),
    )!;
    expect(s).toMatchObject({
      pass: 420,
      fail: 7,
      skip: 0,
      tests: 427,
      files: 30,
    });
    expect(s.failures).toHaveLength(7);
    expect(s.failures).toContain(
      "bun-nest vs platform-express: compat > GET /res-sendfile — res.sendFile(abs)",
    );
  });

  it("reads the plan's Nest 12 examples run: 15 of 20, five named", () => {
    const s = parseRunAll(
      readFileSync(join(RUNS, "examples-bun-nest.nest12.log"), "utf8"),
    )!;
    expect(s).toMatchObject({ total: 20, passed: 15, skipped: 0, failed: 5 });
    expect(s.failures).toEqual([
      "02-http-adapter/undecodable-bodies.ts",
      "02-http-adapter/express-parity.ts",
      "10-options/jobs-api-module-options.ts",
      "10-options/websocket-adapter-options.ts",
      "04-websockets/message-formats.ts",
    ]);
  });

  it("reads bun --check, clean and with errors", () => {
    expect(parseCheck("✓ No type errors in 255 files [1.72s]\n")).toEqual({
      errors: 0,
      files: 255,
      sample: [],
    });
    const bad = parseCheck(
      "lib/a.ts(3,1): error TS2322: no\nlib/b.ts(4,1): error TS2339: no\n",
    );
    expect(bad.errors).toBe(2);
    expect(bad.sample[0]).toContain("TS2322");
  });

  it("strips colour codes before reading", () => {
    expect(
      parseBunTest(
        "\x1B[32m 2 pass\x1B[0m\n 0 fail\nRan 2 tests across 1 file. [5ms]",
      ),
    ).toMatchObject({
      pass: 2,
      fail: 0,
      tests: 2,
      files: 1,
    });
  });

  it("answers null with no summary", () => {
    expect(parseBunTest("Segmentation fault")).toBeNull();
    expect(parseRunAll("boom")).toBeNull();
  });

  it("counts a consumer-check result", () => {
    const s = summariseConsumer({
      typescript: "6.0.3",
      cells: [
        { key: "a [bundler/slc]", status: "OK" },
        { key: "a [node16/strict]", status: "BROKEN" },
      ],
      runtime: { a: "ok", b: "Cannot find module" },
      leaks: [],
    });
    expect(s).toMatchObject({
      ok: 1,
      cells: 2,
      runtimeOk: 1,
      runtime: 2,
      leaks: 0,
    });
    expect(s.failures).toEqual([
      "a [node16/strict]: BROKEN",
      "b runtime: Cannot find module",
    ]);
  });
});

describe("verdicts", () => {
  const summary = (pass: number, fail: number) =>
    ` ${pass} pass\n ${fail} fail\nRan ${pass + fail} tests across 3 files. [1s]\n`;

  it("passes a green bun test and fails a red one", () => {
    expect(judgeBunTest(0, summary(5, 0))).toEqual({
      ok: true,
      detail: "5 pass, 0 fail, 0 skip; 5 tests in 3 files",
      problems: [],
    });
    expect(
      judgeBunTest(1, `(fail) a > b [1.00ms]\n${summary(4, 1)}`),
    ).toMatchObject({
      ok: false,
      problems: ["a > b"],
    });
  });

  it("fails a run that exits 0 but proves nothing", () => {
    expect(judgeBunTest(0, "no summary at all").ok).toBe(false);
    expect(
      judgeBunTest(0, " 0 pass\n 0 fail\nRan 0 tests across 0 files. [1ms]").ok,
    ).toBe(false);
    expect(judgeRunAll(0, "0 examples: 0 passed, 0 skipped, 0 failed").ok).toBe(
      false,
    );
    expect(judgeRunAll(0, "").ok).toBe(false);
  });

  it("fails a non-zero exit even when the summary is green", () => {
    expect(judgeBunTest(1, summary(5, 0)).ok).toBe(false);
    expect(
      judgeRunAll(1, "20 examples: 20 passed, 0 skipped, 0 failed").ok,
    ).toBe(false);
    expect(judgeCheck(1, "✓ No type errors in 3 files").ok).toBe(false);
  });

  it("judges bun --check by its errors", () => {
    expect(judgeCheck(0, "✓ No type errors in 255 files")).toEqual({
      ok: true,
      detail: "0 type errors in 255 files",
      problems: [],
    });
    expect(judgeCheck(1, "a.ts(1,1): error TS2345: x").detail).toBe(
      "1 type errors",
    );
  });
});

describe("output and exit status", () => {
  const r = (version: string, label: string, ok: boolean): CheckResult => ({
    version,
    label,
    ok,
    detail: ok ? "1 pass" : "1 fail",
    problems: ok ? [] : ["x > y"],
    ms: 12_300,
    log: "/c/matrix-logs/suite.log",
  });

  it("prints one line per check, with its problems and log on failure", () => {
    expect(formatCheck(r("12.1.3", "bun-nest suite", true))).toBe(
      `  ok    12.1.3   ${"bun-nest suite".padEnd(24)} 1 pass  (12.3s)`,
    );
    const failed = formatCheck(r("12.1.3", "bun-nest suite", false)).split(
      "\n",
    );
    expect(failed[0]).toStartWith("  FAIL  12.1.3");
    expect(failed.slice(1)).toEqual([
      "          x > y",
      "          full output: /c/matrix-logs/suite.log",
    ]);
  });

  it("summarises per version and answers the exit status", () => {
    const results = [
      r("12.1.3", "suite", false),
      r("12.1.3", "check", true),
      r("11.2.7", "suite", true),
    ];
    const text = formatSummary(results);
    expect(text).toContain("12.1.3   1 of 2 checks passed; FAIL: suite");
    expect(text).toContain("11.2.7   1 of 1 checks passed");
    expect(text).toContain("2 version(s), 2 of 3 checks passed -> exit 1");
    expect(exitStatus(results)).toBe(1);
    expect(exitStatus(results.filter((x) => x.ok))).toBe(0);
    expect(exitStatus([])).toBe(1);
  });
});

describe("the checks", () => {
  const dir = "/home/u/bun-node-nest-matrix/12.1.3";
  const plans = checkPlans(dir, undefined, "bun");

  it("runs the five checks of plan §9.3, in order", () => {
    expect(plans.map((p) => [p.cwd, p.cmd.join(" ")])).toEqual([
      ["packages/bun-nest", "bun run test"],
      ["packages/bun-nest", "bun --check"],
      ["examples/bun-nest", "bun run-all.ts"],
      [
        "packages/bun-jobs-ui",
        "bun test --check ./__tests__/server/nest.nest.test.ts",
      ],
      [
        ".",
        `bun scripts/consumer-check.ts packages/bun-nest --work /home/u/bun-node-nest-matrix/cc-12.1.3 --save ${dir}/matrix-logs/consumer-check.json`,
      ],
    ]);
    expect(checkPlans(dir, ["check"], "bun").map((p) => p.name)).toEqual([
      "check",
    ]);
  });

  it("runs the bare checker without the agent variables, and only it", () => {
    expect(plans.filter((p) => p.checkerEnv).map((p) => p.name)).toEqual([
      "check",
    ]);
    const env = checkerEnv({
      AGENT: "1",
      CLAUDECODE: "1",
      REPL_ID: "x",
      PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
