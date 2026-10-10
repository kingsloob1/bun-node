// How long the pinned SeaweedFS 4.48 test container takes from `docker run` to
// answering a signed S3 request (bucket create), three times, for PR-S0's
// readiness wait. Starts and removes its own container each round.
// Run: bun seaweed-startup.ts
import { createHash, createHmac } from "node:crypto";
const sh = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
async function signedPut(endpoint: string, path: string) {
  const u = new URL(endpoint); const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); const d = amz.slice(0, 8);
  const h: Record<string, string> = { host: u.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amz };
  const names = Object.keys(h).sort();
  const canon = ["PUT", path, "", names.map(n => `${n}:${h[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${d}/us-east-1/s3/aws4_request`;
  const sig = createHmac("sha256", hmac(hmac(hmac(hmac("AWS4test", d), "us-east-1"), "s3"), "aws4_request")).update(["AWS4-HMAC-SHA256", amz, scope, sha(canon)].join("\n")).digest("hex");
  const { host: _h, ...send } = h;
  return fetch(`${endpoint}${path}`, { method: "PUT", headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=test/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
}
console.log(`Bun ${Bun.version}; image chrislusf/seaweedfs:4.48`);
for (let round = 1; round <= 3; round++) {
  const name = `cacheplan-e6-swstart-${process.pid}-${round}`;
  const port = 19110 + round;
  const t0 = performance.now();
  const r = sh(["docker", "run", "-d", "--rm", "--name", name, "--ulimit", "nofile=65536:65536", "-p", `127.0.0.1:${port}:8333`, "chrislusf/seaweedfs:4.48", "server", "-s3"]);
  if (r.exitCode !== 0) { console.log(`round ${round}: docker run failed: ${r.stderr.toString().trim()}`); continue; }
  let status = 0;
  for (;;) {
    try { status = (await signedPut(`http://127.0.0.1:${port}`, "/bun-jobs-test")).status; if (status === 200) break; } catch {}
    if (performance.now() - t0 > 60_000) break;
    await Bun.sleep(50);
  }
  console.log(`round ${round}: docker run -> bucket created (HTTP ${status}) in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  sh(["docker", "rm", "-f", name]);
}
