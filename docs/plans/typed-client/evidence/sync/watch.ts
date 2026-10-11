/**
 * The client half: connects to the dev channel, and whenever the announced
 * hash differs from the generated file's, fetches the model and rewrites the
 * file (atomically, and only when the content changed).
 *
 *   bun watch.ts <base-url> <token> <out-file>
 */
import { renameSync } from "node:fs";
import { emitRoutes } from "../codegen/emit-dts";
import type { RouteModel } from "../codegen/describe";

const [base, token, out] = process.argv.slice(2) as [string, string, string];
let current = "";
try {
  current = /\/\/ hash: (\w+)/.exec(await Bun.file(out).text())?.[1] ?? "";
} catch {}
let attempt = 0;

let busy = false;
async function sync(hash: string, announcedAt: number) {
  if (hash === current || busy) return;
  busy = true;
  try {
    await syncNow(announcedAt);
  } finally {
    busy = false;
  }
}
async function syncNow(announcedAt: number) {
  const t0 = Date.now();
  const res = await fetch(`${base}/__bun/types`, { headers: { authorization: `Bearer ${token}`, "if-none-match": `"${current}"` } });
  if (res.status === 304) return;
  const model = (await res.json()) as RouteModel;
  const t1 = Date.now();
  const text = emitRoutes(model);
  const tmp = `${out}.tmp-${process.pid}`;
  await Bun.write(tmp, text);
  renameSync(tmp, out);
  current = model.hash;
  console.log(JSON.stringify({ event: "written", hash: model.hash, announceToFetchMs: t0 - announcedAt, fetchMs: t1 - t0, emitWriteMs: Date.now() - t1, at: Date.now() }));
}

function connect() {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/__bun/types/ws`, { headers: { authorization: `Bearer ${token}` } } as never);
  ws.onopen = () => { attempt = 0; console.log(JSON.stringify({ event: "open", at: Date.now() })); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { type: string; hash: string; at: number };
    if (msg.type === "model") void sync(msg.hash, msg.at).catch(err => console.error("sync failed", err));
  };
  ws.onclose = () => {
    const delay = Math.min(2000, 50 * 2 ** attempt++);
    console.log(JSON.stringify({ event: "closed", retryInMs: delay, at: Date.now() }));
    setTimeout(connect, delay);
  };
}
const pollMs = Number(process.env.POLL_MS ?? 0);
if (pollMs > 0) {
  // the hey-api / Kubb shape, for comparison: poll with If-None-Match
  setInterval(() => void sync("?", Date.now()).catch(() => {}), pollMs);
} else {
  connect();
}
