// S8: what bun-common's getPort() ~1 s lock guards. Its probe (bind, stop(true), hand the port out) leaves
// nothing listening, so a port is free again the moment it is handed out: two callers asking for the
// same candidate both get it unless something remembers it. With the lock, the second gets another port.
// Run from the repo root (imports bun-common's source).
import { getPort } from "../../../../../packages/bun-common/lib/utils/native";
const out: Record<string, unknown> = { bun: Bun.revision.slice(0, 9) };
// The probe, without the lock: bind, stop(true), and again on the same port at once.
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
const candidate = probe.port!;
probe.stop(true);
const again = Bun.serve({ port: candidate, hostname: "127.0.0.1", fetch: () => new Response("x") });
out.rebindRightAfterProbe = again.port === candidate ? "ok (port free at once)" : "different";
again.stop(true);
// getPort's probe with the lock taken out, called twice for the same candidate.
const probeNoLock = (port: number) => { const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("x") }); const p = s.port; s.stop(true); return p; };
out.probeWithoutLockTwice = [probeNoLock(candidate), probeNoLock(candidate)];
// The real getPort: same candidate twice in a row, and concurrently.
const a = await getPort({ port: candidate });
const b = await getPort({ port: candidate });
out.getPortSequential = [a, b, a === b ? "SAME" : "distinct"];
const [c, d] = await Promise.all([getPort({ port: candidate + 1 }), getPort({ port: candidate + 1 })]);
out.getPortConcurrent = [c, d, c === d ? "SAME" : "distinct"];
console.log(JSON.stringify(out));
