import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import {
  AGENT_ENV_KEYS,
  checkBun,
  childEnv,
  compareVersions,
  formatArgs,
  lintArgs,
  MIN_BUN,
  parseVersion,
  runBun,
} from "../src/core/bun";
import { ReportError } from "../src/core/report";
import { lintText } from "../src/core/service";

const scratch = mkdtempSync(join(tmpdir(), "vscode-bun-lint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("childEnv", () => {
  test("drops AGENT, CLAUDECODE and REPL_ID and keeps the rest", () => {
    const env = childEnv({
      AGENT: "1",
      CLAUDECODE: "1",
      REPL_ID: "x",
      PATH: "/bin",
      HOME: "/h",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect([...AGENT_ENV_KEYS].sort()).toEqual([
      "AGENT",
      "CLAUDECODE",
      "REPL_ID",
    ]);
  });

  test("a child started with it does not see them", async () => {
    const result = await runBun(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify([process.env.AGENT, process.env.CLAUDECODE, process.env.REPL_ID, process.env.KEEP]))",
      ],
      {
        cwd: scratch,
        env: childEnv({
          ...process.env,
          AGENT: "1",
          CLAUDECODE: "1",
          REPL_ID: "r",
          KEEP: "k",
        }),
      },
    );
    expect(JSON.parse(result.stdout)).toEqual([null, null, null, "k"]);
  });
});

describe("arguments", () => {
  test("lint: stdin, the absolute file name, JSON, no ignored-file warning", () => {
    expect(lintArgs("/r/a.ts")).toEqual([
      "lint",
      "--stdin",
      "--stdin-filename",
      "/r/a.ts",
      "-f",
      "json",
      "--no-warn-ignored",
      "--no-color",
    ]);
  });

  test("fmt: stdin file path, and the range for Format Selection", () => {
    expect(formatArgs("/r/a.ts")).toEqual([
      "fmt",
      "--stdin-filepath",
      "/r/a.ts",
    ]);
    expect(formatArgs("/r/a.ts", { start: 3, end: 9 })).toEqual([
      "fmt",
      "--stdin-filepath",
      "/r/a.ts",
      "--range-start",
      "3",
      "--range-end",
      "9",
    ]);
  });
});

describe("versions", () => {
  test("parseVersion takes the x.y.z of a version line", () => {
    expect(parseVersion("1.4.4\n")).toBe("1.4.4");
    expect(parseVersion("1.4.4-canary.1+5f5799ed1")).toBe("1.4.4");
    expect(parseVersion("nope")).toBeUndefined();
  });

  test("compareVersions is numeric", () => {
    expect(compareVersions("1.4.3", "1.4.4")).toBeLessThan(0);
    expect(compareVersions("1.4.4", "1.4.4")).toBe(0);
    expect(compareVersions("1.10.0", "1.4.4")).toBeGreaterThan(0);
  });
});

describe("checkBun", () => {
  /**
   * A fake `bun` that prints a version.
   * @param name Its file name.
   * @param version What `--version` prints.
   * @returns Its path.
   */
  function fakeBun(name: string, version: string): string {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("this Bun passes", async () => {
    const result = await checkBun(process.execPath, scratch);
    expect(result).toEqual({ ok: true, version: parseVersion(Bun.version)! });
    expect(compareVersions(Bun.version, MIN_BUN)).toBeGreaterThanOrEqual(0);
  });

  test("Bun 1.4.3 fails, naming the floor and the upgrade", async () => {
    const result = await checkBun(fakeBun("bun-1.4.3", "1.4.3"), scratch);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain('Bun 1.4.3 has no "bun lint"');
    if (!result.ok) expect(result.reason).toContain("bun upgrade --canary");
  });

  test("a missing binary fails, naming the setting", async () => {
    const result = await checkBun(join(scratch, "no-such-bun"), scratch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bunLint.bunPath");
  });

  test("a binary that prints no version fails", async () => {
    const result = await checkBun(fakeBun("bun-garbage", "hello"), scratch);
    expect(result.ok).toBe(false);
  });
});

describe("runBun", () => {
  test("passes standard input and a non-zero exit through", async () => {
    const result = await runBun(
      process.execPath,
      [
        "-e",
        "const t = await Bun.stdin.text(); console.log(t.toUpperCase()); process.exit(3)",
      ],
      { cwd: scratch, input: "abc" },
    );
    expect(result).toEqual({
      code: 3,
      stdout: "ABC\n",
      stderr: "",
      killed: false,
    });
  });

  test("an abort kills the child", async () => {
    const controller = new AbortController();
    const running = runBun(process.execPath, ["-e", "await Bun.sleep(10000)"], {
      cwd: scratch,
      signal: controller.signal,
    });
    controller.abort();
    expect((await running).killed).toBe(true);
  });

  test("a timeout kills the child", async () => {
    const result = await runBun(
      process.execPath,
      ["-e", "await Bun.sleep(10000)"],
      { cwd: scratch, timeoutMs: 100 },
    );
    expect(result.killed).toBe(true);
  });
});

describe("a package whose lint script is not exactly bun lint", () => {
  test("is a ReportError that names the script", async () => {
    const dir = join(scratch, "composite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "composite",
        scripts: { lint: "bun lint && echo done" },
      }),
    );
    const error = await lintText(join(dir, "a.ts"), "export const a = 1;\n", {
      bunPath: process.execPath,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportError);
    expect((error as ReportError).message).toContain('exactly "bun lint"');
  });
});
