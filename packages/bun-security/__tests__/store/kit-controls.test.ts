/**
 * Negative controls for the security store kit (storage.md §9): the kit run
 * against a memory store with one fault planted (`fixtures/broken.test.ts`)
 * must fail, in the case that covers the fault. A kit that passed a store
 * losing updates, forking a head, hiding a delete from the feed or taking a
 * cursor for another walk would be decoration.
 */
import process from "node:process";
import { describe, expect, it } from "bun:test";

const FIXTURE = new URL("./fixtures/broken.test.ts", import.meta.url).pathname;

/** Runs the kit against one planted fault; answers its exit code and output. */
async function runBroken(
  fault: string,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", FIXTURE],
    env: { ...process.env, BUN_SECURITY_KIT_BROKEN: fault },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${out}\n${err}` };
}

describe("the kit fails a broken store", () => {
  const cases: [string, string][] = [
    ["lost-update", "two racing writers never both win"],
    ["forked-head", "racing publishers never fork the head"],
    ["silent-delete", "every write, and only writes, in order and complete"],
    ["unbound-cursor", "a cursor is bound to its walk"],
    [
      "untested-multiprocess",
      "two processes racing the same document and head",
    ],
  ];
  for (const [fault, failing] of cases) {
    it(`${fault}: fails "${failing}"`, async () => {
      const { code, output } = await runBroken(fault);
      expect(code).not.toBe(0);
      expect(output).toContain(
        `(fail) security store conformance: broken: ${fault}`,
      );
      expect(output).toContain(failing);
    }, 60_000);
  }

  it("the control's control: an unbroken memory store passes the same file", async () => {
    const { code, output } = await runBroken("none");
    expect({ code, failed: output.includes("(fail)") }).toEqual({
      code: 0,
      failed: false,
    });
  }, 60_000);
});
