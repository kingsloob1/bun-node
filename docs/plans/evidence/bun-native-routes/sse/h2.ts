/**
 * An event stream over HTTP/2: Bun.serve({ http2: true, tls }) (experimental
 * since 1.4.1), raw and through bun-common's adapter (whose `server` option is
 * spread into Bun.serve), read with curl --http2. Includes the
 * `Connection: keep-alive` header NestJS's SseStream sets, which HTTP/2
 * forbids (RFC 9113 §8.2.2).
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/h2.ts
 *
 * Generates a throwaway self-signed certificate in a temp dir with openssl.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { log } from "./lib";

const dir = mkdtempSync(join(tmpdir(), "sse-h2-"));
Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", "1", "-subj", "/CN=localhost"], { stderr: "ignore" });
const tls = { key: await Bun.file(`${dir}/key.pem`).text(), cert: await Bun.file(`${dir}/cert.pem`).text() };

async function curl(url: string, proto: "--http2" | "--http1.1"): Promise<string> {
  const p = Bun.spawn(["curl", "-sk", proto, "-N", "--max-time", "2", "-o", "-", "-w", "\\n[http_version=%{http_version} code=%{http_code}]", url], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  return JSON.stringify(out + (err ? ` stderr=${err.trim()}` : ""));
}

const sseBody = (withConnection: boolean) => new Response(
  new ReadableStream({
    async start(c) {
      for (let i = 1; i <= 3; i++) {
        c.enqueue(new TextEncoder().encode(`data: e${i}\n\n`));
        await Bun.sleep(50);
      }
      c.close();
    },
  }),
  { headers: { "content-type": "text/event-stream", ...(withConnection ? { connection: "keep-alive" } : {}) } },
);

const raw = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  http2: true,
  tls,
  fetch: (req) => sseBody(new URL(req.url).pathname === "/conn"),
} as Parameters<typeof Bun.serve>[0]);
log("raw h2, no Connection header", await curl(`https://127.0.0.1:${raw.port}/e`, "--http2"));
log("raw h2, Connection: keep-alive", await curl(`https://127.0.0.1:${raw.port}/conn`, "--http2"));
log("raw same server, --http1.1", await curl(`https://127.0.0.1:${raw.port}/e`, "--http1.1"));
raw.stop(true);

const a = new BunHttpAdapter(0, { logger: noopLogger, server: { http2: true, tls } as never });
a.get("/e", (_q, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  let n = 0;
  const t = setInterval(() => {
    res.write(`data: e${++n}\n\n`);
    if (n === 3) {
      clearInterval(t);
      void res.end();
    }
  }, 50);
});
const s = await a.listen(0);
log("bun-common adapter h2, res.write + Connection header", await curl(`https://127.0.0.1:${s.port}/e`, "--http2"));
await a.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
