import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chromeProfile, sweepStaleProfiles } from "./profile";

/**
 * The e2e suites' Chrome profiles (`./profile`): a run that is killed before
 * its `afterAll` leaves a ~90 MB profile behind, and those filled the tmpfs.
 * Each new profile sweeps the ones whose owning process has exited. These
 * tests run in a root of their own, never the real temp directory.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profile-sweep-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The pid of a process that has run and exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

/** Makes a profile-shaped directory named `name` under the test root. */
function leftover(name: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "Default"), { recursive: true });
  return directory;
}

describe("the e2e Chrome profiles", () => {
  it("names each profile after the process that owns it", async () => {
    const profile = chromeProfile("smoke", root);
    expect(basename(profile.dataStore.directory)).toMatch(
      new RegExp(`^bun-jobs-ui-smoke-p${process.pid}-[^-]+$`),
    );
    await profile.remove();
    expect(readdirSync(root)).toEqual([]);
  });

  it("sweeps a profile whose owning process has exited", async () => {
    const pid = await deadPid();
    leftover(`bun-jobs-ui-m2-flow-p${pid}-abc123`);
    expect(sweepStaleProfiles(root)).toEqual([
      `bun-jobs-ui-m2-flow-p${pid}-abc123`,
    ]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps a profile whose owner is still running, however old", () => {
    const child = Bun.spawn(["sleep", "5"]);
    try {
      const name = `bun-jobs-ui-smoke-p${child.pid}-live01`;
      const directory = leftover(name);
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
      utimesSync(directory, old, old);
      // This process's own profiles are never swept either.
      leftover(`bun-jobs-ui-smoke-p${process.pid}-self01`);
      expect(sweepStaleProfiles(root)).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(
        [name, `bun-jobs-ui-smoke-p${process.pid}-self01`].sort(),
      );
    } finally {
      child.kill();
    }
  });

  it("sweeps an untagged profile only once it is a day old", () => {
    const fresh = "bun-jobs-ui-smoke-Ab12Cd";
    const stale = "bun-jobs-ui-responsive-Ef34Gh";
    leftover(fresh);
    const directory = leftover(stale);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(directory, old, old);
    expect(sweepStaleProfiles(root)).toEqual([stale]);
    expect(readdirSync(root)).toEqual([fresh]);
  });

  it("leaves everything that is not an e2e profile alone, an example's old temp root included", async () => {
    const pid = await deadPid();
    const other = `consumer-check-p${pid}-abc123`;
    leftover(other);
    // An example's file-driver root shares the prefix but is not a profile.
    const example = "bun-jobs-ui-example-workers-Xy12Zw";
    const directory = leftover(example);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    utimesSync(directory, old, old);
    expect(sweepStaleProfiles(root)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual([example, other].sort());
  });

  it("sweeps before it makes a new profile", async () => {
    const pid = await deadPid();
    leftover(`bun-jobs-ui-smoke-p${pid}-old999`);
    const profile = chromeProfile("smoke", root);
    expect(readdirSync(root)).toEqual([basename(profile.dataStore.directory)]);
    await profile.remove();
  });
});
