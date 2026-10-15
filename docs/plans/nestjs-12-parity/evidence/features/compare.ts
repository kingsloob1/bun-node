/**
 * Prints the leaf differences between two probe result JSON files.
 * Usage: bun compare.ts a.json b.json [--strict]
 * Without --strict, known transport noise is normalised away: content-length
 * (adapter.fetch() vs a served response), x-powered-by, and the space in
 * "type; charset" (Express writes one, Bun's Response does not).
 */
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const [a, b] = await Promise.all(args.filter((x) => !x.startsWith("--")).slice(0, 2).map((p) => Bun.file(p).json()));
const IGNORE = new Set(["kind", "platformExpress", "nest"]);
const NOISE = new Set(["content-length", "x-powered-by"]);
function norm(path: string, v: any) {
  if (strict) return v;
  if (typeof v === "string" && /content-type$/.test(path)) return v.replace(/;\s*/g, ";").toLowerCase();
  return v;
}
let n = 0;
function walk(x: any, y: any, path: string) {
  const leaf = path.split(".").pop()!;
  if (IGNORE.has(leaf) || (!strict && NOISE.has(leaf))) return;
  if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k);
    return;
  }
  if (JSON.stringify(norm(path, x)) !== JSON.stringify(norm(path, y))) {
    n++;
    console.log(`${path}\n   A: ${JSON.stringify(x)}\n   B: ${JSON.stringify(y)}`);
  }
}
walk(a, b, "");
console.log(`-- ${n} difference(s)`);
