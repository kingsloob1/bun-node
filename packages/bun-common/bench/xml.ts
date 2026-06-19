/* eslint-disable antfu/no-top-level-await */
import { Buffer } from "node:buffer";
/**
 * XML parser micro-benchmark.
 *
 *   bun bench/xml.ts
 *
 * Compares the shipped `parseXmlToObject` against other XML→object approaches
 * across a range of document sizes. Every contender produces an *equivalent
 * plain object* (root-keyed, "@_"-prefixed attributes, repeated children →
 * arrays, numeric/boolean text coercion) so the comparison is apples-to-apples.
 *
 * The third-party comparators (`fast-xml-parser`, `htmlparser2`) are optional:
 * they're loaded via dynamic import and silently skipped when not installed, so
 * this script runs with zero extra dependencies. To include them:
 *
 *   bun add -d fast-xml-parser htmlparser2
 *
 * `Bun.HTMLRewriter` is native and always included.
 */
import { parseXmlToObject } from "../lib/utils/native";

/* ---------------- document generator ---------------- */
function genXml(records: number): string {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<catalog>`;
  for (let i = 0; i < records; i++) {
    s += `<book id="${i}" available="true">`;
    s += `<title>The Title Number ${i} of the Catalog</title>`;
    s += `<author>Author Name ${i}</author>`;
    s += `<genre>Computer Science &amp; Engineering</genre>`;
    s += `<price>${(i % 100) + 0.99}</price>`;
    s += `<description>A reasonably long description for book ${i} that adds some text content to parse through during the benchmark run.</description>`;
    s += `</book>`;
  }
  s += `</catalog>`;
  return s;
}

/* ---------------- shared node tree → object ----------------s
 * Used by the event/DOM-based comparators so they emit the same object shape
 * as parseXmlToObject. This isolates each parser's tokenisation/build cost.
 */
interface BNode {
  name: string;
  attributes: Record<string, string>;
  children: BNode[];
  text: string;
}

function coerce(text: string): unknown {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return t;
}

function nodeToValue(node: BNode): unknown {
  const attrKeys = Object.keys(node.attributes);
  if (node.children.length === 0 && attrKeys.length === 0)
    return coerce(node.text);
  const obj: Record<string, unknown> = {};
  for (const k of attrKeys) obj[`@_${k}`] = coerce(node.attributes[k]);
  for (const child of node.children) {
    const v = nodeToValue(child);
    const existing = obj[child.name];
    if (existing === undefined) obj[child.name] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else obj[child.name] = [existing, v];
  }
  if (node.text.trim() !== "") obj["#text"] = coerce(node.text);
  return obj;
}

const toObject = (root: BNode): Record<string, unknown> => ({
  [root.name]: nodeToValue(root),
});

/* ---------------- contenders ---------------- */
interface Parser {
  name: string;
  run: (xml: string) => unknown;
}

const parsers: Parser[] = [
  { name: "parseXmlToObject (ours)", run: (xml) => parseXmlToObject(xml) },
];

// fast-xml-parser (optional)
try {
  const { XMLParser } = await import("fast-xml-parser");
  const fxp = new XMLParser({ ignoreAttributes: false });
  parsers.push({ name: "fast-xml-parser", run: (xml) => fxp.parse(xml) });
} catch {
  console.log("· fast-xml-parser not installed — skipping");
}

// htmlparser2 (optional) — both a DOM build and a SAX build, each → object
try {
  const { parseDocument, Parser: SAX } = await import("htmlparser2");

  const domToNode = (el: any): BNode => {
    const node: BNode = {
      name: el.name,
      attributes: el.attribs ?? {},
      children: [],
      text: "",
    };
    for (const c of el.children) {
      if (c.type === "tag") node.children.push(domToNode(c));
      else if (c.type === "text") node.text += c.data;
      else if (c.type === "cdata")
        for (const cc of c.children)
          if (cc.type === "text") node.text += cc.data;
    }
    return node;
  };

  parsers.push({
    name: "htmlparser2 DOM → object",
    run: (xml) => {
      const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
      const root = doc.children.find((c: any) => c.type === "tag") as any;
      return toObject(domToNode(root));
    },
  });

  parsers.push({
    name: "htmlparser2 SAX → object",
    run: (xml) => {
      const sentinel: BNode = {
        name: "",
        attributes: {},
        children: [],
        text: "",
      };
      const stack: BNode[] = [sentinel];
      const p = new SAX(
        {
          onopentag(name, attribs) {
            const n: BNode = {
              name,
              attributes: attribs,
              children: [],
              text: "",
            };
            stack[stack.length - 1]!.children.push(n);
            stack.push(n);
          },
          ontext(t) {
            stack[stack.length - 1]!.text += t;
          },
          onclosetag() {
            stack.pop();
          },
        },
        { xmlMode: true, decodeEntities: true, recognizeCDATA: true },
      );
      p.write(xml);
      p.end();
      return toObject(sentinel.children[0]!);
    },
  });
} catch {
  console.log("· htmlparser2 not installed — skipping");
}

// Bun native HTMLRewriter (always available) → object
// NOTE: HTMLRewriter applies HTML semantics — it does NOT decode XML entities
// in text and is not XML-correct. Included only as a throughput reference.
parsers.push({
  name: "Bun HTMLRewriter → object",
  run: (xml) => {
    const sentinel: BNode = {
      name: "",
      attributes: {},
      children: [],
      text: "",
    };
    const stack: BNode[] = [sentinel];
    const rw = new HTMLRewriter().on("*", {
      element(el) {
        const attributes: Record<string, string> = {};
        for (const [k, v] of el.attributes) attributes[k] = v;
        const n: BNode = {
          name: el.tagName,
          attributes,
          children: [],
          text: "",
        };
        stack[stack.length - 1]!.children.push(n);
        stack.push(n);
        el.onEndTag(() => {
          stack.pop();
        });
      },
      text(t) {
        stack[stack.length - 1]!.text += t.text;
      },
    });
    rw.transform(xml);
    return toObject(sentinel.children[0]!);
  },
});

/* ---------------- timing harness ---------------- */
function bench(fn: () => void, minMs = 600, warmup = 30) {
  for (let i = 0; i < warmup; i++) fn();
  let iters = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    for (let i = 0; i < 5; i++) fn();
    iters += 5;
    elapsed = performance.now() - start;
  } while (elapsed < minMs);
  const msPerOp = elapsed / iters;
  return { opsPerSec: 1000 / msPerOp, msPerOp };
}

const sizes = [10, 100, 1000, 5000, 20000];
console.log(`\nBun ${Bun.version} — all parsers produce a plain object\n`);

for (const records of sizes) {
  const xml = genXml(records);
  const bytes = Buffer.byteLength(xml);
  console.log(`\n══ ${records} records — ${(bytes / 1024).toFixed(1)} KB ══`);
  console.log(
    `  ${"parser".padEnd(28)}${"ms/op".padStart(11)}${"ops/sec".padStart(
      11,
    )}${"MB/s".padStart(9)}  vs ours`,
  );

  const results: {
    name: string;
    msPerOp: number;
    opsPerSec: number;
    mbs: number;
  }[] = [];
  for (const p of parsers) {
    try {
      p.run(xml);
    } catch (e) {
      console.log(`  ${p.name.padEnd(28)}  ERROR: ${(e as Error).message}`);
      continue;
    }
    const { msPerOp, opsPerSec } = bench(() => p.run(xml));
    results.push({
      name: p.name,
      msPerOp,
      opsPerSec,
      mbs: bytes / 1024 / 1024 / (msPerOp / 1000),
    });
  }

  const ours = results.find((r) => r.name.includes("ours"))!.msPerOp;
  for (const r of results) {
    const rel =
      r.msPerOp === ours ? "1.00x" : `${(ours / r.msPerOp).toFixed(2)}x`;
    console.log(
      `  ${r.name.padEnd(28)}${r.msPerOp.toFixed(3).padStart(11)}${Math.round(
        r.opsPerSec,
      )
        .toLocaleString()
        .padStart(11)}${r.mbs.toFixed(1).padStart(9)}${rel.padStart(9)}`,
    );
  }
}
