import { parse } from "picoquery";
const opts = { nesting: true, nestingSyntax: "js", arrayRepeat: true, arrayRepeatSyntax: "repeat" } as any;
const small = "a=1&b=two";
const big = Array.from({ length: 20 }, (_, i) => `field${i}=${encodeURIComponent("value " + i + " & more")}`).join("&");
const nested = "user[name]=Ada&user[langs]=js&user[langs]=ts&page=2";
const ct = { "content-type": "application/x-www-form-urlencoded" };
const mk = (b: string) => new Request("http://x/", { method: "POST", body: b, headers: ct });
async function time(name: string, f: () => Promise<unknown>) {
  for (let i = 0; i < 5000; i++) await f();
  const N = 100000; const t = performance.now();
  for (let i = 0; i < N; i++) await f();
  console.log(name.padEnd(42), ((performance.now() - t) * 1000 / N).toFixed(2), "µs");
}
const fromFd = (fd: FormData) => { const o: Record<string, unknown> = Object.create(null); for (const [k, v] of fd) { const p = o[k]; o[k] = p === undefined ? v : Array.isArray(p) ? (p.push(v), p) : [p, v]; } return o; };
for (const [n, b] of [["small", small], ["20 fields", big], ["nested", nested]] as const) {
  await time(`${n}: new Request only`, async () => mk(b));
  await time(`${n}: text() + picoquery`, async () => parse(await mk(b).text(), opts));
  await time(`${n}: formData() + entries`, async () => fromFd(await mk(b).formData()));
  await time(`${n}: text() + URLSearchParams`, async () => fromFd(new URLSearchParams(await mk(b).text()) as any));
}
console.log(JSON.stringify(parse(big, opts)) === JSON.stringify(fromFd(await mk(big).formData())));
