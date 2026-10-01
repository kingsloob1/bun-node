import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Finishes at once, and leaves output to arrive *after* it has: a grandchild
 * inheriting the child's stdout pipe waits until the child is gone — exited
 * and reaped by the runner, which is when the runner sees the exit — then
 * writes `lines` 125-byte lines and exits. The run's result and the child's
 * exit are therefore always seen before that output is read: the order in
 * which an output limit used to be crossed silently, the run already a
 * success.
 */
export default defineHandler<{ lines: number }>(async (ctx) => {
  const script = [
    `const parent = ${process.pid};`,
    // Signal 0 succeeds until the parent is reaped (a zombie still answers).
    `for (;;) { try { process.kill(parent, 0); } catch { break; } await Bun.sleep(5); }`,
    `for (let i = 0; i < ${ctx.args.lines}; i++) process.stdout.write(String(i).padStart(6, "0") + " password=hunter2 " + "x".repeat(100) + "\\n");`,
  ].join("\n");
  const grandchild = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "ignore",
  });
  grandchild.unref();
  return "finished early";
});
