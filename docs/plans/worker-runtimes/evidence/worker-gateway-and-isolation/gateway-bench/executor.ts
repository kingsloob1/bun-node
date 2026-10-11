// The remote side. Holds no driver and no database URL: only the host's
// address and the frame secret.
//
//   bun executor.ts ws   <url> <credits> <batch:on|off>
//   bun executor.ts http <url> <concurrency> <batch:on|off>
//   bun executor.ts pull-proxy <url> <concurrency> <batch:on|off>
import process from "node:process";
import { type Item, open, type Outcome, seal, work } from "./wire";

const [mode, url, nArg, batchArg] = process.argv.slice(2);
const n = Number(nArg);
const batch = batchArg === "on";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(url + path, { method: "POST", body: seal(body) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return open<T>(await res.text());
}

if (mode === "ws") {
  // Reversed session: the executor dials the host, grants credits, and the
  // host pushes attempts. Results go back on the same socket.
  const ws = new WebSocket(url);
  let pending: Outcome[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pending.length === 0) return;
    ws.send(seal({ t: "results", items: pending }));
    pending = [];
  };
  ws.onopen = () => ws.send(seal({ t: "credit", n }));
  ws.onmessage = (ev) => {
    const msg = open<{ t: string; items: Item[] }>(String(ev.data));
    if (msg.t === "stop") {
      ws.close();
      process.exit(0);
    }
    for (const item of msg.items) {
      const outcome: Outcome = { id: item.id, result: work(item) };
      if (batch) {
        pending.push(outcome);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      } else {
        ws.send(seal({ t: "results", items: [outcome] }));
      }
    }
  };
} else if (mode === "http") {
  // Reversed exchange over plain HTTP: each loop long-polls the host with
  // the results of its last batch, and gets the next batch back.
  const loops = batch ? Math.max(1, Math.ceil(n / 16)) : n;
  const max = batch ? Math.ceil(n / loops) : 1;
  const loop = async () => {
    let results: Outcome[] = [];
    for (;;) {
      const reply = await post<{ items: Item[]; stop?: boolean }>(
        "/exchange",
        { results, max },
      );
      if (reply.stop) return;
      results = reply.items.map((item) => ({ id: item.id, result: work(item) }));
    }
  };
  await Promise.all(Array.from({ length: loops }, loop));
  process.exit(0);
} else if (mode === "pull-proxy") {
  // The remote holds the lease: it claims through the host's thin driver
  // proxy, runs, and completes with its own token. No BunQueueWorker here,
  // so this is a lower bound for "proxy the driver".
  const loops = batch ? Math.max(1, Math.ceil(n / 16)) : n;
  const max = batch ? Math.ceil(n / loops) : 1;
  const loop = async () => {
    for (;;) {
      const claimed = await post<{ items: Item[]; stop?: boolean }>("/claim", {
        max,
      });
      if (claimed.stop) return;
      if (claimed.items.length === 0) continue;
      const outcomes = claimed.items.map((item) => ({
        id: item.id,
        token: item.token,
        result: work(item),
      }));
      await post("/complete", { items: outcomes });
    }
  };
  await Promise.all(Array.from({ length: loops }, loop));
  process.exit(0);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
