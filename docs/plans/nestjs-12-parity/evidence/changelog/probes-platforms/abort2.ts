import { createReadStream } from "node:fs";
let stream: any;
const server = Bun.serve({ port: 0, async fetch() { await Bun.sleep(300); stream = createReadStream(new URL("./big.bin", import.meta.url).pathname); return new Response(stream); } });
const ac = new AbortController();
const p = fetch(server.url, { signal: ac.signal }).catch(() => {});
await Bun.sleep(50); ac.abort(); await p;
await Bun.sleep(1200);
console.log("disconnect-before-reply: destroyed:", stream?.destroyed, "bytesRead:", stream?.bytesRead);
server.stop(true);
