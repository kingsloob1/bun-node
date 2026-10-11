// json: what a POST {"n":7} costs, read the four ways (fresh request each time).
const N = 300_000;
const mk = () => new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json", "content-length": "7" }, body: '{"n":7}' });
async function bench(name: string, f: (r: Request) => Promise<unknown>) {
  for (let i = 0; i < 20000; i++) await f(mk());
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) await f(mk());
  const t1 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) mk();
  const t2 = Bun.nanoseconds();
  console.log(name.padEnd(42), (((t1 - t0) - (t2 - t1)) / N).toFixed(0), "ns");
}
for (let k = 0; k < 2; k++) {
  await bench("request.json()", (r) => r.json());
  await bench("request.text() + JSON.parse", async (r) => JSON.parse(await r.text()));
  await bench("arrayBuffer + Buffer.from + toString + parse", async (r) => JSON.parse(Buffer.from(await r.arrayBuffer()).toString()));
  await bench("request.bytes() + TextDecoder + parse", async (r) => JSON.parse(new TextDecoder().decode(await r.bytes())));
}
