// Prototypes behind docs/plans/research-trailing-scenarios.md §6 (route lookup).
// Run from the repo root: bun docs/plans/evidence/elysia2/lookup-prototypes.ts
// Prototype: (A) a regex-free matcher per route, (B) a radix tree over routes,
// both compiled from each route's own regex source, checked against the regex
// on every lookup, then timed against today's candidate index + regex.
const { BunRouter } = await import("/home/user/bun-node/packages/bun-common/lib/index.ts");
const { RouteCandidateIndex } = await import("/home/user/bun-node/packages/bun-common/lib/utils/routeIndex.ts");

type Part = { kind: "lit"; text: string } | { kind: "param" } | { kind: "rest" };
interface Compiled { parts: Part[]; prefix: boolean; insensitive: boolean }

const LIT = /^(?:\\[.+*?=^!:${}()[\]|\\]|[A-Za-z0-9_\-~%@&,;'"]|\\-)+/;
/** Parses a routejs regex source into parts, or undefined when outside the grammar. */
function compile(re: RegExp): Compiled | undefined {
  let s = re.source;
  if (!s.startsWith("^")) return undefined;
  s = s.slice(1);
  let prefix: boolean;
  if (s.endsWith("\\/?$")) { prefix = false; s = s.slice(0, -4); }
  else if (s.endsWith("\\/?(?=\\/|$)")) { prefix = true; s = s.slice(0, -11); }
  else return undefined;
  const parts: Part[] = [];
  while (s.length) {
    if (!s.startsWith("\\/")) return undefined;
    s = s.slice(2);
    if (s.startsWith("([^\\/]+?)")) { parts.push({ kind: "param" }); s = s.slice(9); }
    else if (s.startsWith("(.*)")) { if (prefix) return undefined; parts.push({ kind: "rest" }); s = s.slice(4); if (s.length) return undefined; }
    else {
      const m = LIT.exec(s);
      if (!m) return undefined;
      const text = m[0].replace(/\\(.)/g, "$1");
      parts.push({ kind: "lit", text });
      s = s.slice(m[0].length);
    }
    // the next part must begin a new segment
    if (s.length && !s.startsWith("\\/")) return undefined;
  }
  const flags = re.flags.replace("i", "");
  if (flags) return undefined;
  return { parts, prefix, insensitive: re.flags.includes("i") };
}

const LINE = new RegExp("[\\n\\r\\u2028\\u2029]");
/** (A) Matches `path` as the regex would; returns the captures (index 1..) or null. */
function match(c: Compiled, path: string): string[] | null {
  const n = path.length;
  if (n === 0 || path.charCodeAt(0) !== 47) {
    // "^\/?$" for root: "" matches
    return c.parts.length === 0 && n === 0 && !c.prefix ? [path] : c.parts.length === 0 && c.prefix && n === 0 ? [path] : null;
  }
  const caps: string[] = [path];
  let pos = 0; // at a "/"
  for (let p = 0; p < c.parts.length; p++) {
    const part = c.parts[p];
    if (pos >= n || path.charCodeAt(pos) !== 47) return null;
    pos++;
    if (part.kind === "rest") {
      const rest = path.slice(pos);
      if (LINE.test(rest)) return null;
      caps.push(rest);
      return caps;
    }
    let end = path.indexOf("/", pos);
    if (end === -1) end = n;
    if (part.kind === "param") {
      if (end === pos) return null;
      caps.push(path.slice(pos, end));
    } else {
      const t = part.text;
      if (end - pos !== t.length) return null;
      if (c.insensitive) {
        for (let k = 0; k < t.length; k++) {
          let a = path.charCodeAt(pos + k), b = t.charCodeAt(k);
          if (a === b) continue;
          if (a >= 65 && a <= 90) a += 32; if (b >= 65 && b <= 90) b += 32;
          if (a !== b || a < 97 || a > 122) return null;
        }
      } else if (!path.startsWith(t, pos)) return null;
    }
    pos = end;
  }
  // tail: "\/?$" or "\/?(?=\/|$)"
  if (c.prefix) {
    if (pos < n && path.charCodeAt(pos) !== 47) return null;
    // `\/?` takes a "/" only when what follows it is "/" or the end.
    caps[0] = path.slice(0, pos + (pos < n && (pos + 1 === n || path.charCodeAt(pos + 1) === 47) ? 1 : 0));
    return caps;
  }
  if (pos === n) return caps;
  if (pos === n - 1 && path.charCodeAt(pos) === 47) return caps;
  return null;
}

// (B) radix tree over compiled routes: static children (lower-cased key when
// the route is case-insensitive), one param child, terminals by route index.
interface Node { stat: Map<string, Node>; statCS: Map<string, Node>; param?: Node; ends: number[]; prefixEnds: number[]; rest: number[] }
const node = (): Node => ({ stat: new Map(), statCS: new Map(), ends: [], prefixEnds: [], rest: [] });
function insert(root: Node, c: Compiled, index: number) {
  let cur = root;
  for (let p = 0; p < c.parts.length; p++) {
    const part = c.parts[p];
    if (part.kind === "rest") { cur.rest.push(index); return; }
    if (part.kind === "param") cur = cur.param ??= node();
    else {
      const map = c.insensitive ? cur.stat : cur.statCS;
      const key = c.insensitive ? part.text.toLowerCase() : part.text;
      let next = map.get(key); if (!next) map.set(key, (next = node())); cur = next;
    }
  }
  (c.prefix ? cur.prefixEnds : cur.ends).push(index);
}
/** Collects every simple route matching `path` (index → captures). */
function walk(root: Node, path: string, bounds: readonly number[], out: Map<number, string[]>) {
  const segCount = bounds.length === 0 ? 0 : bounds.length - 1;
  const caps: string[] = [];
  const visit = (n: Node, i: number) => {
    if (n.prefixEnds.length) { const pos = i < segCount ? bounds[i] - 1 : path.length - (path.length > 1 && path.endsWith("/") ? 1 : 0); const m0 = path.slice(0, pos + (pos < path.length && (pos + 1 === path.length || path.charCodeAt(pos + 1) === 47) ? 1 : 0)); for (const idx of n.prefixEnds) out.set(idx, [m0, ...caps]); }
    if (n.rest.length) {
      const start = i < segCount ? bounds[i] : -1;
      // "\/(.*)": needs the "/" after this node; rest = everything after it
      const restStart = i < segCount ? bounds[i] : (path.length > 1 && path.endsWith("/") && i === segCount ? path.length : -1);
      if (restStart >= 0) { const rest = path.slice(restStart); if (!LINE.test(rest)) for (const idx of n.rest) out.set(idx, [path, ...caps, rest]); }
      void start;
    }
    if (i === segCount) { for (const idx of n.ends) out.set(idx, [path, ...caps]); return; }
    const s = bounds[i], e = bounds[i + 1] - 1;
    const seg = path.slice(s, e);
    const a = n.statCS.get(seg); if (a) visit(a, i + 1);
    if (n.stat.size) { const lower = seg.toLowerCase(); if (!/[^\x00-\x7f]/.test(seg) || lower === seg) { const b = n.stat.get(lower); if (b) visit(b, i + 1); } }
    if (n.param && e > s) { caps.push(seg); visit(n.param, i + 1); caps.pop(); }
  };
  visit(root, 0);
}

// The route table: the benchmark's, plus the shapes above.
const r = new BunRouter();
const h = (_q: any, s: any) => s.send("x");
r.use("/mw", h); r.use(h); r.get("/static", h); r.get("/user/:id", h); r.get("/assets/*", h); r.get("/files/*splat", h);
r.get("/a/:b?", h); r.get("/x/:y(\\d+)", h); r.get("/u-:id", h); r.get("/", h); r.get("/Case/Path", h);
const sub = new BunRouter(); sub.get("/posts/:pid", h); r.use("/users/:uid", sub);
for (let i = 0; i < 1000; i++) r.get(`/r${i}/:id`, h);
const routes = (r as any).routes() as any[];
const compiled = routes.map((rt) => (rt.pathRegexp ? compile(rt.pathRegexp) : undefined));
const simple = compiled.filter(Boolean).length;
console.log(`routes ${routes.length}, compiled ${simple}, left on regex ${routes.length - simple}`);
const root = node();
compiled.forEach((c, i) => c && insert(root, c, i));
const complexIdx = compiled.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);

const { requestPathBounds } = await import("/home/user/bun-node/packages/bun-common/lib/utils/routeIndex.ts");
const index = new RouteCandidateIndex();

// ---- correctness: every route, regex vs (A), and full match sets vs (B)
const samples = ["/", "", "/static", "/STATIC/", "/static//", "/user/42", "/user/", "/user//", "/user/42/", "/user/42//", "/user/a%2Fb",
  "/assets", "/assets/", "/assets/a/b/", "/assets/x\ny", "/files/a", "/mw", "/mw/", "/mw/hit", "/mwx", "/users/1/posts/2", "/users/1/posts/2/",
  "/r999/7", "/R999/7", "/r999/7/", "/r999", "/r1000/7", "/case/path", "/Case/Path", "/ſtatic", "/x/12", "/u-9", "/a", "/a/1"];
for (let k = 0; k < 2000; k++) samples.push(`/r${(Math.random() * 1100) | 0}/${Math.random().toString(36).slice(2, 2 + ((Math.random() * 6) | 0))}${Math.random() < 0.2 ? "/" : ""}`);
let bad = 0;
for (const path of samples) {
  const viaRegex = new Map<number, string[]>();
  routes.forEach((rt, i) => { const m = rt.pathRegexp?.exec(path); if (m) viaRegex.set(i, [...m].map((v) => v ?? "")); });
  // (A)
  compiled.forEach((c, i) => { if (!c) return; const a = match(c, path); const re = viaRegex.get(i); if (JSON.stringify(a) !== JSON.stringify(re ?? null)) { if (bad++ < 8) console.log("A mismatch", i, routes[i].path ?? routes[i].group, JSON.stringify(path), a, re); } });
  // (B)
  const out = new Map<number, string[]>();
  walk(root, path, requestPathBounds(path), out);
  for (const i of complexIdx) { const m = routes[i].pathRegexp?.exec(path); if (m) out.set(i, [...m].map((v) => v ?? "")); }
  const want = JSON.stringify([...viaRegex].sort((x, y) => x[0] - y[0]));
  const got = JSON.stringify([...out].sort((x, y) => x[0] - y[0]));
  if (want !== got) { if (bad++ < 8) console.log("B mismatch", JSON.stringify(path), got, want); }
}
console.log(`correctness: ${samples.length} paths, ${bad} mismatches`);

// ---- timing: lookup of a fresh /r<k>/<id> (the param-random miss), and a fresh wildcard path
let seq = 10_000_000;
const N = 400_000;
function bench(name: string, mk: () => string, f: (path: string) => number) {
  for (let i = 0; i < 50_000; i++) f(mk());
  const res: number[] = [];
  for (let k = 0; k < 5; k++) { const t = Bun.nanoseconds(); let sink = 0; for (let i = 0; i < N; i++) sink += f(mk()); const t2 = Bun.nanoseconds(); for (let i = 0; i < N; i++) mk(); res.push(((t2 - t) - (Bun.nanoseconds() - t2)) / N); if (sink < 0) console.log(); }
  res.sort((a, b) => a - b);
  return res[2];
}
const current = (path: string) => { let n = 0; for (const i of index.candidates(routes, path)) { const m = routes[i].pathRegexp.exec(path); if (m) n += m.length; } return n; };
const optA = (path: string) => { let n = 0; for (const i of index.candidates(routes, path)) { const c = compiled[i]; const m = c ? match(c, path) : routes[i].pathRegexp.exec(path); if (m) n += m.length; } return n; };
const optB = (path: string) => { const out = new Map<number, string[]>(); walk(root, path, requestPathBounds(path), out); let n = out.size; for (const i of complexIdx) { const m = routes[i].pathRegexp.exec(path); if (m) n += m.length; } return n; };
const scenarios: [string, () => string][] = [
  ["param-random /r999/<id>", () => `/r999/${seq++}`],
  ["wildcard-random /assets/<id>/app.css", () => `/assets/${seq++}/site/app.css`],
  ["static /static", () => "/static"],
];
for (const [name, mk] of scenarios) {
  const c = bench(name, mk, current), a = bench(name, mk, optA), b = bench(name, mk, optB);
  console.log(`${name.padEnd(38)} current ${c.toFixed(0).padStart(4)} ns   A matcher ${a.toFixed(0).padStart(4)} ns   B radix ${b.toFixed(0).padStart(4)} ns`);
}

console.log("--- split of the current lookup");
for (const [name, mk] of scenarios.slice(0, 2)) {
  const cand = bench(name, mk, (p) => index.candidates(routes, p).length);
  const bounds = bench(name, mk, (p) => requestPathBounds(p).length);
  const cur = bench(name, mk, current);
  console.log(`${name.padEnd(38)} bounds ${bounds.toFixed(0)} ns, candidates() ${cand.toFixed(0)} ns, candidates+regex ${cur.toFixed(0)} ns`);
}

// ---- B2: the radix walk without closures, bounds arrays or Maps of results
interface Hit { idx: number[]; caps: string[][] }
function walk2(n: Node, path: string, pos: number, caps: string[], hit: Hit): void {
  // pos: index of the "/" that starts the next segment, or path.length
  const len = path.length;
  const atEnd = pos >= len || (pos === len - 1 && path.charCodeAt(pos) === 47);
  if (n.prefixEnds.length) {
    const m0 = path.slice(0, pos + (pos < len && (pos + 1 === len || path.charCodeAt(pos + 1) === 47) ? 1 : 0));
    for (let k = 0; k < n.prefixEnds.length; k++) { hit.idx.push(n.prefixEnds[k]); hit.caps.push([m0, ...caps]); }
  }
  if (n.rest.length && pos < len) {
    const rest = path.slice(pos + 1);
    if (!LINE.test(rest)) for (let k = 0; k < n.rest.length; k++) { hit.idx.push(n.rest[k]); hit.caps.push([path, ...caps, rest]); }
  }
  if (atEnd) {
    for (let k = 0; k < n.ends.length; k++) { hit.idx.push(n.ends[k]); hit.caps.push([path, ...caps]); }
    return;
  }
  if (path.charCodeAt(pos) !== 47) return;
  const s = pos + 1;
  let e = path.indexOf("/", s);
  if (e === -1) e = len;
  // a trailing "/" after the last segment is the optional one: the segment ends at it
  if (n.statCS.size || n.stat.size) {
    const seg = path.slice(s, e);
    const a = n.statCS.size ? n.statCS.get(seg) : undefined;
    if (a) walk2(a, path, e, caps, hit);
    if (n.stat.size) { const b = n.stat.get(seg.toLowerCase()); if (b) walk2(b, path, e, caps, hit); }
  }
  if (n.param && e > s) { caps.push(path.slice(s, e)); walk2(n.param, path, e, caps, hit); caps.pop(); }
}
const complexRoutes = complexIdx.map((i) => routes[i]);
const complexIndex = new RouteCandidateIndex();
const optB2 = (path: string) => {
  const hit: Hit = { idx: [], caps: [] };
  walk2(root, path, path.length && path.charCodeAt(0) === 47 && path.length > 0 ? 0 : 0, [], hit);
  let n = hit.idx.length;
  for (const j of complexIndex.candidates(complexRoutes, path)) { const m = complexRoutes[j].pathRegexp.exec(path); if (m) n += m.length; }
  return n;
};
// B2 correctness (the walk only: empty path special-cased like the regex)
let bad2 = 0;
for (const path of samples) {
  if (path === "") continue;
  const viaRegex: [number, string[]][] = [];
  compiled.forEach((c, i) => { if (!c) return; const m = routes[i].pathRegexp.exec(path); if (m) viaRegex.push([i, [...m].map((v) => v ?? "")]); });
  const hit: Hit = { idx: [], caps: [] };
  walk2(root, path, 0, [], hit);
  const got = hit.idx.map((i, k) => [i, hit.caps[k]] as [number, string[]]).sort((x, y) => x[0] - y[0]);
  if (JSON.stringify(got) !== JSON.stringify(viaRegex.sort((x, y) => x[0] - y[0]))) { if (bad2++ < 6) console.log("B2 mismatch", JSON.stringify(path), JSON.stringify(got), JSON.stringify(viaRegex)); }
}
console.log(`B2 correctness: ${bad2} mismatches`);
console.log("--- round 2");
for (let round = 0; round < 2; round++) for (const [name, mk] of scenarios) {
  const c = bench(name, mk, current), a = bench(name, mk, optA), b2 = bench(name, mk, optB2);
  console.log(`${name.padEnd(38)} current ${c.toFixed(0).padStart(4)} ns   A matcher ${a.toFixed(0).padStart(4)} ns   B2 radix ${b2.toFixed(0).padStart(4)} ns`);
}
console.log("--- B2 split");
for (const [name, mk] of scenarios.slice(0, 1)) {
  const w = bench(name, mk, (p) => { const hit: Hit = { idx: [], caps: [] }; walk2(root, p, 0, [], hit); return hit.idx.length; });
  const ci = bench(name, mk, (p) => complexIndex.candidates(complexRoutes, p).length);
  console.log(`${name}: walk ${w.toFixed(0)} ns, complex candidates ${ci.toFixed(0)} ns`);
}
for (const path of samples) { if (path === "") continue; const viaRegex: [number, string[]][] = []; compiled.forEach((c, i) => { if (!c) return; const m = routes[i].pathRegexp.exec(path); if (m) viaRegex.push([i, [...m].map((v) => v ?? "")]); }); const hit: Hit = { idx: [], caps: [] }; walk2(root, path, 0, [], hit); const got = hit.idx.map((i, k) => [i, hit.caps[k]] as [number, string[]]).sort((x, y) => x[0] - y[0]); if (JSON.stringify(got) !== JSON.stringify(viaRegex.sort((x, y) => x[0] - y[0]))) console.log("mismatch", JSON.stringify(path), JSON.stringify(got), JSON.stringify(viaRegex)); }

// ---- B3: character-level radix (memoirist-style), no substrings for statics
interface CNode { s: string; kids: (CNode | undefined)[] | undefined; param?: CNode; ends: number[]; prefixEnds: number[]; rest: number[] }
const cnode = (s: string): CNode => ({ s, kids: undefined, ends: [], prefixEnds: [], rest: [] });
const fold = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c);
type Tok = { kind: "s"; text: string } | { kind: "p" } | { kind: "r" };
function tokens(c: Compiled): Tok[] {
  const out: Tok[] = []; let buf = "";
  for (const part of c.parts) {
    if (part.kind === "lit") buf += "/" + (c.insensitive ? part.text.toLowerCase() : part.text);
    else if (part.kind === "param") { out.push({ kind: "s", text: buf + "/" }); buf = ""; out.push({ kind: "p" }); }
    else { out.push({ kind: "s", text: buf + "/" }); buf = ""; out.push({ kind: "r" }); }
  }
  if (buf || !out.length || out[out.length - 1].kind !== "s") out.push({ kind: "s", text: buf });
  return out;
}
function addStatic(n: CNode, text: string): CNode {
  // n.s already matched; descend/split by text
  let cur = n; let t = text;
  while (t.length) {
    const code = t.charCodeAt(0);
    cur.kids ??= [];
    let kid = cur.kids[code];
    if (!kid) { kid = cnode(t); cur.kids[code] = kid; return kid; }
    let k = 0; const max = Math.min(kid.s.length, t.length);
    while (k < max && kid.s.charCodeAt(k) === t.charCodeAt(k)) k++;
    if (k < kid.s.length) { // split
      const tail = cnode(kid.s.slice(k)); tail.kids = kid.kids; tail.param = kid.param; tail.ends = kid.ends; tail.prefixEnds = kid.prefixEnds; tail.rest = kid.rest; (tail as any).regex = (kid as any).regex ?? []; (kid as any).regex = [];
      kid.s = kid.s.slice(0, k); kid.kids = []; kid.kids[tail.s.charCodeAt(0)] = tail; kid.param = undefined; kid.ends = []; kid.prefixEnds = []; kid.rest = [];
    }
    cur = kid; t = t.slice(k);
  }
  return cur;
}
const rootCI = cnode(""), rootCS = cnode("");
compiled.forEach((c, i) => {
  if (!c) return;
  let n = c.insensitive ? rootCI : rootCS;
  const toks = tokens(c);
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.kind === "s") n = addStatic(n, tk.text);
    else if (tk.kind === "p") n = n.param ??= cnode("");
    else { n.rest.push(i); return; }
  }
  (c.prefix ? n.prefixEnds : n.ends).push(i);
});
function walk3(n: CNode, path: string, pos: number, ci: boolean, caps: string[], hit: Hit): void {
  const s = n.s; const len = path.length;
  if (pos + s.length > len) return;
  for (let k = 0; k < s.length; k++) { let c = path.charCodeAt(pos + k); if (ci) c = fold(c); if (c !== s.charCodeAt(k)) return; }
  pos += s.length;
  if (n.ends.length && (pos === len || (pos === len - 1 && path.charCodeAt(pos) === 47))) {
    for (let k = 0; k < n.ends.length; k++) { const c = caps.slice(); c.unshift(path); hit.idx.push(n.ends[k]); hit.caps.push(c); }
  }
  if (n.prefixEnds.length && (pos === len || path.charCodeAt(pos) === 47)) {
    const m0 = path.slice(0, pos + (pos < len && (pos + 1 === len || path.charCodeAt(pos + 1) === 47) ? 1 : 0));
    for (let k = 0; k < n.prefixEnds.length; k++) { const c = caps.slice(); c.unshift(m0); hit.idx.push(n.prefixEnds[k]); hit.caps.push(c); }
  }
  if (n.rest.length) {
    const rest = path.slice(pos);
    if (!LINE.test(rest)) for (let k = 0; k < n.rest.length; k++) { const c = caps.slice(); c.unshift(path); c.push(rest); hit.idx.push(n.rest[k]); hit.caps.push(c); }
  }
  if (pos < len && n.kids) { let c = path.charCodeAt(pos); if (ci) c = fold(c); const kid = n.kids[c]; if (kid) walk3(kid, path, pos, ci, caps, hit); }
  if (n.param && pos < len) {
    let e = path.indexOf("/", pos); if (e === -1) e = len;
    if (e > pos) { caps.push(path.slice(pos, e)); walk3(n.param, path, e, ci, caps, hit); caps.pop(); }
  }
}
const lookup3 = (path: string, hit: Hit) => { walk3(rootCI, path, 0, true, [], hit); walk3(rootCS, path, 0, false, [], hit); };
let bad3 = 0;
for (const path of samples) {
  const viaRegex: [number, string[]][] = [];
  compiled.forEach((c, i) => { if (!c) return; const m = routes[i].pathRegexp.exec(path); if (m) viaRegex.push([i, [...m].map((v) => v ?? "")]); });
  const hit: Hit = { idx: [], caps: [] }; lookup3(path, hit);
  const got = hit.idx.map((i, k) => [i, hit.caps[k]] as [number, string[]]).sort((x, y) => x[0] - y[0]);
  if (JSON.stringify(got) !== JSON.stringify(viaRegex.sort((x, y) => x[0] - y[0]))) { if (bad3++ < 6) console.log("B3 mismatch", JSON.stringify(path), JSON.stringify(got), JSON.stringify(viaRegex)); }
}
console.log(`B3 correctness: ${bad3} mismatches`);
const optB3 = (path: string) => { const hit: Hit = { idx: [], caps: [] }; lookup3(path, hit); let n = hit.idx.length; for (const j of complexIndex.candidates(complexRoutes, path)) { const m = complexRoutes[j].pathRegexp.exec(path); if (m) n += m.length; } return n; };
const walkOnly3 = (path: string) => { const hit: Hit = { idx: [], caps: [] }; lookup3(path, hit); return hit.idx.length; };
console.log("--- round 3");
for (let round = 0; round < 2; round++) for (const [name, mk] of scenarios) {
  const c = bench(name, mk, current), a = bench(name, mk, optA), b3 = bench(name, mk, optB3), w3 = bench(name, mk, walkOnly3);
  console.log(`${name.padEnd(38)} current ${c.toFixed(0).padStart(4)}  A ${a.toFixed(0).padStart(4)}  B3 radix ${b3.toFixed(0).padStart(4)} (walk alone ${w3.toFixed(0)}) ns`);
}

