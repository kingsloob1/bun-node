// Spike 2: React 19 server-rendering behaviour on Bun that the engine's design
// rests on: doctype, <title>/<meta>/<link> hoisting, async components, use(),
// errors in and after the shell, nonce, bootstrap scripts, abort, escaping.
//
//   NODE_ENV=production bun react19.tsx
import { Suspense, use } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
function show(label: string, value: unknown) {
  console.log(`- ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
const later = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function Doc({ children, head }: { children?: React.ReactNode; head?: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {head}
      </head>
      <body>{children}</body>
    </html>
  );
}
function DeepHead() {
  return (
    <section>
      <title>Deep title</title>
      <meta name="description" content="from deep in the tree" />
      <link rel="stylesheet" href="/a.css" precedence="default" />
      <p>body text</p>
    </section>
  );
}

console.log(`bun ${Bun.version}, NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);

console.log("\n## Doctype");
show("renderToString(<html>) starts with", renderToString(<Doc />).slice(0, 30));
show("renderToReadableStream(<html>) starts with", (await text(await renderToReadableStream(<Doc />))).slice(0, 30));
show("renderToReadableStream(<div>) starts with", (await text(await renderToReadableStream(<div>x</div>))).slice(0, 30));

console.log("\n## Hoisting <title>, <meta>, <link precedence> from deep in the tree");
{
  const doc = await text(await renderToReadableStream(<Doc><DeepHead /></Doc>));
  const head = doc.slice(doc.indexOf("<head>"), doc.indexOf("</head>"));
  show("whole document, stream: <title> inside <head>", head.includes("<title>Deep title</title>"));
  show("whole document, stream: <meta description> inside <head>", head.includes('name="description"'));
  show("whole document, stream: stylesheet <link> inside <head>", head.includes('href="/a.css"'));
  const s = renderToString(<Doc><DeepHead /></Doc>);
  const sHead = s.slice(s.indexOf("<head>"), s.indexOf("</head>"));
  show("whole document, renderToString: <title> inside <head>", sHead.includes("<title>Deep title</title>"));
  const frag = renderToString(<DeepHead />);
  show("fragment (no <html>), renderToString output", frag);
}

console.log("\n## Async function components (no RSC)");
{
  async function AsyncComp() {
    await later(5, null);
    return <p>async component resolved</p>;
  }
  const errors: string[] = [];
  try {
    const html = await text(
      await renderToReadableStream(
        <Suspense fallback={<p>fallback</p>}>
          <AsyncComp />
        </Suspense>,
        { onError: (e) => void errors.push(String(e)) },
      ),
    );
    show("stream output", html.slice(0, 300));
  } catch (e) {
    show("stream threw", String(e));
  }
  show("onError calls", errors);
  try {
    show("renderToString output", renderToString(<Suspense fallback={<p>fallback</p>}><AsyncComp /></Suspense>));
  } catch (e) {
    show("renderToString threw", String(e));
  }
}

console.log("\n## use(promise) inside Suspense");
{
  function Reader({ p }: { p: Promise<string> }) {
    return <b>{use(p)}</b>;
  }
  const html = await text(await renderToReadableStream(<Suspense fallback={<i>wait</i>}><Reader p={later(10, "data!")} /></Suspense>));
  show("stream resolves the data", html.includes("data!"));
  // A promise created during render (no cache) re-suspends forever? Bounded by abort.
  function Uncached() {
    return <b>{use(later(5, "fresh"))}</b>;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("gave up after 500 ms")), 500);
  const errors: string[] = [];
  const t0 = performance.now();
  const out = await text(await renderToReadableStream(<Suspense fallback={<i>wait</i>}><Uncached /></Suspense>, { signal: controller.signal, onError: (e) => void errors.push(String(e)) }));
  clearTimeout(timer);
  show(`a promise created in render: finished in ${(performance.now() - t0).toFixed(0)} ms, resolved`, out.includes("fresh"));
  show("its onError", errors.slice(0, 2));
}

console.log("\n## Errors");
{
  function Boom(): React.ReactNode {
    throw new Error("boom in render");
  }
  // In the shell: the promise rejects, nothing has been sent.
  const errors: string[] = [];
  try {
    await renderToReadableStream(<Doc><Boom /></Doc>, { onError: (e) => void errors.push(String(e)) });
    show("shell error: resolved (unexpected)", true);
  } catch (e) {
    show("shell error: renderToReadableStream rejects with", String(e));
  }
  show("shell error: onError calls", errors);
  try {
    renderToString(<Boom />);
  } catch (e) {
    show("renderToString throws", String(e));
  }

  // Inside a Suspense boundary: the shell succeeds; the boundary falls back to client rendering.
  const errors2: string[] = [];
  const stream = await renderToReadableStream(
    <Doc>
      <p>before</p>
      <Suspense fallback={<p>loading</p>}>
        <Boom />
      </Suspense>
    </Doc>,
    { onError: (e) => { errors2.push(String(e)); return "digest-123"; } },
  );
  const html = await text(stream);
  show("boundary error: shell resolved, onError calls", errors2);
  show("boundary error: output has fallback + client-render marker (data-dgst)", { fallback: html.includes("loading"), dgst: html.includes("digest-123"), message: html.includes("boom in render") });

  // After the shell, a delayed boundary throws: the response is already streaming.
  function LateBoom({ p }: { p: Promise<string> }): React.ReactNode {
    use(p);
    throw new Error("late boom");
  }
  const errors3: string[] = [];
  const late = await renderToReadableStream(
    <Doc><Suspense fallback={<p>late loading</p>}><LateBoom p={later(20, "x")} /></Suspense></Doc>,
    { onError: (e) => void errors3.push(String(e)) },
  );
  const lateHtml = await text(late);
  show("late boundary error: onError", errors3);
  show("late boundary error: stream ended normally with fallback kept", lateHtml.includes("late loading") && lateHtml.endsWith("</html>"));
}

console.log("\n## nonce and bootstrap scripts");
{
  function R({ p }: { p: Promise<string> }) {
    return <b>{use(p)}</b>;
  }
  const html = await text(
    await renderToReadableStream(
      <Doc><Suspense fallback={<i>w</i>}><R p={later(10, "v")} /></Suspense></Doc>,
      { nonce: "NONCE123", bootstrapModules: ["/assets/page-abc.js"], bootstrapScriptContent: "window.__P=1" },
    ),
  );
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  show("every <script> tag carries the nonce", scripts.every((tag) => tag.includes('nonce="NONCE123"')));
  show("script tags", scripts);
  show("modulepreload link emitted", /<link rel="modulepreload"[^>]*page-abc/.test(html));
}

console.log("\n## Abort (a deadline)");
{
  function Never() {
    use(new Promise<never>(() => {}));
    return null;
  }
  const controller = new AbortController();
  const errors: string[] = [];
  const t0 = performance.now();
  const stream = await renderToReadableStream(
    <Doc><Suspense fallback={<p>never fallback</p>}><Never /></Suspense></Doc>,
    { signal: controller.signal, onError: (e) => void errors.push(String(e)) },
  );
  setTimeout(() => controller.abort(new Error("render deadline 100 ms")), 100);
  const html = await text(stream);
  show(`aborted after ${(performance.now() - t0).toFixed(0)} ms; stream ended with </html>`, html.endsWith("</html>"));
  show("onError", errors);
}

console.log("\n## Escaping");
{
  const evil = `</script><script>alert(1)</script>"'&`;
  const html = renderToString(<div title={evil}>{evil}</div>);
  show("text and attribute escaped", html);
}
