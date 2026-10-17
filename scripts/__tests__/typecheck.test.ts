import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { classify, IGNORED, PROJECTS, rebase } from "../typecheck";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/typecheck.ts");

/** Runs the script as a CLI from the repo root. */
function cli(...args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const scratch = mkdtempSync(join(tmpdir(), "typecheck-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A one-file project with no `@types`, so it checks in milliseconds. */
function project(name: string, source: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        lib: ["ESNext"],
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  writeFileSync(join(dir, "index.ts"), source);
  return join(dir, "tsconfig.json");
}

describe("the project list", () => {
  it("names only tsconfigs that exist", () => {
    for (const path of PROJECTS)
      expect(existsSync(join(ROOT, path))).toBe(true);
  });

  it("is what --list prints", () => {
    const { code, out } = cli("--list");
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toEqual([...PROJECTS]);
  });
});

describe("classify", () => {
  const error =
    "a.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.";

  it("fails on an error line", () => {
    expect(classify(`${error}\nFound 1 error in 1 file`, 1)).toEqual({
      problems: [error],
      failed: true,
    });
  });

  it("passes a run whose only errors are the known noise", () => {
    const noise =
      "eslint.legacy.config.mjs(1,1): error TS2742: The inferred type of 'default' cannot be named.";
    expect(IGNORED.test(noise)).toBe(true);
    expect(classify(`${noise}\nFound 1 error in 1 file`, 1)).toEqual({
      problems: [],
      failed: false,
    });
  });

  it("fails a non-zero exit that reported no errors: the check never ran", () => {
    expect(classify("error: tsconfig.json not found", 1)).toEqual({
      problems: ["error: tsconfig.json not found"],
      failed: true,
    });
    expect(classify("", 3).failed).toBe(true);
  });

  it("passes a clean run", () => {
    expect(classify("✓ No type errors in 3 files [10ms]", 0)).toEqual({
      problems: [],
      failed: false,
    });
  });
});

describe("rebase", () => {
  it("names a file relative to the base rather than the project", () => {
    const line =
      "../../packages/bun-jobs/lib/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(rebase(line, "/repo/examples/bun-jobs", "/repo")).toBe(
      "packages/bun-jobs/lib/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  it("leaves a built-in lib path and every other line alone", () => {
    const text = [
      "bundled:///libs/lib.dom.d.ts(1,1): error TS2300: Duplicate identifier 'x'.",
      "Found 1 error in 1 file, checked 2 files [10ms]",
    ].join("\n");
    expect(rebase(text, "/repo/scripts", "/repo")).toBe(text);
  });
});

describe("the script, end to end", () => {
  it("fails a project with a deliberate type error, and names it", () => {
    const broken = project("broken", `export const n: number = "nope";\n`);
    const { code, out } = cli(broken);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  ${broken}`);
    expect(out).toMatch(/index\.ts\(1,14\): error TS2322/);
    expect(out).toContain("1 of 1 projects have type errors.");
  });

  it("passes the same project once the error is fixed", () => {
    const fixed = project("fixed", `export const n: number = 1;\n`);
    const { code, out } = cli(fixed);
    expect(code).toBe(0);
    expect(out).toContain(`ok    ${fixed}`);
    expect(out).toContain("1 projects, no type errors.");
  });

  it("checks the project even where a package.json has a check script", () => {
    // `bun check` would run that script instead: the root's `check` is this
    // very file. The type error must be found, and the script never run.
    const hijack = project("hijack", `export const n: number = "nope";\n`);
    writeFileSync(
      join(scratch, "hijack/package.json"),
      JSON.stringify({ scripts: { check: "echo HIJACKED" } }),
    );
    const { code, out } = cli(hijack);
    expect(out).not.toContain("HIJACKED");
    expect(out).toMatch(/index\.ts\(1,14\): error TS2322/);
    expect(code).toBe(1);
  });

  it("takes a project's directory as well as its tsconfig.json", () => {
    const broken = project("by-dir", `export const n: number = "nope";\n`);
    const { code, out } = cli(join(scratch, "by-dir"));
    expect(out).toMatch(/index\.ts\(1,14\): error TS2322/);
    expect(code).toBe(1);
    expect(existsSync(broken)).toBe(true);
  });

  it("fails a project that does not exist instead of reporting it clean", () => {
    const { code, out } = cli(join(scratch, "missing/tsconfig.json"));
    expect(code).toBe(1);
    expect(out).toContain("1 of 1 projects have type errors.");
  });

  it("checks this directory's own project clean", () => {
    const { code, out } = cli("scripts/tsconfig.json");
    expect(out).toContain("1 projects, no type errors.");
    expect(code).toBe(0);
  });
});
