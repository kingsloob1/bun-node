// Spike 4: throughput and latency under load, with oha, for the same view on
// bun-common (Bun), Express 5 on Node, and Express 5 on Bun. Interleaved
// rounds, so machine load hits every server alike. A heavy job: run it through
// the heavy-run wrapper, exclusively (HEAVY_MODE=exclusive): it needs a quiet
// machine, and a shared one gave rounds 5x apart.
//
//   NODE_ENV=production bun bench.ts
//
// Env: ROUNDS (4), SECONDS (3), CONNECTIONS (32).
import { loadavg } from "node:os";

const ROUNDS = Number(process.env.ROUNDS ?? 4);
const SECONDS = Number(process.env.SECONDS ?? 3);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 32);
const here = new URL(".", import.meta.url).pathname;

async function start(name: string, cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: here, env: { ...process.env }, stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let out = "";
  while (!/PORT \d+/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${name} exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  return { name, child, base: `http://127.0.0.1:${/PORT (\d+)/.exec(out)![1]}` };
}

const nodeVersion = (await Bun.$`node --version`.text()).trim();
const servers = [
  await start("bun-common on Bun", [process.execPath, "http-serve.ts", "--serve"]),
  await start(`Express 5 on Node ${nodeVersion}`, ["node", "node-express.mjs"]),
  await start("Express 5 on Bun", [process.execPath, "node-express.mjs"]),
];
console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), node ${nodeVersion}, NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}, ${navigator.hardwareConcurrency} cores`);
console.log(`oha -z ${SECONDS}s -c ${CONNECTIONS}, ${ROUNDS} interleaved rounds, load at start ${loadavg().map((n) => n.toFixed(1)).join(" ")}`);

type Row = { rps: number[]; p50: number[]; p99: number[] };
const rows = new Map<string, Row>();
for (let round = 0; round < ROUNDS; round++) {
  for (const path of ["/string", "/engine", "/stream"]) {
    for (const server of servers) {
      // Warm up.
      await Bun.$`oha -z 1s -c ${CONNECTIONS} --no-tui --output-format quiet ${server.base + path}`.quiet();
      const json = JSON.parse(await Bun.$`oha -z ${SECONDS}s -c ${CONNECTIONS} --no-tui --output-format json ${server.base + path}`.text());
      const key = `${server.name} | ${path}`;
      const row = rows.get(key) ?? { rps: [], p50: [], p99: [] };
      row.rps.push(json.summary.requestsPerSec);
      row.p50.push(json.latencyPercentiles.p50 * 1000);
      row.p99.push(json.latencyPercentiles.p99 * 1000);
      rows.set(key, row);
      const codes = Object.keys(json.statusCodeDistribution ?? {}).join(",");
      if (codes !== "200") console.log(`WARNING ${key}: status codes ${codes}`);
    }
  }
}
console.log(`load at end ${loadavg().map((n) => n.toFixed(1)).join(" ")}`);
console.log("\nserver | path | req/s median of rounds (each round) | p50 ms (median) | p99 ms (median)");
const med = (list: number[]) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)]!;
for (const [key, row] of rows) {
  console.log(`${key} | ${med(row.rps).toFixed(0)} (${row.rps.map((n) => n.toFixed(0)).join(", ")}) | ${med(row.p50).toFixed(1)} | ${med(row.p99).toFixed(1)}`);
}
for (const server of servers) server.child.kill("SIGTERM");
await Promise.all(servers.map((s) => s.child.exited));
