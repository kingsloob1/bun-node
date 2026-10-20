// S4: does Bun.serve honour a `Connection: close` response header (send it, then close the socket)?
import { conn, sleep } from "./raw";
const A = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("Service Unavailable", { status: 503, headers: { connection: "close" } }) });
const c = conn(A.port!); await c.ready;
const first = await c.request("/");
await sleep(50);
console.log(JSON.stringify({ bun: Bun.revision, first, closedAfter: c.closed }));
c.end(); A.stop(true);
