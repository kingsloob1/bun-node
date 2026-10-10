// Spike 6: a React engine on the Express view-engine contract, exercised by
// real Express 5 running on Bun: app.engine(ext, fn(path, options, cb)),
// app.set("views"), app.set("view engine"), res.render(view, locals, cb).
// What the engine receives in `options`, what Express does with a view name
// that climbs out of the views directory, a missing engine, directory index
// lookup, and .tsx beside .jsx.
//
//   NODE_ENV=production bun express-contract.ts [scratch-dir]
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), "react-views-contract-"));
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "views", "users"), { recursive: true });
symlinkSync(join(import.meta.dir, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "views", "Hello.tsx"), `export default function Hello({ name }: { name: string }) { return <p>Hello {name}</p>; }\n`);
writeFileSync(join(root, "views", "users", "index.tsx"), `export default function Users() { return <ul><li>users index</li></ul>; }\n`);
writeFileSync(join(root, "views", "Legacy.jsx"), `export default function Legacy() { return <p>legacy jsx</p>; }\n`);
writeFileSync(join(root, "views", "Named.tsx"), `export function Named() { return <p>named only</p>; }\n`);
writeFileSync(join(root, "Secret.tsx"), `export default function Secret() { return <p>outside the views directory</p>; }\n`);

const seen: Record<string, unknown>[] = [];
/** The engine: Express's contract, nothing more. */
function reactEngine(path: string, options: Record<string, unknown>, callback: (err: Error | null, html?: string) => void) {
  seen.push(options);
  import(path)
    .then((mod: Record<string, unknown>) => {
      const Component = mod.default as React.ComponentType<Record<string, unknown>> | undefined;
      if (typeof Component !== "function") throw new TypeError(`${path} has no default export`);
      const { settings: _s, _locals: _l, cache: _c, ...props } = options;
      callback(null, renderToString(h(Component, props)));
    })
    .catch((error: Error) => callback(error));
}

const app = express();
app.set("views", join(root, "views"));
app.engine("tsx", reactEngine);
app.engine("jsx", reactEngine);
app.set("view engine", "tsx");
app.locals.appName = "From app.locals";
app.get("/hello", (_req, res) => {
  res.locals.user = "from res.locals";
  res.render("Hello", { name: "World" });
});
app.get("/dir", (_req, res) => res.render("users"));
app.get("/jsx", (_req, res) => res.render("Legacy.jsx"));
app.get("/jsx-noext", (_req, res) => res.render("Legacy"));
app.get("/named", (_req, res) => res.render("Named"));
app.get("/climb", (req, res) => res.render(String(req.query.view)));
app.get("/cb", (_req, res) => res.render("Hello", { name: "cb" }, (err, html) => res.send(err ? `err ${err.message}` : `[${html}]`)));
const noEngine = express();
noEngine.set("views", join(root, "views"));
noEngine.set("view engine", "tsx");
noEngine.get("/", (_req, res) => res.render("Hello"));
noEngine.use(((err, _req, res, _next) => res.status(500).send(`error: ${err.message}`)) as express.ErrorRequestHandler);
app.use(((err, _req, res, _next) => res.status(500).send(`error: ${err.message}`)) as express.ErrorRequestHandler);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const server2 = noEngine.listen(0, "127.0.0.1");
await new Promise((r) => server2.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = async (url: string) => {
  const r = await fetch(url);
  return `${r.status} ${JSON.stringify((await r.text()).slice(0, 120))}`;
};
console.log(`bun ${Bun.version}, express ${(await import("express/package.json")).version}`);
console.log(`- res.render("Hello", { name }): ${await get(`${base}/hello`)}`);
const opts = seen.at(-1)!;
console.log(`- keys of the options the engine received: ${JSON.stringify(Object.keys(opts))}`);
console.log(`- options.cache under NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}: ${String(opts.cache)}; settings keys include: ${JSON.stringify(Object.keys(opts.settings as object).filter((k) => /view/.test(k)))}`);
console.log(`- res.render("users") (directory): ${await get(`${base}/dir`)}`);
console.log(`- res.render("Legacy.jsx") with an engine registered for jsx: ${await get(`${base}/jsx`)}`);
console.log(`- res.render("Legacy") with view engine tsx: ${await get(`${base}/jsx-noext`)}`);
console.log(`- res.render("Named") (no default export): ${await get(`${base}/named`)}`);
console.log(`- res.render("../Secret") (climbs out of views): ${await get(`${base}/climb?view=../Secret`)}`);
console.log(`- res.render("${join(root, "Secret")}") (absolute): ${await get(`${base}/climb?view=${encodeURIComponent(join(root, "Secret"))}`)}`);
console.log(`- res.render(view, locals, callback): ${await get(`${base}/cb`)}`);
console.log(`- view engine "tsx" with no app.engine("tsx"): ${await get(`http://127.0.0.1:${(server2.address() as { port: number }).port}/`)}`);
server.close();
server2.close();
rmSync(root, { recursive: true, force: true });
