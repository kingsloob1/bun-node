// The cost model behind the plan's §5: requests per job for each design, times
// each store's request prices (read 2026-10-10, sources in the plan's §3.5),
// plus the steady cost of an idle worker on design (a). Pure arithmetic: no
// requests are sent. Request counts per job come from claim-proto.ts (measured)
// plus the index and wake writes the sketch in §4.1 adds (counted, not measured).
// Run: bun cost-model.ts
type Prices = { name: string; write: number; read: number; note: string }; // $ per request
const stores: Prices[] = [
  { name: "S3 Standard (us-east-1)", write: 0.005 / 1000, read: 0.0004 / 1000, note: "PUT/COPY/POST/LIST tier 1; GET/HEAD tier 2; DELETE free" },
  { name: "S3 Express One Zone", write: 0.00113 / 1000, read: 0.00003 / 1000, note: "plus $0.0032/GB upload, $0.0006/GB retrieval" },
  { name: "Cloudflare R2", write: 4.5 / 1e6, read: 0.36 / 1e6, note: "LIST is Class A; DELETE free; 1 write/s per key" },
  { name: "Backblaze B2", write: 0, read: 0, note: "API classes A-C free; rejects If-None-Match (2025-07)" },
];
type Mix = { write: number; read: number; free: number };
const designs: Record<string, Mix> = {
  // (a) enqueue: job create-once, waiting marker, wake = 3 writes.
  //     claim: LIST 1.0-1.5 (1.5 at 16 workers) + claim create-once + GET record + CAS record + active marker PUT; DELETE waiting marker (free).
  //     settle: CAS record + completed marker; DELETE active marker. Retention: 3 DELETEs. Short job: no heartbeat.
  //     + 1 GET of the pause flag per claim (claimJob must return null while paused, driver.ts:1993-1996;
  //       counted per claim, the worst case: the driver's PauseCache (250 ms) absorbs it under load).
  "(a) full driver, short job, no events": { write: 3 + (1.5 + 1 + 1 + 1) + 2, read: 1 + 1, free: 1 + 1 + 3 },
  "(a) + events on (3 event objects) + 1 heartbeat": { write: 3 + 4.5 + 2 + 3 + 1, read: 1 + 1 + 1 + 3, free: 5 },
  // (b) data over the threshold: PUT blob on add, GET on claim, DELETE on retention; result offload doubles it.
  "(b) blob store, data offloaded": { write: 1, read: 1, free: 1 },
  // (result offload was withdrawn in the plan's second revision: job.returnValue is synchronous)
  // (c) archive: one PUT per batch of 1000 jobs; reads only when someone looks.
  "(c) archive, batches of 1000": { write: 1 / 1000, read: 0, free: 0 },
};
const usd = (n: number) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
console.log("## Cost per 1,000,000 jobs (requests only)\n");
console.log(`| Design | writes / reads per job | ${stores.map(s => s.name).join(" | ")} |`);
console.log(`|---|---|${stores.map(() => "---|").join("")}`);
for (const [d, m] of Object.entries(designs))
  console.log(`| ${d} | ${+m.write.toFixed(3)} / ${m.read} | ${stores.map(s => usd(1e6 * (m.write * s.write + m.read * s.read))).join(" | ")} |`);

// Idle worker on design (a), defaults from the bun-jobs survey (file:line in the plan's §5.2):
//  - wait: HEAD of the wake object, rate measured by pickup-poll.ts (corrected run: loop HEADs only)
//  - promoteDelayed 1/s per worker = 2 LIST/s (delayed and failed indexes), BunQueueWorker.ts:404-405
//  - claim attempt before each wait: 1 LIST per pollInterval (1 s) -> counted with the wait at 1 LIST/s
//  - pause check: GET at most 1/s (worker cache 1 s)
//  - worker registry every 10 s = 1 PUT + 1 LIST
//  - sweep leases: fheal GET every 30 s, msweep GET every 60 s per worker; the holder renews
//    (1 PUT/30 s + 1 PUT/60 s per queue, charged here to one worker)
// Add-ons, each optional in bun-jobs, priced separately:
//  - control on (control ?? false): GET of __win:wchg every 2 s (BunQueueWorker.ts:456, 4265-4283)
//  - one polled subscription (a queue subscribe, a summon events trigger, or control with
//    subscribe: true): LIST of the event prefix every 250 ms (the file driver polls every 25 ms)
//  - a summon controller on the queue: a check every 30 s ~ countDemand = 3 LISTs (active, due, waiting)
const month = 30 * 86400;
const base = { reads: 1 + 1 / 30 + 1 / 60, writes: 2 + 1 + 1 / 10 + 1 / 30 + 1 / 60 };
const addOns: Record<string, { reads: number; writes: number }> = {
  "+ control on (GET every 2 s)": { reads: 0.5, writes: 0 },
  "+ one polled subscription (LIST every 250 ms)": { reads: 0, writes: 4 },
  "+ summon controller (3 LIST every 30 s)": { reads: 0, writes: 0.1 },
};
console.log("\n## One idle worker on design (a), per 30 days, defaults\n");
console.log(`| Wait poll interval | wait HEAD/s (measured) | requests/month | ${stores.map(s => s.name).join(" | ")} |`);
console.log(`|---|---|---|${stores.map(() => "---|").join("")}`);
for (const [P, headsPerSec] of [[25, 27.7], [100, 9.5], [250, 3.8], [1000, 1.0]] as const) {
  const reads = (headsPerSec + base.reads) * month;
  const writes = base.writes * month;
  console.log(`| ${P} ms | ${headsPerSec} | ${((reads + writes) / 1e6).toFixed(1)} M | ${stores.map(s => usd(reads * s.read + writes * s.write)).join(" | ")} |`);
}
console.log("\n## Add-ons per idle worker per 30 days\n");
console.log(`| Add-on | ${stores.map(s => s.name).join(" | ")} |`);
console.log(`|---|${stores.map(() => "---|").join("")}`);
for (const [k, a] of Object.entries(addOns))
  console.log(`| ${k} | ${stores.map(s => usd(month * (a.reads * s.read + a.writes * s.write))).join(" | ")} |`);
console.log("\nThe floor with no wait polling at all (promotion 2 LIST/s, claim LIST 1/s, registry, leases):", stores.map(s => `${s.name}: ${usd(month * (base.reads * s.read + base.writes * s.write))}`).join("; "));
