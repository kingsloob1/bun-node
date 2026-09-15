/**
 * Errors, XML and files — flattening errors to cross a boundary, parsing XML
 * bodies, and the small filesystem and stream helpers.
 *
 * ```bash
 * bun 11-utilities/errors-xml-files.ts
 * ```
 *
 * The points worth knowing:
 *
 * - **An `Error` does not survive `JSON.stringify`** — it becomes `{}`.
 *   `serializeError` flattens one (name, message, stack, `code`, the `cause`
 *   chain, extra properties) and `deserializeError` rebuilds a real `Error`
 *   with the original *name*; the original *class* cannot cross a process.
 * - **A thrown non-Error is kept, not dropped**: it becomes `NonError`.
 * - **`parseXmlToObject` coerces by default.** `"007"` becomes `7` and
 *   `"0x1F"` becomes `31`; pass `parsePrimitives: false` for identifiers,
 *   postcodes and anything else that only looks numeric.
 * - `streamToBuffer` is not `async`: a stream that is not readable throws
 *   synchronously rather than returning a rejected promise.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  coerceXmlPrimitive,
  decodeXmlEntities,
  deserializeError,
  getUniqueFilename,
  isXmlWhitespace,
  parseXmlToObject,
  pathExists,
  randomBytes,
  serializeError,
  streamToBuffer,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Errors, XML and files");

/* ------------------------------------------------------------------ */
step("serializeError: an error, ready for JSON");

/** A domain error with a code and extra context, as a job might throw. */
class PaymentError extends Error {
  /** A machine-readable code. */
  code = "CARD_DECLINED";
  /** Extra context, kept under `data`. */
  orderId = "ord_123";
}

const root = new Error("connection reset");
const failure = new PaymentError("charge failed", { cause: root });
failure.name = "PaymentError";

show("JSON.stringify loses it", JSON.stringify(failure));
const flat = serializeError(failure);
show("serializeError keeps it", {
  ...flat,
  stack: `${flat.stack?.split("\n")[0]} …`,
});

const wire = JSON.parse(JSON.stringify(flat)) as typeof flat;
const rebuilt = deserializeError(wire);
show("deserializeError rebuilds a real Error", {
  isError: rebuilt instanceof Error,
  isPaymentError: rebuilt instanceof PaymentError,
  name: rebuilt.name,
  message: rebuilt.message,
  code: (rebuilt as Error & { code?: string }).code,
  orderId: (rebuilt as Error & { orderId?: string }).orderId,
  cause: (rebuilt.cause as Error).message,
});

show("non-errors become NonError", [
  serializeError("a string"),
  serializeError(404),
  serializeError({ reason: "x" }),
  serializeError(undefined),
]);

/** A chain six causes deep. */
let deep: Error = new Error("level 6");
for (let level = 5; level >= 0; level--) {
  deep = new Error(`level ${level}`, { cause: deep });
}
/** How many `cause` levels a serialised error kept. */
function depthOf(error: ReturnType<typeof serializeError>): number {
  return error.cause ? 1 + depthOf(error.cause) : 0;
}
show("maxDepth: causes followed (default 5, then 1)", [
  depthOf(serializeError(deep)),
  depthOf(serializeError(deep, { maxDepth: 1 })),
]);

const noisy = new Error("deep stack");
noisy.stack = `Error: deep stack\n${"    at frame\n".repeat(50)}`;
show("maxStackBytes: 60", serializeError(noisy, { maxStackBytes: 60 }).stack);

const extras = Object.assign(new Error("with extras"), {
  when: new Date(0),
  big: 10n, // not JSON: omitted
  retry: () => {}, // not JSON: omitted
});
show("data keeps only what JSON can carry", serializeError(extras).data);

/* ------------------------------------------------------------------ */
step("parseXmlToObject: an XML body as a plain object");

const order = `<?xml version="1.0" encoding="UTF-8"?>
<!-- an order -->
<order id="1001" paid="true">
  <customer tier="gold">Ada &amp; Co</customer>
  <postcode>007</postcode>
  <item sku="A-1"><qty>2</qty></item>
  <item sku="B-2"><qty>1</qty></item>
  <note><![CDATA[<b>fragile</b>]]></note>
  <gift/>
</order>`;

show("defaults", parseXmlToObject(order));
show(
  "parsePrimitives: false",
  parseXmlToObject(order, { parsePrimitives: false }),
);
show(
  "attributeNamePrefix and textNodeName",
  parseXmlToObject(order, { attributeNamePrefix: "$", textNodeName: "value" }),
);
show(
  "ignoreAttributes: true",
  parseXmlToObject(order, { ignoreAttributes: true }),
);

try {
  parseXmlToObject("<!-- nothing but a comment -->");
} catch (error) {
  show("no element at all throws", (error as Error).message);
}

/* ------------------------------------------------------------------ */
step("decodeXmlEntities, coerceXmlPrimitive, isXmlWhitespace");

show(
  "decodeXmlEntities",
  decodeXmlEntities("5 &lt; 6 &amp;&amp; &#65;&#x42; &quot;ok&quot; &nbsp;"),
);
show(
  "coerceXmlPrimitive, coercing",
  ["true", " 42 ", "1e3", "0x1F", "Infinity", "TRUE", ""].map((text) =>
    coerceXmlPrimitive(text, true),
  ),
);
show(
  "coerceXmlPrimitive, not coercing (only trims)",
  coerceXmlPrimitive("  42 ", false),
);
show(
  "isXmlWhitespace: space, tab, LF, CR yes; form feed and NBSP no",
  [" ", "\t", "\n", "\r", "\f", "\u00A0"].map((char) =>
    isXmlWhitespace(char.charCodeAt(0)),
  ),
);

/* ------------------------------------------------------------------ */
step("Files: randomBytes, getUniqueFilename, pathExists");

const dir = await mkdtemp(join(tmpdir(), "bun-common-utilities-"));

show("randomBytes(8)", (await randomBytes(8)).toString("hex"));
show("getUniqueFilename keeps the last extension", [
  await getUniqueFilename("photo.JPG"),
  await getUniqueFilename("backup.tar.gz"),
  await getUniqueFilename("Makefile"),
]);

const file = join(dir, await getUniqueFilename("notes.txt"));
show("pathExists before writing", await pathExists(file));
await Bun.write(file, "hello");
show("after", await pathExists(file));
show("a directory counts", await pathExists(dir));

/* ------------------------------------------------------------------ */
step("streamToBuffer: a Node stream, collected");

const collected = await streamToBuffer(
  Readable.from([Buffer.from("hello, "), Buffer.from("world")]),
);
show("collected", collected.toString());

const broken = new Readable({
  read() {
    this.destroy(new Error("disk went away"));
  },
});
show(
  "a stream error rejects",
  await streamToBuffer(broken).catch(
    (error: unknown) => (error as Error).message,
  ),
);

try {
  await streamToBuffer({} as Readable);
} catch (error) {
  show("not a readable stream: throws", (error as Error).message);
}

await rm(dir, { recursive: true, force: true });
show("temporary directory removed", !(await pathExists(dir)));
