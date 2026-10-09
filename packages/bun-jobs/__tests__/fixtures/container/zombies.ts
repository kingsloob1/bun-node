import { readdirSync, readFileSync } from "node:fs";

/**
 * Starts shells that each leave a short-lived background process behind,
 * orphaned to PID 1, then counts the zombies left in the container once
 * those have exited: none when PID 1 reaps orphans (an init), some when it
 * does not (Bun as PID 1).
 */
export default async () => {
  for (let i = 0; i < 10; i++) {
    await Bun.spawn(["sh", "-c", "sleep 0.1 & exit 0"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  }
  await Bun.sleep(1000);
  let zombies = 0;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) {
        zombies++;
      }
    } catch {
      // Gone already.
    }
  }
  return zombies;
};
