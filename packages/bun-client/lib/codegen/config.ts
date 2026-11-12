/**
 * The targets file (`--config <file>`, issue #768): every typed client an
 * app generates, in one place, so one command writes or `--check`s them all
 * (`bun-client generate --config`) and one watcher keeps them live
 * (`bun-client watch --config`).
 *
 * ```json
 * {
 *   "module": "server/openapi.ts",
 *   "targets": [
 *     { "document": "customer", "out": "ui/src/api/customer.gen.ts" },
 *     { "document": "backoffice", "out": "ui/src/api/backoffice.gen.ts", "zod": "ui/src/api/backoffice.zod.gen.ts" },
 *     { "document": "customer", "out": "ui/src/api/live.gen.ts", "include": ["asyncapi"] }
 *   ]
 * }
 * ```
 *
 * One source for `generate` (at most one of `url`, `module`, `openapi`, or
 * `asyncapi` alone for channels-only targets), and the targets. A target's
 * `include` (`--include`) keeps only the documents it lists, `"openapi"`
 * and `"asyncapi"`; without it, a target covers every document its source
 * has. A target's `document` is what it is generated from: under a
 * `url` (a `devTypes()` endpoint) the named document at `<url>/<document>`;
 * under a `module`, the export named after it (or the target's own
 * `export`). `watch` follows the running dev server whatever the source
 * says, and reads `url` and `tokenFile` as its `--url` and `--token-file`.
 * Every path is relative to the file's own directory. Unknown keys are
 * refused, so a misspelt one never passes silently.
 *
 * Reading ({@link readClientConfig}) is split from deciding
 * ({@link parseClientConfig}, pure).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DocumentKind } from "./emit";
import type { AsyncApiFileSource, DocumentSource } from "./load";
import { DOCUMENT_NAME_PATTERN } from "./devServer";
import { parseInclude } from "./emit";

/** One target of a targets file, resolved. */
export interface ClientConfigTarget {
  /** The named document it is generated from; `undefined` for the source's unnamed one. */
  readonly document: string | undefined;
  /** The module export it is generated from, under a `module` source: `export`, else `document`, else the file's `export`, else `"default"`. */
  readonly export: string | undefined;
  /** The file to write, absolute. */
  readonly out: string;
  /** The file as the targets file names it, for messages. */
  readonly display: string;
  /** The zod module beside it, absolute, as the file names it; `undefined` for none. */
  readonly zod: { readonly path: string; readonly display: string } | undefined;
  /** `"mini"` or `"classic"`; `undefined` when not given. */
  readonly zodFlavour: string | undefined;
  /** The documents it covers (`include`); `undefined` for every document its source has. */
  readonly include: readonly DocumentKind[] | undefined;
}

/** A targets file, resolved against its directory. */
export interface ClientConfig {
  /** The file, absolute. */
  readonly file: string;
  /** Its directory: what every path in it is relative to. */
  readonly dir: string;
  /** `generate`'s source; `undefined` when the file names none (`generate` then needs one on the command line). */
  readonly source:
    | { readonly url: string }
    | { readonly module: string; readonly export: string | undefined }
    | { readonly openapi: string; readonly asyncapi: string | undefined }
    | { readonly asyncapiFile: string }
    | undefined;
  /** A token file or a directory of them, absolute (`--token-file`); `undefined` when not given. */
  readonly tokenFile: string | undefined;
  /** The targets: at least one. */
  readonly targets: readonly ClientConfigTarget[];
}

/** The keys a targets file may hold. */
const FILE_KEYS = new Set([
  "$schema",
  "url",
  "module",
  "export",
  "openapi",
  "asyncapi",
  "tokenFile",
  "targets",
]);
/** The keys a target may hold. */
const TARGET_KEYS = new Set([
  "document",
  "export",
  "out",
  "zod",
  "zodFlavour",
  "include",
]);

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is a non-empty string, `undefined` when absent; a message otherwise. */
function optionalString(
  value: unknown,
  at: string,
): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value !== "") return value;
  return { error: `${at} must be a non-empty string` };
}

