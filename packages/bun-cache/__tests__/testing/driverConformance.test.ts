/**
 * The driver conformance kit's bus cases, run on the memory driver in a child
 * `bun test` (`fixtures/driver-conformance-fixture.ts`) so their verdicts can
 * be asserted from outside, in a fixed order:
 *
 * - a message of another case's, delivered right after the bus case
 *   subscribes, is not counted as the case's own (Redis delivered the
 *   raw-dump case's last `clear` there, and the case waited for exactly one
 *   message until bun:test timed it out, under `--randomize --seed=4`);
 * - a bus that never delivers, or never signals a gap, fails its case inside
 *   the case's bound, with the kit's message, and leaves no unhandled error
 *   between tests (the kit's wait and bun:test's default timeout were both
 *   5 s, and the timeout won).
 */
import process from "node:process";
import { describe, expect, test } from "bun:test";

/** Runs the fixture under `kind` in a child `bun test`, its cases filtered by `filter`; answers its exit code and output. */
async function runFixture(
  kind: string,
  filter: string,
): Promise<{ code: number; output: string }> {
  const fixture = new URL(
    "./fixtures/driver-conformance-fixture.ts",
    import.meta.url,
  ).pathname;
  // An agent's environment (AGENT, CLAUDECODE, REPL_ID) switches bun:test's
  // output to another format, which hides the pass lines.
  const env: Record<string, string | undefined> = {
    ...process.env,
    BUN_CACHE_DRIVER_FIXTURE: kind,
  };
  for (const name of ["AGENT", "CLAUDECODE", "REPL_ID"]) {
    delete env[name];
  }
  const child = Bun.spawn([process.execPath, "test", fixture, "-t", filter], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

const BUS_CASE = "a published message reaches a subscriber";
const GAP_CASE = "a gap in the bus is signalled to subscribers";

describe("the kit's bus cases", () => {
  test("a message of another namespace, delivered right after the subscribe, is not the case's own", async () => {
    const { code, output } = await runFixture("stray-message", BUS_CASE);
    expect(output).toContain(
      `(pass) runCacheDriverConformance: stray message > ${BUS_CASE}`,
    );
    expect(output).toMatch(/\b1 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
    expect(code).toBe(0);
  }, 30_000);

  test("a bus that never delivers, or never signals a gap, fails each case inside its bound, with the kit's message and no unhandled error", async () => {
    const { code, output } = await runFixture(
      "deaf-bus",
      `${BUS_CASE}|${GAP_CASE}`,
    );
    expect(code).not.toBe(0);
    expect(output).toContain(
      `(fail) runCacheDriverConformance: deaf bus > ${BUS_CASE}`,
    );
    expect(output).toContain(
      `(fail) runCacheDriverConformance: deaf bus > ${GAP_CASE}`,
    );
    expect(output).toContain("Timed out waiting for: the published message");
    expect(output).toContain("Timed out waiting for: the gap to be signalled");
    expect(output).not.toContain("timed out after");
    expect(output).not.toContain("Unhandled error");
    expect(output).toMatch(/\b2 fail\b/);
  }, 30_000);
});
