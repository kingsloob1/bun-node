/**
 * The cold boot (plan §3.5, PR-S6): `SecurityModule` with a subclass of
 * `SecurityGuard` as `APP_GUARD`, booted in fresh processes, refuses a
 * listed address in the early stage and a listed user in the route stage on
 * every boot. ConcaveHR's subclassed throttler guard failed Nest's injection
 * on the first boot after deploys (write-up §8); `SecurityGuard` declares its
 * dependencies with `@Inject`, so none rest on emitted metadata.
 */
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "bun:test";

const APP = join(import.meta.dir, "fixtures", "security-cold-boot", "app.ts");

/** Boots the fixture in a process of its own, from this package's directory (its tsconfig). */
function coldBoot(): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, APP],
    cwd: join(import.meta.dir, ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const line = /^RESULT=(.*)$/m.exec(output);
  if (!line)
    throw new Error(`the app did not report; output was:\n${output.trim()}`);
  return line[1] ?? "";
}

describe("SecurityModule: a cold boot", () => {
  it("boots with a subclassed guard and refuses in both stages, boot after boot", () => {
    for (let boot = 0; boot < 3; boot++) {
      expect(coldBoot()).toBe("ok 200,403,403");
    }
  }, 60_000);
});
