// A throwaway prototype of design (a)'s hot path on an S3-compatible server:
// jobs as objects, a "ready" index of marker objects whose names sort by
// priority then run time, claim-once by a create-once (If-None-Match: *) claim
// object, the job record moved to active by If-Match, then completed by If-Match.
// Measures exactly-once, claims/s by worker count, and requests per job by type,
// which is what the cost model in the plan multiplies by.
// Run: bun claim-proto.ts                 (S3_TARGETS as in conditional-writes.ts)
import { S3Client } from "bun";

type Target = { name: string; endpoint: string; key: string; secret: string; bucket: string };
const targets: Target[] = JSON.parse(process.env.S3_TARGETS ?? JSON.stringify([
  { name: "minio 2025.5.24", endpoint: "http://127.0.0.1:19101", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
  { name: "seaweedfs 4.48", endpoint: "http://127.0.0.1:19102", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
]));
const JOBS = Number(process.env.JOBS ?? 300);

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${JOBS} jobs per run`);
for (const t of targets) {
  const s3 = new S3Client({ endpoint: t.endpoint, bucket: t.bucket, accessKeyId: t.key, secretAccessKey: t.secret, region: "us-east-1", virtualHostedStyle: false });
  const counts: Record<string, number> = {};
  const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  // conditional PUT through a presigned URL (Bun's S3Client sends no conditional headers itself)
  const cput = async (key: string, body: string, cond: Record<string, string>) => {
    count(`PUT(${Object.keys(cond)[0] ?? "plain"})`);
    return fetch(s3.presign(key, { method: "PUT", expiresIn: 600 }), { method: "PUT", body, headers: cond });
  };
  const getWithEtag = async (key: string) => { count("GET"); const r = await fetch(s3.presign(key, { expiresIn: 600 })); return { body: await r.text(), etag: r.headers.get("etag")! }; };

  console.log(`\n## ${t.name}`);
  for (const workers of [1, 4, 16]) {
    for (const k of Object.keys(counts)) delete counts[k];
    const ns = `cp-${process.pid}-${Date.now()}-w${workers}`;
    // enqueue: job object (create-once) + ready marker; name sorts by priority, runAt, id
    await Promise.all(Array.from({ length: JOBS }, async (_, i) => {
      const id = String(i).padStart(6, "0");
      await cput(`${ns}/jobs/${id}`, JSON.stringify({ id, v: 1, state: "waiting", data: { i } }), { "if-none-match": "*" });
      await cput(`${ns}/ready/p0/${String(Date.now()).padStart(15, "0")}-${id}`, "", { "if-none-match": "*" });
    }));
    const enqueueCounts = { ...counts };
    for (const k of Object.keys(counts)) delete counts[k];
    const claimedBy = new Map<string, number>();
    let lost = 0, empty = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      for (;;) {
        count("LIST");
        const page = await s3.list({ prefix: `${ns}/ready/`, maxKeys: 32 });
        const keys = (page.contents ?? []).map(c => c.key);
        if (!keys.length) { if (++empty > workers * 3) return; continue; }
        // workers start at different offsets in the page to reduce collisions
        const pick = keys[(w * 7) % keys.length]!;
        const id = pick.slice(-6);
        const c = await cput(`${ns}/claims/${id}`, `w${w}`, { "if-none-match": "*" });
        if (!c.ok) { lost++; continue; }
        if (claimedBy.has(id)) throw new Error(`DOUBLE CLAIM ${id}`);
        claimedBy.set(id, w);
        const job = await getWithEtag(`${ns}/jobs/${id}`);
        const rec = JSON.parse(job.body);
        const a = await cput(`${ns}/jobs/${id}`, JSON.stringify({ ...rec, v: rec.v + 1, state: "active", lockToken: `w${w}` }), { "if-match": job.etag });
        if (!a.ok) throw new Error(`activate lost ${a.status}`);
        count("DELETE"); await s3.delete(pick);
        // "process", then complete with the etag the activate returned (no re-read)
        const done = await cput(`${ns}/jobs/${id}`, JSON.stringify({ ...rec, v: rec.v + 2, state: "completed", lockToken: `w${w}` }), { "if-match": a.headers.get("etag")! });
        if (!done.ok) throw new Error(`complete lost ${done.status}`);
      }
    }));
    const secs = (performance.now() - t0) / 1000;
    const per = Object.entries(counts).map(([k, v]) => `${k} ${(v / JOBS).toFixed(2)}`).join(", ");
    console.log(`workers ${String(workers).padStart(2)}: ${claimedBy.size}/${JOBS} claimed exactly once, ${lost} lost claim races, ${(JOBS / secs).toFixed(0)} jobs/s; per job: ${per}; enqueue per job: ${Object.entries(enqueueCounts).map(([k, v]) => `${k} ${(v / JOBS).toFixed(2)}`).join(", ")}`);
    // cleanup exactly this run's prefix
    for (;;) { const p = await s3.list({ prefix: `${ns}/` }); if (!p.contents?.length) break; await Promise.all(p.contents.map(c => s3.delete(c.key))); }
  }
}
