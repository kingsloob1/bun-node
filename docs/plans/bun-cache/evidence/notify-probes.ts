// Cross-process invalidation channels other than Postgres: Redis pub/sub
// latency through Bun's RedisClient, and whether the local MongoDB can open a
// change stream (it needs a replica set) and how its TTL monitor is set.
// Run: BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun notify-probes.ts
// (mongodb is resolved from packages/bun-jobs' devDependencies)
import { RedisClient } from "bun";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
const pct = (xs: number[], p: number) => xs.slice().sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!.toFixed(3);

const rurl = process.env.BUN_JOBS_TEST_REDIS_URL;
if (!rurl) console.log("redis: BUN_JOBS_TEST_REDIS_URL unset, skipped");
else {
  const pub = new RedisClient(rurl);
  const sub = new RedisClient(rurl);
  const channel = `cacheplan:${process.pid}`;
  const waiting = new Map<string, (t: number) => void>();
  await sub.subscribe(channel, (message: string) => waiting.get(message)?.(performance.now()));
  for (const [label, n] of [["warm-up", 50], ["sequential", 1000]] as const) {
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${label}:${i}`;
      const got = new Promise<number>(r => waiting.set(id, r));
      const t0 = performance.now();
      await pub.publish(channel, id);
      lat.push((await got) - t0);
    }
    if (label !== "warm-up") console.log(`redis pub/sub ${label} n=${n}: p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, p99 ${pct(lat, 0.99)} ms`);
  }
  const cfg = await pub.send("CONFIG", ["GET", "notify-keyspace-events"]);
  console.log(`redis notify-keyspace-events: ${JSON.stringify(cfg)} (keyspace notifications ${JSON.stringify(cfg).includes('""') ? "off" : "configured"})`);
  const info = await pub.send("INFO", ["server"]) as string;
  console.log(`redis version: ${/redis_version:(\S+)/.exec(info)?.[1]}`);
  sub.close(); pub.close();
}

const murl = process.env.BUN_JOBS_TEST_MONGODB_URL;
if (!murl) console.log("mongodb: BUN_JOBS_TEST_MONGODB_URL unset, skipped");
else {
  const { MongoClient } = await import(`${import.meta.dir}/../../../../packages/bun-jobs/node_modules/mongodb/lib/index.js`).catch(() => import("mongodb"));
  const client = new MongoClient(murl, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const admin = client.db().admin();
  const hello = await admin.command({ hello: 1 });
  console.log(`mongodb: version ${(await admin.command({ buildInfo: 1 })).version}, setName=${hello.setName ?? "(none: standalone)"}`);
  const ttl = await admin.command({ getParameter: 1, ttlMonitorSleepSecs: 1 }).catch((e: Error) => ({ error: e.message }));
  console.log(`mongodb ttlMonitorSleepSecs: ${JSON.stringify(ttl.ttlMonitorSleepSecs ?? ttl)}`);
  const coll = client.db().collection(`cacheplan_probe_${process.pid}`);
  try {
    const cs = coll.watch();
    await Promise.race([cs.tryNext(), new Promise(r => setTimeout(r, 1500))]);
    console.log("mongodb change stream: opened");
    await cs.close();
  } catch (e) { console.log(`mongodb change stream: refused (${(e as Error).message.split("\n")[0]})`); }
  await coll.drop().catch(() => {});
  await client.close();
}
