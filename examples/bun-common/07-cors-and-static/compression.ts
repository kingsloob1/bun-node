/**
 * Response compression — `compression()`, a port of the `compression`
 * package (1.8) with `zstd` and Compression Dictionary Transport added, and
 * precompressed static files.
 *
 * ```bash
 * bun 07-cors-and-static/compression.ts
 * ```
 *
 * | option            | default                                   |
 * |-------------------|-------------------------------------------|
 * | `threshold`       | `"1kb"`                                   |
 * | `filter`          | `shouldCompress` — compressible types     |
 * | `encodings`       | `["br", "zstd", "gzip", "deflate"]`       |
 * | `enforceEncoding` | `"identity"` — no header, no compression  |
 * | `asyncThreshold`  | `"64kb"` — larger bodies off the event loop |
 * | `brotli`          | quality 4                                 |
 * | `zstd`            | level 3                                   |
 * | `dictionaries`    | none — `dcb`/`dcz` are never produced     |
 *
 * A few things worth knowing before reading it:
 *
 * - Register it ahead of the routes: `router.use(compression())`. It compresses
 *   whatever the route produces — `json`, `send`, `sendFile`, a stream.
 * - `Vary: Accept-Encoding` is added whenever compression was considered,
 *   even when the body stays as it is (too small, or identity negotiated).
 * - `router.fetch()` resolves the bytes exactly as sent. A real `fetch()`
 *   decompresses them for you unless you pass `decompress: false`.
 */
import type { CompressionOptions } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  createGunzip,
  gunzipSync,
  gzipSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  BunHttpAdapter,
  BunRouter,
  compression,
  compressionDictionaryHash,
  createServeStaticHandler,
  formatUseAsDictionary,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Response compression");

/** A catalogue big enough to be worth compressing. */
const products = Array.from({ length: 200 }, (_, id) => ({
  id,
  name: `Product ${id}`,
  price: (id * 37) % 1000,
  inStock: id % 3 !== 0,
}));

/** A small API behind `compression(options)`. */
function api(options?: CompressionOptions): BunRouter {
  const router = new BunRouter();
  router.use(compression(options));
  router.all("/products", (_req, res) => {
    res.json(products);
  });
  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/logo.png", (_req, res) => {
    res.type("png").send(Buffer.alloc(4096, 1));
  });
  router.get("/private", (_req, res) => {
    res.setHeader("Cache-Control", "private, no-transform");
    res.json(products);
  });
  return router;
}

/** The headers that matter here, and the size on the wire. */
async function view(response: Response): Promise<Record<string, unknown>> {
  return {
    status: response.status,
    "content-encoding": response.headers.get("content-encoding"),
    vary: response.headers.get("vary"),
    bytes: (await response.bytes()).length,
  };
}

/** `RequestInit` with an `Accept-Encoding` header, or none. */
function accepting(value?: string, method = "GET"): RequestInit {
  return {
    method,
    headers: value === undefined ? {} : { "accept-encoding": value },
  };
}

/* ------------------------------------------------------------------ */
step("Negotiation — the client's q-values first, then the server's order");

const shop = api();
show("uncompressed JSON is", JSON.stringify(products).length);
for (const accept of [
  "gzip",
  "gzip, deflate, br, zstd",
  "gzip;q=1, br;q=0.5",
  "br;q=0, *",
  "identity",
  undefined,
]) {
  show(
    `Accept-Encoding: ${accept ?? "(none)"}`,
    await view(await shop.fetch("/products", accepting(accept))),
  );
}

/* ------------------------------------------------------------------ */
step("Left alone: a small body, an incompressible type, no-transform, HEAD");

show(
  "a tiny JSON body — under threshold, still Vary",
  await view(await shop.fetch("/health", accepting("gzip"))),
);
show(
  "image/png — the filter says no, so no Vary either",
  await view(await shop.fetch("/logo.png", accepting("gzip"))),
);
show(
  "Cache-Control: no-transform",
  await view(await shop.fetch("/private", accepting("gzip"))),
);
show(
  "HEAD — headers only",
  await view(await shop.fetch("/products", accepting("gzip", "HEAD"))),
);

/* ------------------------------------------------------------------ */
step("Options: threshold, an encoding order with a wildcard, zstd level");

const eager = api({
  threshold: 0,
  encodings: ["zstd", "*"],
  zstd: { params: { [constants.ZSTD_c_compressionLevel]: 19 } },
});
show(
  "threshold: 0 compresses even the tiny body",
  await view(await eager.fetch("/health", accepting("gzip"))),
);
show(
  'encodings: ["zstd", "*"] — zstd wins a tie',
  await view(await eager.fetch("/products", accepting("br, gzip, zstd"))),
);
show(
  "…and the wildcard still offers br",
  await view(await eager.fetch("/products", accepting("br, gzip"))),
);

const gzipped = await shop.fetch("/products", accepting("gzip"));
const decoded = JSON.parse(
  gunzipSync(await gzipped.bytes()).toString(),
) as unknown[];
show("gunzip gives the catalogue back", `${decoded.length} products`);

/* ------------------------------------------------------------------ */
step("Server-sent events — each event is flushed through the compressor");

