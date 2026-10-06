const { BunRequest } = await import("../../../../packages/bun-common/lib/index.ts");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const opts = { parseBody: true, parseCookies: true };
const mk = () => new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json", "content-length": "7" }, body: '{"n":7}' });
const N = 200_000;
async function bench(name: string, f: (r: Request) => unknown) {
  for (let i = 0; i < 20000; i++) { const x = f(mk()); if (x instanceof Promise) await x; }
  const r: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) { const x = f(mk()); if (x instanceof Promise) await x; }
    const t1 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) mk();
    r.push(((t1 - t0) - (Bun.nanoseconds() - t1)) / N);
  }
  r.sort((a, b) => a - b);
  console.log(name.padEnd(48), r[2].toFixed(0), "ns");
}
await bench("request.json() (Elysia's read)", (r) => r.json());
await bench("BunRequest.init (build + read + parse)", (r) => BunRequest.init(r, stub, opts));
await bench("new BunRequest, parseBody: false (no read)", (r) => new BunRequest(r, stub, { parseBody: false }));
await bench("arrayBuffer + Buffer + toString + parse", async (r) => JSON.parse(Buffer.from(await r.arrayBuffer()).toString()));
