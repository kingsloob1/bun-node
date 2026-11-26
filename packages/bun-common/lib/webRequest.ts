import type { XmlNode } from "./utils/native";
import { stringify as stringifyQuery } from "picoquery";

/**
 * Where the body of a `Request` answered by `BunRequest#webRequest()` came
 * from, read back with {@link webRequestSource}:
 *
 * - `"original"` — the request's own body, unread until then: a `clone()` of
 *   the native request, so its bytes are exactly the ones received
 *   (`Content-Encoding` included) and the original stays readable.
 * - `"retained"` — rebuilt from the bytes the body was read into (`req.buffer`,
 *   the `retainBuffer` option): exactly the ones received.
 * - `"decoded"` — rebuilt from the retained bytes of a body that came with a
 *   `Content-Encoding` (gzip, br, …): the decoded bytes, exactly as decoded,
 *   with the `Content-Encoding` header dropped. The entity is exact; the bytes
 *   on the wire were the encoded ones.
 * - `"parsed"` — rebuilt from the parsed value, because the body was read
 *   without its bytes (`retainBuffer: false`: JSON through `request.json()`,
 *   text, urlencoded and XML through `request.text()`). It carries the same
 *   content type and the same value, but not necessarily the same bytes
 *   (whitespace, key order of a form, entity spelling in XML). A caller that
 *   needs the exact bytes — a signature over the body — refuses it.
 * - `"none"` — a request without a body (`GET`, `HEAD`, or none sent).
 */
export type WebRequestSource =
  "original" | "retained" | "decoded" | "parsed" | "none";

/** The source of every `Request` `webRequest()` answered; keyed weakly. */
const SOURCES = new WeakMap<Request, WebRequestSource>();

/**
 * Where the body of a `Request` answered by `BunRequest#webRequest()` came
 * from (see {@link WebRequestSource}), or `undefined` for a `Request`
 * `webRequest()` did not answer — a copy made of it (`clone()`,
 * `new Request(it)`) included. A caller that needs the exact bytes accepts
 * `"original"`, `"retained"` and `"none"`, and refuses `"parsed"` (and
 * `"decoded"` when it needs the encoded bytes).
 *
 * ```ts
 * const request = req.webRequest();
 * if (webRequestSource(request) === "parsed") {
 *   throw new Error("this route needs the body's bytes: set retainBuffer");
 * }
 * ```
 */
export function webRequestSource(
  request: Request,
): WebRequestSource | undefined {
  return SOURCES.get(request);
}

/** Records `request`'s source for {@link webRequestSource}, and answers it. */
export function markWebRequest(
  request: Request,
  source: WebRequestSource,
): Request {
  SOURCES.set(request, source);
  return request;
}

/** What {@link serializeParsedBody} needs to know of the parser's options. */
export interface ParsedBodyFormat {
  /** The urlencoded parser's options (picoquery's, merged over the defaults). */
  urlencoded?: Parameters<typeof stringifyQuery>[1];
  /** The XML parser's attribute prefix (default `"@_"`). */
  attributeNamePrefix?: string;
  /** The XML parser's text key (default `"#text"`). */
  textNodeName?: string;
}

/**
 * Serialises a body parsed without its bytes back into text of its kind: JSON
 * with `JSON.stringify`, a form with picoquery's `stringify` under the parser's
 * own options, XML from the parsed document's shape (attributes under the
 * prefix, text under the text key), text as it is. Not byte-exact; see
 * `"parsed"` in {@link WebRequestSource}.
 */
export function serializeParsedBody(
  kind: string | undefined,
  value: unknown,
  format: ParsedBodyFormat,
): string {
  switch (kind) {
    case "text":
      return typeof value === "string" ? value : String(value);
    case "form":
      return stringifyQuery(value ?? {}, format.urlencoded);
    case "xml":
      return serializeXml(
        (value ?? {}) as Record<string, XmlNode>,
        format.attributeNamePrefix ?? "@_",
        format.textNodeName ?? "#text",
      );
    default:
      return JSON.stringify(value) ?? "";
  }
}

/** Escapes text for an XML element or a double-quoted attribute. */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** An attribute's or a text node's value as text (always a leaf when parsed). */
function leafText(value: XmlNode): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A parsed XML document (`parseXmlToObject`'s shape) as XML text. */
function serializeXml(
  document: Record<string, XmlNode>,
  prefix: string,
  textKey: string,
): string {
  let out = "";
  for (const [name, node] of Object.entries(document)) {
    out += xmlElement(name, node, prefix, textKey);
  }
  return out;
}

/** One element (or repeated siblings, for an array) of a parsed document. */
function xmlElement(
  name: string,
  node: XmlNode,
  prefix: string,
  textKey: string,
): string {
  if (Array.isArray(node)) {
    return node.map((item) => xmlElement(name, item, prefix, textKey)).join("");
  }
  if (typeof node !== "object") {
    return `<${name}>${escapeXml(String(node))}</${name}>`;
  }
  let attributes = "";
  let text = "";
  let children = "";
  for (const [key, value] of Object.entries(node)) {
    if (key === textKey) {
      text = escapeXml(leafText(value));
    } else if (prefix !== "" && key.startsWith(prefix)) {
      attributes += ` ${key.slice(prefix.length)}="${escapeXml(leafText(value))}"`;
    } else {
      children += xmlElement(key, value, prefix, textKey);
    }
  }
  return `<${name}${attributes}>${text}${children}</${name}>`;
}
