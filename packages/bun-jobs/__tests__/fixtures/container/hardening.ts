import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/** What one attempt at something the container should refuse did. */
function attempt(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/**
 * Reports what the container lets a job do — the basics of the fixed
 * hardening, not the full hostile-job conformance (that is the plan's PR-i3):
 * its uid, its capabilities and no-new-privileges, whether it can write the
 * root filesystem or `/tmp`, and whether it can reach the network.
 */
export default async () => {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(status)?.[1] ?? null;
  let network = "reached";
  try {
    await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    network =
      (error as { code?: string; name?: string }).code ?? (error as Error).name;
  }
  return {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    capEff: field("CapEff"),
    noNewPrivs: field("NoNewPrivs"),
    writeRoot: attempt(() => writeFileSync("/i1-probe", "x")),
    writeTmp: attempt(() => writeFileSync("/tmp/i1-probe", "x")),
    network,
  };
};
