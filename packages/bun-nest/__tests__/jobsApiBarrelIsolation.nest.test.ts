/**
 * The barrel must not reach `@kingsleyweb/bun-jobs`.
 *
 * `@kingsleyweb/bun-nest` ships raw `.ts`, so importing the barrel compiles
 * and executes its sources in the consumer. If the barrel re-exported the
 * jobs module, every Nest application without bun-jobs would break — at type
 * level and at import time. The dependency starts at
 * `@kingsleyweb/bun-nest/jobs` and nowhere else.
 *
 * Proved by construction rather than by introspection: this Bun has no
 * `Bun.loadedModules`, and a plugin's `onResolve` observes nothing for a
 * dynamic import, so both would make the test vacuous. Instead the package is
 * copied to a scratch directory whose `node_modules` holds everything the
 * barrel needs and deliberately **not** bun-jobs, and each entry point is
 * imported in its own process. The barrel must load; the jobs subpath must
 * fail naming the missing package — which is what makes the first assertion
 * mean something.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";

/** This package's root. */
const PACKAGE = `${import.meta.dir}/..`;

/** The workspace's installed modules, linked into the isolated copy. */
const INSTALLED = `${PACKAGE}/../../node_modules`;

/** Scratch directories to remove afterwards. */
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A copy of this package outside the workspace, with every dependency the
 * barrel needs linked in — except `@kingsleyweb/bun-jobs`.
 */
async function isolatedCopy(): Promise<string> {
  const root = `${tmpdir()}/bun-nest-isolation-${crypto.randomUUID()}`;
  scratch.push(root);
  const pkg = `${root}/pkg`;
  const modules = `${pkg}/node_modules`;
  await Bun.$`mkdir -p ${modules}/@kingsleyweb ${modules}/@nestjs ${modules}/@routejs`.quiet();
  await Bun.$`cp -r ${PACKAGE}/lib ${pkg}/lib`.quiet();
  await Bun.$`cp ${PACKAGE}/package.json ${pkg}/package.json`.quiet();

  for (const [from, to] of [
    [
      `${INSTALLED}/@kingsleyweb/bun-common`,
      `${modules}/@kingsleyweb/bun-common`,
    ],
    [`${INSTALLED}/@nestjs/common`, `${modules}/@nestjs/common`],
    [`${INSTALLED}/@nestjs/core`, `${modules}/@nestjs/core`],
    [`${INSTALLED}/@nestjs/websockets`, `${modules}/@nestjs/websockets`],
    [`${INSTALLED}/@routejs/router`, `${modules}/@routejs/router`],
    [`${INSTALLED}/rxjs`, `${modules}/rxjs`],
    [`${INSTALLED}/reflect-metadata`, `${modules}/reflect-metadata`],
  ]) {
    await Bun.$`ln -s ${from} ${to}`.quiet().nothrow();
  }
  return pkg;
}

/** Imports one entry point in a fresh process; resolves what happened. */
async function importInIsolation(
  entry: string,
): Promise<{ ok: boolean; message: string }> {
  const probe = `${tmpdir()}/bun-nest-isolation-probe-${crypto.randomUUID()}.ts`;
  await Bun.write(
    probe,
    `try {
  await import(${JSON.stringify(entry)});
  console.log("RESULT=ok");
} catch (error) {
  console.log("RESULT=fail:" + String((error as Error).message));
}
`,
  );
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, probe],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const line = /^RESULT=(ok|fail:.*)$/m.exec(output);
    if (!line) {
      throw new Error(`probe did not report; output was:\n${output.trim()}`);
    }
    return line[1] === "ok"
      ? { ok: true, message: "" }
      : { ok: false, message: line[1]!.slice("fail:".length) };
  } finally {
    await rm(probe, { force: true });
  }
}

describe("barrel isolation", () => {
  it("loads the barrel with bun-jobs absent, and only the subpath needs it", async () => {
    const pkg = await isolatedCopy();

    // The barrel: must load with no bun-jobs anywhere.
    const barrel = await importInIsolation(`${pkg}/lib/index.ts`);
    expect({ entry: "barrel", ...barrel }).toEqual({
      entry: "barrel",
      ok: true,
      message: "",
    });

    // The control: the jobs subpath in the same copy must fail, naming the
    // package it needs. Without this, the assertion above could pass because
    // the copy was broken in some way that hid the dependency.
    const jobs = await importInIsolation(`${pkg}/lib/jobs/index.ts`);
    expect(jobs.ok).toBe(false);
    expect(jobs.message).toContain("@kingsleyweb/bun-jobs");
  }, 30_000);
});
