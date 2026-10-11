import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage<string>();

const results: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const id = new URL(req.url).searchParams.get("id")!;
    // Does a store set OUTSIDE Bun.serve leak in?
    const leaked = als.getStore();
    return await als.run(`req-${id}`, async () => {
      await new Promise((r) => setTimeout(r, Number(id) % 2 ? 20 : 1));
      await fetch("http://127.0.0.1:1/").catch(() => {});
      const seen = als.getStore();
      results.push(`${id}:leaked=${leaked ?? "none"}:seen=${seen}`);
      return new Response(String(seen));
    });
  },
});

// Run the client calls inside an outer store, to see whether it leaks into the handler.
await als.run("OUTER", async () => {
  const bodies = await Promise.all(
    [1, 2, 3, 4].map((i) => fetch(`${server.url}?id=${i}`).then((r) => r.text())),
  );
  console.log("bodies:", bodies);
});
console.log("handler observations:", results.sort());
server.stop(true);

// Does a Worker inherit the store?
await als.run("MAIN", async () => {
  const w = new Worker(new URL("./worker-als.ts", import.meta.url).href);
  const got = await new Promise((r) => { w.onmessage = (e) => r(e.data); });
  console.log("worker sees store:", got);
  w.terminate();
});