/**
 * Reads a targets file's text. Pure.
 *
 * @param text The file's content (JSON).
 * @param file Its absolute path: paths in it resolve from its directory.
 * @returns The resolved file, or a message saying what is wrong with it.
 */
export function parseClientConfig(
  text: string,
  file: string,
): ClientConfig | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `not JSON: ${(error as Error).message}`;
  }
  if (!isRecord(value)) return "the file must hold a JSON object";
  const unknown = Object.keys(value).filter((key) => !FILE_KEYS.has(key));
  if (unknown.length > 0) {
    return `unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")} (known: ${[...FILE_KEYS].filter((key) => key !== "$schema").join(", ")})`;
  }
  const dir = dirname(file);
  const strings: Record<string, string | undefined> = {};
  for (const key of [
    "url",
    "module",
    "export",
    "openapi",
    "asyncapi",
    "tokenFile",
  ]) {
    const read = optionalString(value[key], `"${key}"`);
    if (typeof read === "object") return read.error;
    strings[key] = read;
  }
  const sources = (["url", "module", "openapi"] as const).filter(
    (key) => strings[key] !== undefined,
  );
  if (sources.length > 1) {
    return `give at most one of "url", "module" and "openapi" (got ${sources.map((key) => `"${key}"`).join(", ")})`;
  }
  if (
    strings.asyncapi !== undefined &&
    strings.openapi === undefined &&
    sources.length > 0
  ) {
    return `"asyncapi" goes with "openapi", or alone: not with "${sources[0]}"`;
  }
  if (strings.export !== undefined && strings.module === undefined) {
    return `"export" goes with "module"`;
  }
  if (strings.url !== undefined && !URL.canParse(strings.url)) {
    return `"url" ${strings.url} is not a URL`;
  }
  // An AsyncAPI file alone is a source of its own: channels-only targets.
  const kind: (typeof sources)[number] | "asyncapi" | undefined =
    sources.length > 0
      ? sources[0]
      : strings.asyncapi === undefined
        ? undefined
        : "asyncapi";
  const source: ClientConfig["source"] =
    kind === "url"
      ? { url: strings.url! }
      : kind === "module"
        ? { module: resolve(dir, strings.module!), export: strings.export }
        : kind === "openapi"
          ? {
              openapi: resolve(dir, strings.openapi!),
              asyncapi:
                strings.asyncapi === undefined
                  ? undefined
                  : resolve(dir, strings.asyncapi),
            }
          : kind === "asyncapi"
            ? { asyncapiFile: resolve(dir, strings.asyncapi!) }
            : undefined;

  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    return `"targets" must be a non-empty array of { out, document?, export?, zod?, zodFlavour?, include? }`;
  }
  const targets: ClientConfigTarget[] = [];
  const documents = new Set<string>();
  const files = new Map<string, string>();
  for (const [index, raw] of value.targets.entries()) {
    const at = `targets[${index}]`;
    if (!isRecord(raw)) return `${at} must be an object`;
    const extra = Object.keys(raw).filter((key) => !TARGET_KEYS.has(key));
    if (extra.length > 0) {
      return `${at}: unknown key${extra.length === 1 ? "" : "s"} ${extra.map((key) => `"${key}"`).join(", ")} (known: ${[...TARGET_KEYS].join(", ")})`;
    }
    const fields: Record<string, string | undefined> = {};
    for (const key of TARGET_KEYS) {
      if (key === "include") continue;
      const read = optionalString(raw[key], `${at}.${key}`);
      if (typeof read === "object") return read.error;
      fields[key] = read;
    }
    const { document, out, zod, zodFlavour } = fields;
    if (out === undefined) return `${at} needs "out", the file to write`;
    if (
      document !== undefined &&
      (!DOCUMENT_NAME_PATTERN.test(document) || document === "ws")
    ) {
      return `${at}.document "${document}" is not a document name (letters, digits, _ and -, starting with a letter or digit)`;
    }
    if (document !== undefined) {
      if (documents.has(document))
        return `${at}.document "${document}" is named by two targets`;
      documents.add(document);
    }
    if (fields.export !== undefined && kind !== "module") {
      return `${at}.export goes with a "module" source`;
    }
    if (document !== undefined && (kind === "openapi" || kind === "asyncapi")) {
      return `${at}.document needs a "url" or "module" source: a document file has no named documents (give each target its own file instead)`;
    }
    let include: readonly DocumentKind[] | undefined;
    if (raw.include !== undefined) {
      if (!Array.isArray(raw.include))
        return `${at}.include must be an array: ["openapi"], ["asyncapi"] or both`;
      const read = parseInclude(raw.include, `${at}.include`);
      if (typeof read === "string") return read;
      include = read;
    }
    // A file source's documents are known now: say what a target lacks here,
    // not at generate time.
    if (kind === "asyncapi" && include?.join() !== "asyncapi") {
      return `${at} needs "include": ["asyncapi"]: the source is an AsyncAPI file alone, with no routes`;
    }
    if (
      kind === "openapi" &&
      strings.asyncapi === undefined &&
      include?.includes("asyncapi") === true
    ) {
      return `${at}.include names "asyncapi", but the source has no "asyncapi" file`;
    }
    if (zodFlavour !== undefined && zod === undefined) {
      return `${at}.zodFlavour goes with "zod"`;
    }
    if (
      zodFlavour !== undefined &&
      zodFlavour !== "mini" &&
      zodFlavour !== "classic"
    ) {
      return `${at}.zodFlavour is "mini" or "classic", not "${zodFlavour}"`;
    }
    const outPath = resolve(dir, out);
    const zodPath = zod === undefined ? undefined : resolve(dir, zod);
    for (const [path, name] of [
      [outPath, out],
      ...(zodPath === undefined ? [] : [[zodPath, zod!] as const]),
    ] as const) {
      const before = files.get(path);
      if (before !== undefined) {
        return `${at}: ${name} is written by two targets (or is both an "out" and a "zod")`;
      }
      files.set(path, name);
    }
    targets.push({
      document,
      export:
        kind === "module"
          ? (fields.export ?? document ?? strings.export ?? "default")
          : undefined,
      out: outPath,
      display: out,
      zod: zodPath === undefined ? undefined : { path: zodPath, display: zod! },
      zodFlavour,
      include,
    });
  }
  return {
    file,
    dir,
    source,
    tokenFile:
      strings.tokenFile === undefined
        ? undefined
        : resolve(dir, strings.tokenFile),
    targets,
  };
}

/**
 * Reads and resolves a targets file.
 *
 * @param path The file, absolute.
 * @returns The resolved file, or a message saying why it could not be read.
 */
export async function readClientConfig(
  path: string,
): Promise<ClientConfig | string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return `cannot read it: ${(error as Error).message}`;
  }
  return parseClientConfig(text, path);
}

/**
 * The source `generate` reads for `target` of `config`. `undefined` when
 * the file names no source.
 */
export function targetSource(
  config: ClientConfig,
  target: ClientConfigTarget,
): DocumentSource | AsyncApiFileSource | undefined {
  const source = config.source;
  if (source === undefined) return undefined;
  if ("asyncapiFile" in source) return source;
  if ("url" in source) {
    return {
      url:
        target.document === undefined
          ? source.url
          : `${source.url.replace(/\/+$/, "")}/${target.document}`,
    };
  }
  if ("module" in source) {
    return { module: source.module, export: target.export ?? "default" };
  }
  return {
    openapi: source.openapi,
    ...(source.asyncapi === undefined ? {} : { asyncapi: source.asyncapi }),
  };
}
