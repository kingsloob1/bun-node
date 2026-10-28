/**
 * The cache lab's page (`GET /playground/cache`, `cache.ts`): plain HTML and
 * a little inline script that calls the lab's routes with `fetch` and shows
 * each answer's `X-Cache`, `Age` and time, the live `cache.stats()`, and the
 * driver, compression and L1 switch. Like the compute page, it is a string:
 * nothing to build.
 */

/** The page, its routes under `base`. */
export function cachePage(base: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playground cache</title>
<style>
:root{--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--line:#8884;--hit:#1a7f37;--miss:#9a6700;--stale:#8250df;--bypass:#57606a;--unc:#cf222e}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#161616;--muted:#a1a1a6;--hit:#3fb950;--miss:#d29922;--stale:#a371f7;--bypass:#8b949e;--unc:#f85149}}
body{font:14px system-ui,sans-serif;margin:16px;max-width:1100px;color:var(--fg);background:var(--bg)}
h2{margin-top:28px}p{max-width:80ch}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
.routes td{white-space:normal;min-width:14em}.routes td:first-child{min-width:0;width:13em}.muted{color:var(--muted)}button{margin:2px 4px 2px 0}input[type=text]{width:22em;max-width:100%}
.x{display:inline-block;min-width:8em;font-weight:600}.HIT{color:var(--hit)}.MISS{color:var(--miss)}.STALE{color:var(--stale)}.BYPASS{color:var(--bypass)}.UNCACHEABLE{color:var(--unc)}
pre{margin:4px 0;white-space:pre-wrap;word-break:break-word}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px 16px}
.grid div{border-bottom:1px solid var(--line);padding:2px 0}.grid b{float:right;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Playground cache</h1>
<p><code>@kingsleyweb/bun-cache</code> on the playground's adapter: routes behind
<code>cacheResponse()</code> (<code>@kingsleyweb/bun-cache/http</code>), one cache you can move between drivers,
compression algorithms and an L1 tier, and its live <code>stats()</code>. Each route takes about 120 ms to build,
so a <span class="MISS">MISS</span> and a <span class="HIT">HIT</span> differ in time too. JSON: <a href="${base}/state">${base}/state</a>.</p>

<h2>The cache</h2>
<div id="config"></div>
<pre id="out-config"></pre>
<p class="muted" id="where"></p>

<h2>Cached routes</h2>
<table class="routes"><tr><th>Route</th><th>What it shows</th><th>Last answer</th></tr>
<tr><td><button data-get="/http/item/1">GET item/1</button><button data-get="/http/item/2">GET item/2</button><button data-get="/http/item/1?bypass=1">GET item/1?bypass</button></td>
<td>fresh 15 s, tagged <code>items</code> + <code>item:&lt;id&gt;</code>: MISS, then HIT with a growing <code>Age</code>; <code>?bypass</code> is BYPASS (no read, no store)</td><td id="out-item"></td></tr>
<tr><td><button data-post="/http/item/1">POST item/1</button></td>
<td>an unsafe method that succeeds drops every entry for its path (RFC 9111 §4.4): the next GET item/1 is a MISS</td><td id="out-post"></td></tr>
<tr><td><button data-get="/http/swr">GET swr</button></td>
<td>fresh 2 s, then STALE for 60 s while one background replay (through the adapter's <code>fetch()</code>) refreshes it: wait 2 s, GET (STALE, the old build), GET again (HIT, the new build)</td><td id="out-swr"></td></tr>
<tr><td><button data-get="/http/sie">GET sie</button><br><label><input type="checkbox" id="failing"> origin failing (503)</label></td>
<td>fresh 2 s, stale-if-error 60 s: GET, tick "failing", wait 2 s, GET: the 503 is replaced by the stale copy (STALE, 200); untick and GET: MISS</td><td id="out-sie"></td></tr>
<tr><td><button data-get="/http/private">GET private</button></td>
<td>answers <code>Cache-Control: private</code>: never stored, UNCACHEABLE every time (and not coalesced for 30 s: hit-for-miss)</td><td id="out-private"></td></tr>
<tr><td><button data-get="/http/big">GET big</button></td>
<td>about 64 KiB of text: compare <code>bytesWritten</code> below across compression settings (threshold 1 KiB)</td><td id="out-big"></td></tr>
</table>

<h2>Invalidate</h2>
<p><input type="text" id="path" value="${base}/http/item/1"> <button id="by-path">by path</button>
<span class="muted">every query and variant of the path, through its own tag (<code>middleware.invalidate(path)</code>)</span></p>
<p><input type="text" id="tag" value="item:1"> <button id="by-tag">by tag</button>
<button data-tag="items">tag items</button><button data-tag="item:2">tag item:2</button>
<span class="muted"><code>cache.invalidateTags([tag])</code></span></p>
<pre id="out-invalidate"></pre>

<h2>Counters</h2>
<p><button data-post="/fence">fence a load</button><span class="muted">a 300 ms <code>getOrSet</code> whose key is deleted at 100 ms: its write is dropped, a <code>fenced</code> event (reason <code>local</code>)</span><br>
<button data-post="/fill?count=100">fill 100</button><span class="muted">100 entries against the drivers' 64-entry cap: <code>evictions</code> (memory at once, the others on a sweep every 2 s, none on Redis)</span><br>
<button data-post="/reset">reset counters</button><span class="muted"><code>stats({ reset: true })</code></span></p>
<pre id="out-counters"></pre>
<div class="grid" id="stats"></div>
<h3>L1</h3>
<div class="grid" id="l1"></div>

<h2>History</h2>
<table id="history"><tr><th>When</th><th>Request</th><th>Status</th><th>X-Cache</th><th>Age</th><th>Time</th><th>Body</th></tr></table>

<h2>Drivers opened this run</h2>
<p class="muted">Each switch opens a new driver under a prefix naming this process and the opening; the old one is closed
and exactly its data removed. The playground removes the current one when it stops.</p>
<table id="openings"></table>

<script>
const base = ${JSON.stringify(base)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let state;

async function call(method, path, out) {
  const started = performance.now();
  const response = await fetch(base + path, { method });
  const ms = Math.round(performance.now() - started);
  const text = await response.text();
  const x = response.headers.get("x-cache") ?? "";
  const age = response.headers.get("age") ?? "";
  let summary = text;
  try {
    const body = JSON.parse(text);
    summary = JSON.stringify("lines" in body ? { ...body, lines: body.lines.length + " lines" } : body);
  } catch {}
  if (out) {
    $(out).innerHTML = (x ? '<span class="x ' + x + '">' + x + "</span>" : "") +
      response.status + (age ? " · Age " + age : "") + " · " + ms + " ms<br><span class=muted>" + esc(summary.slice(0, 160)) + "</span>";
  }
  const row = document.createElement("tr");
  row.innerHTML = "<td>" + new Date().toLocaleTimeString() + "</td><td>" + method + " " + esc(path) + "</td><td>" + response.status +
    '</td><td class="' + x + '">' + x + "</td><td>" + age + "</td><td>" + ms + " ms</td><td class=muted>" + esc(summary.slice(0, 90)) + "</td>";
  $("history").firstElementChild.after(row);
  while ($("history").rows.length > 30) $("history").deleteRow(-1);
  refresh();
  return { status: response.status, text };
}

const outFor = (path) => path.startsWith("/http/item") ? "out-item" : path.startsWith("/http/") ? "out-" + path.slice(6).split(/[/?]/)[0] : undefined;
document.querySelectorAll("[data-get]").forEach((b) => b.onclick = () => call("GET", b.dataset.get, outFor(b.dataset.get)));
document.querySelectorAll("[data-post]").forEach((b) => b.onclick = async () => {
  const path = b.dataset.post;
  const { text } = await call("POST", path, path.startsWith("/http/") ? "out-post" : undefined);
  if (!path.startsWith("/http/")) $("out-counters").textContent = text;
});
document.querySelectorAll("[data-tag]").forEach((b) => b.onclick = async () =>
  $("out-invalidate").textContent = (await call("POST", "/invalidate?tag=" + encodeURIComponent(b.dataset.tag))).text);
$("by-tag").onclick = async () =>
  $("out-invalidate").textContent = (await call("POST", "/invalidate?tag=" + encodeURIComponent($("tag").value))).text;
$("by-path").onclick = async () =>
  $("out-invalidate").textContent = (await call("POST", "/invalidate-path?path=" + encodeURIComponent($("path").value))).text;
$("failing").onchange = () => call("POST", "/sie?failing=" + $("failing").checked);

function renderConfig() {
  const drivers = state.drivers.map((d) => '<label title="' + esc(d.reason ?? d.variable ?? "") + '"' + (d.available ? "" : ' class="muted"') +
    '><input type="radio" name="driver" value="' + d.kind + '"' + (d.available ? "" : " disabled") + (d.kind === state.config.driver ? " checked" : "") +
    "> " + d.kind + (d.available ? "" : " (skipped: " + esc(d.reason) + ")") + "</label>").join("<br>");
  const compress = ["off", "zstd", "gzip", "br", "deflate"].map((c) =>
    "<option" + (c === state.config.compress ? " selected" : "") + ">" + c + "</option>").join("");
  $("config").innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:24px"><div>' + drivers + "</div><div>" +
    'compression <select id="compress">' + compress + "</select><br>" +
    '<label><input type="checkbox" id="l1"' + (state.config.l1 ? " checked" : "") + "> L1 tier</label><br>" +
    '<button id="apply">apply (a new cache, the old data removed)</button></div></div>';
  $("apply").onclick = async () => {
    const driver = document.querySelector("input[name=driver]:checked")?.value ?? state.config.driver;
    const { text } = await call("POST", "/config?driver=" + driver + "&compress=" + $("compress").value + "&l1=" + $("l1").checked);
    let body; try { body = JSON.parse(text); } catch {}
    await refresh();
    renderConfig();
    $("out-config").textContent = body?.error ?? "now " + body?.config?.driver + ", " + body?.config?.compress + ", L1 " + (body?.config?.l1 ? "on" : "off");
  };
}

function grid(values) {
  return Object.entries(values).filter(([, v]) => typeof v !== "object").map(([k, v]) =>
    "<div>" + k + " <b>" + (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : v) + "</b></div>").join("");
}

async function refresh() {
  state = await (await fetch(base + "/state")).json();
  if (!$("config").innerHTML) renderConfig();
  $("failing").checked = state.sieFailing;
  $("where").textContent = "Now: " + state.config.driver + " at " + state.driver.location + " · compression " + state.config.compress +
    " · L1 " + (state.config.l1 ? "on" : "off") + " · entry cap " + (state.driver.cap ?? "none");
  $("stats").innerHTML = grid(state.stats) + grid({ "load p50 ms": state.stats.loadDurations?.p50 ?? 0, "load p99 ms": state.stats.loadDurations?.p99 ?? 0 });
  $("l1").innerHTML = state.stats.l1 ? grid(state.stats.l1) : "<span class=muted>no L1 (switch it on above)</span>";
  $("openings").innerHTML = "<tr><th>Driver</th><th>Where</th><th></th></tr>" + state.openings.map((o) =>
    "<tr><td>" + o.kind + "</td><td>" + esc(o.location) + "</td><td>" + (o.current ? "current" : "closed, " + (o.removed ?? 0) + " removed") + "</td></tr>").join("");
}
refresh();
setInterval(refresh, 1000);
</script>
</body></html>`;
}