// ---- B4: B3 plus regex leaves (no candidate index at all), fewer allocations
interface RNode extends CNode { regex: number[] }
/** The literal text every match of `re` starts with (folded when `i`), stopping at the first special token. */
function literalPrefix(re: RegExp): string {
  let s = re.source; if (!s.startsWith("^")) return ""; s = s.slice(1);
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\") { const nx = s[k + 1]; if (nx && /[\/.\-+*?=^!:${}()[\]|\\]/.test(nx)) { out += nx; k++; continue; } break; }
    if (/[A-Za-z0-9_~%@&,;'"\-]/.test(ch)) { out += ch; continue; }
    break;
  }
  // a quantifier after the last literal char applies to it: drop that char
  const after = s[out.length + (s.slice(0).match(/\\/g)?.length ?? 0)];
  void after;
  return out;
}
const rootCI4 = cnode("") as RNode, rootCS4 = cnode("") as RNode;
const all = (n: CNode) => { (n as RNode).regex ??= []; };
all(rootCI4); all(rootCS4);
function addStatic4(n: RNode, text: string): RNode { const r = addStatic(n, text) as RNode; r.regex ??= []; return r; }
compiled.forEach((c, i) => {
  if (!c) return;
  let n = c.insensitive ? rootCI4 : rootCS4;
  for (const tk of tokens(c)) {
    if (tk.kind === "s") n = addStatic4(n, tk.text);
    else if (tk.kind === "p") { n.param ??= cnode(""); n = n.param as RNode; n.regex ??= []; }
    else { n.rest.push(i); return; }
  }
  (c.prefix ? n.prefixEnds : n.ends).push(i);
});
for (const i of complexIdx) {
  const re = routes[i].pathRegexp as RegExp;
  const ci = re.flags.includes("i");
  let lit = literalPrefix(re);
  // safety: a literal directly followed by a quantifier is not fixed; cut back to the last "/"
  const cut = lit.lastIndexOf("/"); lit = cut >= 0 ? lit.slice(0, cut + 1) : "";
  if (/[^\x00-\x7f]/.test(lit)) lit = "";
  const n = lit ? addStatic4(ci ? rootCI4 : rootCS4, ci ? lit.toLowerCase() : lit) : ci ? rootCI4 : rootCS4;
  n.regex.push(i);
}
function walk4(n: RNode, path: string, pos: number, ci: boolean, caps: string[], hit: Hit): void {
  const s = n.s; const len = path.length;
  if (pos + s.length > len) return;
  for (let k = 0; k < s.length; k++) { let c = path.charCodeAt(pos + k); if (ci && c >= 65 && c <= 90) c += 32; if (c !== s.charCodeAt(k)) return; }
  pos += s.length;
  const nc = caps.length;
  if (n.ends.length && (pos === len || (pos === len - 1 && path.charCodeAt(pos) === 47))) {
    for (let k = 0; k < n.ends.length; k++) { const c = new Array<string>(nc + 1); c[0] = path; for (let j = 0; j < nc; j++) c[j + 1] = caps[j]; hit.idx.push(n.ends[k]); hit.caps.push(c); }
  }
  if (n.prefixEnds.length && (pos === len || path.charCodeAt(pos) === 47)) {
    const m0 = path.slice(0, pos + (pos < len && (pos + 1 === len || path.charCodeAt(pos + 1) === 47) ? 1 : 0));
    for (let k = 0; k < n.prefixEnds.length; k++) { const c = new Array<string>(nc + 1); c[0] = m0; for (let j = 0; j < nc; j++) c[j + 1] = caps[j]; hit.idx.push(n.prefixEnds[k]); hit.caps.push(c); }
  }
  if (n.rest.length) {
    const rest = path.slice(pos);
    if (!LINE.test(rest)) for (let k = 0; k < n.rest.length; k++) { const c = new Array<string>(nc + 2); c[0] = path; for (let j = 0; j < nc; j++) c[j + 1] = caps[j]; c[nc + 1] = rest; hit.idx.push(n.rest[k]); hit.caps.push(c); }
  }
  if (n.regex !== undefined && n.regex.length) for (let k = 0; k < n.regex.length; k++) { const i = n.regex[k]; const m = (routes[i].pathRegexp as RegExp).exec(path); if (m) { hit.idx.push(i); hit.caps.push([...m].map((v) => v ?? "")); } }
  if (pos < len && n.kids) { let c = path.charCodeAt(pos); if (ci && c >= 65 && c <= 90) c += 32; const kid = n.kids[c] as RNode | undefined; if (kid) walk4(kid, path, pos, ci, caps, hit); }
  if (n.param && pos < len) {
    let e = path.indexOf("/", pos); if (e === -1) e = len;
    if (e > pos) { caps.push(path.slice(pos, e)); walk4(n.param as RNode, path, e, ci, caps, hit); caps.pop(); }
  }
}
const lookup4 = (path: string) => { const hit: Hit = { idx: [], caps: [] }; walk4(rootCI4, path, 0, true, [], hit); walk4(rootCS4, path, 0, false, [], hit); return hit; };
let bad4 = 0;
for (const path of samples) {
  const viaRegex: [number, string[]][] = [];
  routes.forEach((rt, i) => { const m = rt.pathRegexp?.exec(path); if (m) viaRegex.push([i, [...m].map((v) => v ?? "")]); });
  const hit = lookup4(path);
  const got = hit.idx.map((i, k) => [i, hit.caps[k]] as [number, string[]]).sort((x, y) => x[0] - y[0]);
  if (JSON.stringify(got) !== JSON.stringify(viaRegex)) { if (bad4++ < 6) console.log("B4 mismatch", JSON.stringify(path), JSON.stringify(got), JSON.stringify(viaRegex)); }
}
console.log(`B4 correctness (every route, regex leaves included): ${bad4} mismatches`);
const optB4 = (path: string) => lookup4(path).idx.length;
console.log("--- round 4");
for (let round = 0; round < 3; round++) for (const [name, mk] of scenarios) {
  const c = bench(name, mk, current), a = bench(name, mk, optA), b4 = bench(name, mk, optB4);
  console.log(`${name.padEnd(38)} current ${c.toFixed(0).padStart(4)}  A ${a.toFixed(0).padStart(4)}  B4 radix ${b4.toFixed(0).padStart(4)} ns`);
}