const live = new BunHttpAdapter();
live.use(compression());
live.get("/ticks", (_req, res) => {
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    res.write(`data: tick ${tick}\n\n`);
    if (tick === 3) {
      clearInterval(timer);
      void res.end();
    }
  }, 30);
});
await live.listen(0);
try {
  const response = await fetch(`${live.url}/ticks`, {
    headers: { "accept-encoding": "gzip" },
    decompress: false,
  });
  show("headers", {
    "content-type": response.headers.get("content-type"),
    "content-encoding": response.headers.get("content-encoding"),
  });
  const gunzip = createGunzip();
  gunzip.on("data", (chunk: Buffer) => {
    show("decoded as it arrived", JSON.stringify(chunk.toString()));
  });
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    gunzip.write(chunk);
  }
  await Bun.sleep(20);
} finally {
  await live.close();
}

/* ------------------------------------------------------------------ */
step("Static files — a precompressed sibling, or compression on the fly");

const dir = await mkdtemp(join(tmpdir(), "bun-common-compression-"));
const script = `export const products = ${JSON.stringify(products)};\n`;
await writeFile(join(dir, "app.js"), script);
await writeFile(join(dir, "app.js.br"), brotliCompressSync(script));
await writeFile(join(dir, "app.js.gz"), gzipSync(script, { level: 9 }));
await writeFile(join(dir, "styles.css"), `.product{color:red}\n`.repeat(100));

const assets = new BunRouter();
const { prefix, handler } = createServeStaticHandler(dir, {
  prefix: "/assets",
  precompressed: true,
});
assets.get(`${prefix}/*`, handler);

/** A static response's encoding, type, length and validator. */
async function file(
  path: string,
  accept: string,
): Promise<Record<string, unknown>> {
  const response = await assets.fetch(path, accepting(accept));
  return {
    "content-encoding": response.headers.get("content-encoding"),
    "content-type": response.headers.get("content-type"),
    "content-length": response.headers.get("content-length"),
    etag: response.headers.get("etag"),
    bytes: (await response.bytes()).length,
  };
}

show(
  "app.js, br accepted — app.js.br as it is on disk",
  await file("/assets/app.js", "gzip, br"),
);
show(
  "app.js, gzip only — app.js.gz, with its own ETag",
  await file("/assets/app.js", "gzip"),
);
show(
  "styles.css has no sibling — compressed on the fly",
  await file("/assets/styles.css", "gzip"),
);
show(
  "app.js.gz requested by name — just a file",
  await file("/assets/app.js.gz", "gzip"),
);
await rm(dir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("Compression dictionaries (RFC 9842) — dcb and dcz");

// Version 1 of the catalogue is what the client already has; version 2
// differs in a few prices, so compressed against v1 it is nearly free.
const v1 = JSON.stringify(products);
const v2 = JSON.stringify(
  products.map((product) =>
    product.id % 50 === 0 ? { ...product, price: product.price + 1 } : product,
  ),
);
const dictionary = Buffer.from(v1);

const versioned = new BunRouter();
versioned.use(compression({ dictionaries: [dictionary] }));
versioned.get("/catalogue.v1.json", (_req, res) => {
  // Tells the browser to keep this response as a dictionary for later requests.
  res.setHeader(
    "Use-As-Dictionary",
    formatUseAsDictionary({ match: "/catalogue.*.json", id: "catalogue-v1" }),
  );
  res.type("json").send(v1);
});
versioned.get("/catalogue.v2.json", (_req, res) => {
  res.type("json").send(v2);
});

const advertised = await versioned.fetch("/catalogue.v1.json");
show(
  "the dictionary response advertises itself",
  advertised.headers.get("use-as-dictionary"),
);

// What a browser holding v1 sends for v2.
const withDictionary = {
  "accept-encoding": "gzip, br, zstd, dcb, dcz",
  "available-dictionary": `:${compressionDictionaryHash(dictionary).toString("base64")}:`,
};
show(
  "br without a dictionary",
  await view(await versioned.fetch("/catalogue.v2.json", accepting("br"))),
);

// dcz is preferred by default: preparing a zstd dictionary is far cheaper.
const dcz = await versioned.fetch("/catalogue.v2.json", {
  headers: withDictionary,
});
const dczBytes = await dcz.bytes();
show("dcz against v1 (the default preference)", {
  "content-encoding": dcz.headers.get("content-encoding"),
  vary: dcz.headers.get("vary"),
  bytes: dczBytes.length,
});
// The body is a 40-byte header (magic number, dictionary SHA-256), then zstd.
const fromDcz = zstdDecompressSync(dczBytes.subarray(40), {
  dictionary,
} as Parameters<typeof zstdDecompressSync>[1]);
show("…decoded with the dictionary equals v2", fromDcz.toString() === v2);

const brotliFirst = new BunRouter();
brotliFirst.use(
  compression({ dictionaries: [dictionary], dictionaryEncodings: ["dcb"] }),
);
brotliFirst.get("/catalogue.v2.json", (_req, res) => {
  res.type("json").send(v2);
});
const dcb = await brotliFirst.fetch("/catalogue.v2.json", {
  headers: withDictionary,
});
const dcbBytes = await dcb.bytes();
show('dictionaryEncodings: ["dcb"] — brotli against v1', {
  "content-encoding": dcb.headers.get("content-encoding"),
  bytes: dcbBytes.length,
});
// A 36-byte header, then brotli.
const fromDcb = brotliDecompressSync(dcbBytes.subarray(36), {
  dictionary,
} as Parameters<typeof brotliDecompressSync>[1]);
show("…decoded with the dictionary equals v2", fromDcb.toString() === v2);
