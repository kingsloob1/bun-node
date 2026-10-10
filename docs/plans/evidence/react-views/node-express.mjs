// The comparator: the same view (views/catalog.js) on Express 5 under Node
// (or under Bun: `bun node-express.mjs`). Prints `PORT n`.
//
//   NODE_ENV=production node node-express.mjs
//
// /engine is the Express engine contract: app.engine(ext, fn(path, options, cb))
// with renderToString, through res.render — what a React engine on Express does.
import express from "express";
import { createElement as h } from "react";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import { CatalogDocument, makeItems } from "./views/catalog.js";

const items = makeItems(200);
const app = express();
app.set("etag", false); // bun-common sends no ETag by default; compare like with like
app.set("x-powered-by", false);
app.set("views", new URL("./views", import.meta.url).pathname);
app.engine("js", (path, options, callback) => {
  import(path)
    .then((mod) => callback(null, `<!DOCTYPE html>${renderToString(h(mod.CatalogDocument, options))}`))
    .catch(callback);
});
app.set("view engine", "js");

app.get("/string", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>${renderToString(h(CatalogDocument, { title: "Catalogue", items }))}`);
});
app.get("/engine", (_req, res) => {
  res.render("catalog", { title: "Catalogue", items });
});
app.get("/stream", (_req, res) => {
  const { pipe } = renderToPipeableStream(h(CatalogDocument, { title: "Catalogue", items }), {
    onShellReady() {
      res.status(200).type("html");
      pipe(res);
    },
    onShellError(error) {
      res.status(500).send(String(error));
    },
  });
});
const server = app.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${server.address().port}`);
});
process.on("SIGTERM", () => process.exit(0));
