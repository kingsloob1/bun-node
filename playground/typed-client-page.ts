/**
 * The typed-client section's page (`GET /playground/client`,
 * `typed-client.ts`): plain HTML and a little inline script that reads the
 * section's `/state` (the documents, the generated module, the scenarios
 * with their code) and drives its routes with `fetch`: a scenario per
 * button, the regenerate button and the "add a route" button. Like the
 * cache lab's page, it is a string: nothing to build. The typed client
 * itself runs on the server; the page shows what it sent and answered.
 */

/** The page, its routes under `base`. */
export function typedClientPage(base: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playground typed client</title>
<style>
:root{--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--line:#8884;--ok:#1a7f37;--bad:#cf222e;--add:#1a7f3722;--del:#cf222e22}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#161616;--muted:#a1a1a6;--ok:#3fb950;--bad:#f85149;--add:#3fb95033;--del:#f8514933}}
body{font:14px system-ui,sans-serif;margin:16px;max-width:1200px;color:var(--fg);background:var(--bg)}
h2{margin-top:28px}p{max-width:85ch}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
pre{margin:4px 0;white-space:pre-wrap;word-break:break-word;font-size:12px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:8px 16px}
.pair pre,.box{border:1px solid var(--line);padding:8px;max-height:32em;overflow:auto}
.scenario{border-top:1px solid var(--line);padding:8px 0;display:grid;grid-template-columns:minmax(260px,1fr) minmax(300px,1.3fr);gap:8px 16px}
.scenario h3{margin:0 0 4px;font-size:15px}.scenario pre.code{border-left:3px solid var(--line);padding-left:8px}
table{border-collapse:collapse;font-size:12px}td,th{padding:2px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.d-add{background:var(--add)}.d-del{background:var(--del)}.d-skip{color:var(--muted)}
code.cmd{display:block;padding:6px 8px;border:1px solid var(--line);margin:4px 0;white-space:pre-wrap;word-break:break-all}
</style></head><body>
<h1>Playground typed client</h1>
<p><code>@kingsleyweb/bun-client</code> against a small API mounted here (<code>playground/typed-client-api.ts</code>,
at <code>${base}/api</code>): its route map is generated from the API's OpenAPI document by
<code>bun-client generate</code> and committed (<code>typed-client-api.gen.ts</code>, with the zod schemas in
<code>typed-client-api.zod.gen.ts</code>). Every call below runs on the server through
<code>createClient&lt;Routes&gt;({ manifest, schemas })</code> over the adapter's socket-free <code>fetch()</code>; the code
shown is the code that runs, type assertions included (the playground's type check holds them).
JSON: <a href="${base}/state">${base}/state</a>.</p>

<h2>The generated module</h2>
<p id="summary"></p>
<div id="commands"></div>
<div class="pair">
<div><h3>OpenAPI document (what the generator reads)</h3><pre id="openapi"></pre></div>
<div><h3>typed-client-api.gen.ts (what it wrote)</h3><pre id="gen"></pre></div>
</div>
<details><summary>typed-client-api.zod.gen.ts (the runtime schemas, <code>--zod</code>)</summary><pre class="box" id="zod"></pre></details>

<h2>Regenerate</h2>
<p><button id="regenerate">regenerate</button>
<span class="muted"><code>runCli()</code> in process against the dev endpoint, the step <code>bun-client watch</code> runs on every change,
and the diff against the committed file; beside it, <code>generate --module … --check</code>, the CI form.</span></p>
<p id="regen-summary"></p>
<pre class="box" id="diff" hidden></pre>

<h2>Watch it</h2>
<p>bun-common's <code>devTypes()</code> serves this API's documents at <code>${base}/__bun/types</code> (development only,
loopback peers only, behind a bearer token in its token file), with a change channel at <code>…/ws</code>. Point the
watcher at the running playground:</p>
<div id="watch"></div>
<p><button id="drift">add a route</button>
<span class="muted">mounts <code>GET /api/users/:id/badge</code> now: the endpoint's hash moves, a running watcher rewrites its file,
and "regenerate" shows the diff. The committed file stays fresh against the code (<code>--check</code> exits 0); a restart
forgets the route.</span></p>
<p id="drift-out"></p>

<h2>Calls</h2>
<div id="calls"></div>
<h2>Validation</h2>
<p class="muted">On in development, off in production; the section sets <code>mode: "development"</code> so it always shows.</p>
<div id="validation"></div>
<h2>The query layer (<code>./query</code>)</h2>
<p class="muted">Each run uses a fresh <code>QueryClient</code> (<code>staleTime: Infinity</code>, so only an invalidation or
an explicit <code>staleTime: 0</code> refetches).</p>
<div id="query"></div>

<script>
const base = ${JSON.stringify(base)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = (v) => JSON.stringify(v, null, 2);

function table(rows, cols) {
  if (!rows.length) return '<span class="muted">none</span>';
  return "<table><tr>" + cols.map((c) => "<th>" + c + "</th>").join("") + "</tr>" + rows.map((r) =>
    "<tr>" + cols.map((c) => "<td>" + esc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c] ?? "") + "</td>").join("") + "</tr>").join("") + "</table>";
}

function showRun(name, run) {
  const out = $("out-" + name);
  out.innerHTML = '<b class="' + (run.ok ? "ok" : "bad") + '">' + (run.ok ? "ran" : "failed") + "</b> in " + run.ms + " ms" +
    "<pre>" + esc(json(run.outcome)) + "</pre>" +
    "<div><b>sent</b> (at the client's fetch)" + table(run.sent, ["at", "method", "url", "headers", "status", "response"]) + "</div>" +
    "<div><b>the server saw</b>" + table(run.server, ["at", "method", "url", "requestId", "ifNoneMatch"]) + "</div>" +
    (run.warnings.length ? "<div><b>client warnings</b><pre>" + esc(run.warnings.join("\\n")) + "</pre></div>" : "");
}

function renderScenarios(scenarios) {
  for (const section of ["calls", "validation", "query"]) {
    $(section).innerHTML = scenarios.filter((s) => s.section === section).map((s) =>
      '<div class="scenario"><div><h3>' + esc(s.title) + '</h3><p class="muted">' + esc(s.about) + "</p>" +
      '<button data-run="' + s.name + '">run</button><pre class="code">' + esc(s.snippet) + "</pre></div>" +
      '<div id="out-' + s.name + '" class="muted">not run yet</div></div>').join("");
  }
  document.querySelectorAll("[data-run]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const response = await fetch(base + "/run/" + b.dataset.run, { method: "POST" });
      showRun(b.dataset.run, await response.json());
    } finally { b.disabled = false; }
  });
}

function renderState(state) {
  const g = state.generated;
  $("summary").innerHTML = "typesHash <code>" + esc(g.hash) + "</code> · " +
    (g.warnings.length ? "warnings: " + g.warnings.map(esc).join("; ") : "no warnings in the header") +
    " · the document's own: " + (state.openapi.warnings.length ? state.openapi.warnings.map((w) => esc(w.message)).join("; ") : "none") +
    " · dev endpoint " + (state.dev.enabled ? "on" : "off (NODE_ENV=production)") + (state.dev.drifted ? " · the extra route is mounted" : "");
  $("commands").innerHTML = '<code class="cmd">' + esc(state.commands.generate) + '</code><code class="cmd">' + esc(state.commands.check) + "</code>";
  $("openapi").textContent = json(state.openapi.document);
  $("gen").textContent = g.code;
  $("zod").textContent = g.zod;
  $("watch").innerHTML = state.commands.watch
    ? '<code class="cmd">' + esc(state.commands.watch) + '</code><p class="muted">The token file holds the URL and the token; the token is never shown here.</p>'
    : '<p class="muted">The dev endpoint is off (or not listening yet).</p>';
}

async function refresh() {
  const state = await (await fetch(base + "/state")).json();
  renderState(state);
  return state;
}

$("regenerate").onclick = async () => {
  const r = await (await fetch(base + "/regenerate", { method: "POST" })).json();
  $("regen-summary").innerHTML = "from the " + esc(r.source) + ": exit " + r.generate.exit + ", typesHash <code>" + esc(r.generate.hash) +
    "</code> (committed <code>" + esc(r.committedHash) + "</code>) · " +
    (r.same ? '<span class="ok">identical to the committed file</span>' : '<span class="bad">differs from the committed file</span>') +
    " · <code>--check</code> exit " + r.check.exit + " " + (r.check.exit === 0 ? '<span class="ok">(fresh)</span>' : '<span class="bad">(stale)</span>') +
    (r.generate.stderr ? "<pre>" + esc(r.generate.stderr) + "</pre>" : "");
  $("diff").hidden = r.diff.length === 0;
  $("diff").innerHTML = r.diff.map((l) => l.op === "…"
    ? '<span class="d-skip">… ' + l.text + " unchanged lines</span>"
    : '<span class="' + (l.op === "+" ? "d-add" : l.op === "-" ? "d-del" : "") + '">' + l.op + " " + esc(l.text) + "</span>").join("\\n");
};

$("drift").onclick = async () => {
  const r = await (await fetch(base + "/drift", { method: "POST" })).json();
  $("drift-out").textContent = "mounted " + r.route + "; press regenerate to see the diff";
  refresh();
};

refresh().then((state) => renderScenarios(state.scenarios));
</script>
</body></html>`;
}
