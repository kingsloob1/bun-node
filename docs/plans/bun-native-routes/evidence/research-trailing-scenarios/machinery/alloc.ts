// Served cost of per-request allocation: ALLOC=n objects of 32 fields each.
class Fat { a0: unknown = undefined; a1: unknown = undefined; a2: unknown = undefined; a3: unknown = undefined; a4: unknown = undefined; a5: unknown = undefined; a6: unknown = undefined; a7: unknown = undefined; a8: unknown = undefined; a9: unknown = undefined; b0: unknown = undefined; b1: unknown = undefined; b2: unknown = undefined; b3: unknown = undefined; b4: unknown = undefined; b5: unknown = undefined; b6: unknown = undefined; b7: unknown = undefined; b8: unknown = undefined; b9: unknown = undefined; c0: unknown = undefined; c1: unknown = undefined; c2: unknown = undefined; c3: unknown = undefined; c4: unknown = undefined; c5: unknown = undefined; c6: unknown = undefined; c7: unknown = undefined; c8: unknown = undefined; c9: unknown = undefined; d0: unknown = undefined; d1: unknown = undefined; constructor(public r: unknown) {} }
const n = Number(process.env.ALLOC ?? 0);
let sink: unknown;
const port = Bun.serve({ port: 0, fetch(req) {
  const u = req.url; let o: unknown = u;
  for (let i = 0; i < n; i++) o = new Fat(o);
  sink = o;
  return new Response(u.length > 0 ? "ok" : "");
} }).port;
console.log(`READY ${port}`);
