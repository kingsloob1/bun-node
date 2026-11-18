/**
 * Test a request's pasted forms (ui.md §4.5): a raw HTTP request (its
 * request line and headers; a body is dropped, since a test holds none) or
 * a `curl` command line (its method, URL and `-H` headers; a data flag
 * makes it a `POST` unless `-X` says otherwise, and its data is dropped).
 * Each gives the method, the path with its query, and the headers.
 */

/** What a pasted request says. */
export interface PastedRequest {
  /** The method. */
  readonly method: string;
  /** The path, with its query. */
  readonly path: string;
  /** The headers, by name as written. */
  readonly headers: Readonly<Record<string, string>>;
}

/** `Name: value` lines as headers; a line without a colon is a reason. */
export function headersOf(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at <= 0) return `“${line.trim()}” is not Name: value`;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** A URL or a path as a path with its query. */
function pathOf(target: string): string | undefined {
  if (target.startsWith("/")) return target;
  try {
    const url = new URL(target);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** A raw HTTP request, or the reason it cannot be read. */
export function parseRawRequest(text: string): PastedRequest | string {
  const lines = text.replace(/^\s+/, "").split(/\r?\n/);
  const first = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i.exec(
    lines[0] ?? "",
  );
  if (first === null) return "The first line is not METHOD /path HTTP/1.1";
  const path = pathOf(first[2]!);
  if (path === undefined)
    return "The request line's target is not a path or URL";
  const headerLines: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break; // The body starts: a test holds none.
    headerLines.push(line);
  }
  const headers = headersOf(headerLines.join("\n"));
  if (typeof headers === "string") return headers;
  return { method: first[1]!.toUpperCase(), path, headers };
}

/** A shell command line's words (single and double quotes, backslash escapes and line continuations). */
function words(text: string): string[] | string {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  const source = text.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < source.length) word += source[++i];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < source.length) {
      word += source[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) return "A quote is not closed";
  if (started) out.push(word);
  return out;
}

/** The flags that take a value and are not read here. */
const VALUED = new Set([
  "-u",
  "--user",
  "-o",
  "--output",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-b",
  "--cookie",
  "--connect-timeout",
  "-m",
  "--max-time",
  "--resolve",
  "-x",
  "--proxy",
]);

/** A `curl` command line, or the reason it cannot be read. */
export function parseCurl(text: string): PastedRequest | string {
  const parts = words(text.trim());
  if (typeof parts === "string") return parts;
  if (parts[0] !== "curl") return "It does not start with curl";
  let method: string | undefined;
  let url: string | undefined;
  let data = false;
  const headers: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const next = () => parts[++i];
    if (part === "-X" || part === "--request") method = next()?.toUpperCase();
    else if (part === "-H" || part === "--header") {
      const header = next() ?? "";
      const at = header.indexOf(":");
      if (at <= 0) return `“${header}” is not Name: value`;
      headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
    } else if (part === "-A" || part === "--user-agent") {
      headers["user-agent"] = next() ?? "";
    } else if (part === "-b" || part === "--cookie") {
      headers.cookie = next() ?? "";
    } else if (part === "-I" || part === "--head") method ??= "HEAD";
    else if (/^(?:-d|--data(?:-\w+)?|-F|--form|--json)$/.test(part)) {
      next();
      data = true;
    } else if (VALUED.has(part)) next();
    else if (part.startsWith("-")) continue;
    else url ??= part;
  }
  if (url === undefined) return "No URL";
  const path = pathOf(url);
  if (path === undefined) return "The URL does not parse";
  return { method: method ?? (data ? "POST" : "GET"), path, headers };
}
