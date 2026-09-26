// @ts-nocheck -- `node:quic` is experimental in Bun 1.4.x and bun-types declares no types for it,
// so nothing here can be typed. This spike records runtime behaviour only.
// node:quic spike under Bun: raw QUIC (custom ALPN) bidi stream + datagrams, no HTTP/3.
// API per Node's doc/api/quic.md (main, read 2026-09-25). Run: bun quic.ts
import { createPrivateKey } from "node:crypto";
const quic: any = await import("node:quic");
const dir = import.meta.dir;
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${what}`); })]) as Promise<T>;
const enc = new TextEncoder(); const dec = new TextDecoder();
const keyObj = createPrivateKey(await Bun.file(`${dir}/key.pem`).text());
const certBuf = new Uint8Array(await Bun.file(`${dir}/cert.pem`).arrayBuffer());

const serverLog: string[] = [];
const step = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`RESULT ${name}: ${await fn()}`); }
  catch (e) { console.log(`RESULT ${name}: FAILED ${(e as Error).name}: ${(e as Error).message}`); }
};

let endpoint: any;
await step("1 quic.listen (alpn bunjobs/1, sni *)", async () => {
  endpoint = await quic.listen((session: any) => {
    serverLog.push("session");
    session.onstream = async (stream: any) => {
      serverLog.push(`stream ${stream.direction}`);
      const w = stream.writer;
      for await (const chunks of stream) {
        for (const c of chunks) { const s = dec.decode(c); serverLog.push(`got "${s}"`); w.writeSync(enc.encode(`echo:${s}`)); }
      }
      w.endSync();
    };
    session.ondatagram = (d: Uint8Array) => { serverLog.push(`datagram ${d.byteLength}B`); session.sendDatagram(enc.encode(`dg-echo:${dec.decode(d)}`)); };
  }, {
    endpoint: { address: "127.0.0.1:0" },
    alpn: ["bunjobs/1"],
    sni: { "*": { keys: [keyObj], certs: [certBuf] } },
    transportParams: { maxDatagramFrameSize: 1200 },
  });
  return `listening on ${JSON.stringify(endpoint.address?.toJSON?.() ?? endpoint.address)}`;
});

let session: any;
const dgrams: string[] = [];
await step("2 quic.connect with ca + servername", async () => {
  const port = endpoint.address.port;
  session = await withTimeout(quic.connect(`127.0.0.1:${port}`, {
    alpn: "bunjobs/1", servername: "localhost", ca: [certBuf],
    transportParams: { maxDatagramFrameSize: 1200 },
  }), 5000, "connect");
  session.ondatagram = (d: Uint8Array) => dgrams.push(dec.decode(d));
  const info = await withTimeout(session.opened, 5000, "opened");
  return `opened: ${JSON.stringify(info, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 300)}`;
});

await step("3 bidi stream ping-pong", async () => {
  const stream = await session.createBidirectionalStream();
  const w = stream.writer;
  const it = stream[Symbol.asyncIterator]();
  const got: string[] = [];
  for (const m of ["m0", "m1", "m2"]) {
    w.writeSync(enc.encode(m));
    const { value } = await withTimeout(it.next(), 3000, `reply to ${m}`);
    got.push(value.map((c: Uint8Array) => dec.decode(c)).join(""));
  }
  w.endSync();
  return JSON.stringify(got);
});

await step("4 datagram round trip", async () => {
  const id = await session.sendDatagram(enc.encode("hello-dg")); // Promise<bigint> per Node docs; 0 = refused
  await sleep(300);
  const big = await session.sendDatagram(new Uint8Array(4000));
  return `sendDatagram -> ${id}; received ${JSON.stringify(dgrams)}; 4000-byte datagram sendDatagram -> ${big} (0 means refused: over maxDatagramFrameSize)`;
});

await step("5 connect without ca (self-signed)", async () => {
  const s = await withTimeout(quic.connect(`127.0.0.1:${endpoint.address.port}`, { alpn: "bunjobs/1", servername: "localhost", reuseEndpoint: false }), 5000, "connect");
  const info = await withTimeout(s.opened, 5000, "opened");
  s.destroy();
  return `opened; validationErrorReason=${info.validationErrorReason ?? "(none)"} validationErrorCode=${info.validationErrorCode ?? "(none)"}`;
});

console.log("server log:", serverLog);
try { session?.destroy(); endpoint?.destroy(); } catch {}
process.exit(0);
