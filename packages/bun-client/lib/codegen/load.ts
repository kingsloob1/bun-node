/**
 * Where the generator's documents come from (typed-client plan §3.2): a URL,
 * files, or a module imported in process.
 *
 * - **A URL** serving one OpenAPI document (JSON or YAML), or the dev
 *   endpoint's `{ hash, openapi, asyncapi }` (plan §3.3, PR-M2's
 *   `/__bun/types`). Nothing here depends on the endpoint's code: it reads
 *   what the URL answers.
 * - **Files**: an OpenAPI document, and optionally an AsyncAPI one, as JSON
 *   or YAML (by extension: `.yaml`/`.yml` is YAML, anything else JSON).
 * - **A module**: imported, and its export read as a router (documented in
 *   process with bun-common's `generateOpenApi` and `generateAsyncApi`), an
 *   OpenAPI document, a `generateOpenApi` result, `{ openapi, asyncapi }`,
 *   an object with a `router`, or a function returning any of those. So CI
 *   needs no running server.
 */
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { CodegenWarning } from "./openapi";
import type { ListedRouteLike } from "./zodDrops";
import { isRecord } from "./schema";
import { routeDropWarnings } from "./zodDrops";

/** Where to read the documents from: one of a URL, files or a module. */
export type DocumentSource =
  | {
      /** The URL: a document, or the dev endpoint's `{ hash, openapi, asyncapi }`. */
      readonly url: string;
      /** Request headers (a token, say). Default: none. */
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      /** The OpenAPI document's path (JSON, or YAML by extension). */
      readonly openapi: string;
      /** The AsyncAPI document's path, read for the hash. Default: none. */
      readonly asyncapi?: string;
    }
  | {
      /** The module's path. */
      readonly module: string;
      /** The export to read. Default: `"default"`. */
      readonly export?: string;
    };

/** The documents read from a {@link DocumentSource}. */
export interface LoadedDocuments {
  /** The OpenAPI document. */
  readonly openapi: object;
  /** The AsyncAPI document, when the source had one. */
  readonly asyncapi?: object;
  /** What producing the documents reported (`generateOpenApi`'s warnings, for a module). */
  readonly warnings: readonly CodegenWarning[];
}

/**
 * An AsyncAPI file read alone (`--asyncapi <file> --include asyncapi`, or a
 * targets file's `"asyncapi"` without `"openapi"`): a channels-only client.
 * Kept apart from {@link DocumentSource}, whose sources always yield an
 * OpenAPI document.
 */
export interface AsyncApiFileSource {
  /** The AsyncAPI document's path (JSON, or YAML by extension). */
  readonly asyncapiFile: string;
}

/** The document options a module's router is documented with: the dev sync's example's (plan §8.3). */
const MODULE_DOCUMENT_INFO = { title: "API", version: "1" } as const;

/** What bun-common's documents entry provides, as far as the loader uses it. */
interface DocsModule {
  /** `generateOpenApi(router, options)`. */
  readonly generateOpenApi: (
    router: unknown,
    options: { title: string; version: string },
  ) => {
    /** The document. */
    document: object;
    /** Its warnings. */
    warnings: readonly {
      /** The warning's stage. */
      stage: string;
      /** The warning. */
      message: string;
      /** The route's key, when it has one. */
      route?: string;
    }[];
  };
  /** `generateAsyncApi(router, options)`. */
  readonly generateAsyncApi?: (
    router: unknown,
    options: { title: string; version: string },
  ) => {
    /** The document. */
    document: object;
  };
}

/** Whether `value` is an OpenAPI document. */
function isOpenApi(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.openapi === "string";
}

/** Whether `value` is something a router-documenting generator takes: it lists its routes. */
function isRouter(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { routes?: unknown }).routes === "function"
  );
}

/** Parses a document's text: YAML when `yaml`, JSON otherwise. */
function parseDocument(text: string, yaml: boolean, where: string): unknown {
  try {
    return yaml ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${where}: not valid ${yaml ? "YAML" : "JSON"} (${(error as Error).message})`,
      { cause: error },
    );
  }
}

/** Reads a document file. */
async function readDocument(path: string): Promise<object> {
  const extension = extname(path).toLowerCase();
  const value = parseDocument(
    await readFile(path, "utf8"),
    extension === ".yaml" || extension === ".yml",
    path,
  );
  if (!isRecord(value)) throw new Error(`${path}: not a document object`);
  return value;
}

/**
 * Imports bun-common's documents entry: the module's own copy first (the
 * one its router was built with), else the one this package resolves.
 */
async function importDocs(modulePath: string): Promise<DocsModule> {
  const specifier = "@kingsleyweb/bun-common/lib/docs";
  let resolved: string | undefined;
  try {
    resolved = Bun.resolveSync(specifier, dirname(modulePath));
  } catch {
    resolved = undefined;
  }
  try {
    const docs = (await import(resolved ?? specifier)) as Partial<DocsModule>;
    if (typeof docs.generateOpenApi !== "function")
      throw new Error(`${specifier} has no generateOpenApi`);
    return docs as DocsModule;
  } catch (error) {
    throw new Error(
      `--module: documenting a router needs @kingsleyweb/bun-common (an optional peer of @kingsleyweb/bun-client), which did not load: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/**
 * bun-common's `listRoutes`, from the copy the module resolves (the one its
 * router was built with); `undefined` when it does not load, which leaves
 * the zod drops unreported rather than failing the generation.
 */
async function importListRoutes(
  modulePath: string,
): Promise<((router: unknown) => readonly ListedRouteLike[]) | undefined> {
  const specifier = "@kingsleyweb/bun-common";
  try {
    const common = (await import(
      Bun.resolveSync(specifier, dirname(modulePath))
    )) as { listRoutes?: unknown };
    if (typeof common.listRoutes !== "function") return undefined;
    const listRoutes = common.listRoutes as (
      router: unknown,
      options: object,
    ) => readonly ListedRouteLike[];
    // Its own warnings are the document's, which `generateOpenApi` reported.
    const quiet = { log: () => {}, warn: () => {}, error: () => {} };
    return (router) => listRoutes(router, { logger: quiet });
  } catch {
    return undefined;
  }
}

/** The route keys a document holds: its operations' `x-bun-route-key`s. */
function documentedKeys(document: object): Set<string> {
  const keys = new Set<string>();
  const paths = (document as { paths?: unknown }).paths;
  if (!isRecord(paths)) return keys;
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    for (const operation of Object.values(item))
      if (
        isRecord(operation) &&
        typeof operation["x-bun-route-key"] === "string"
      )
        keys.add(operation["x-bun-route-key"]);
  }
  return keys;
}

/** Reads the documents from a module's export (see the module's doc). */
async function fromExport(
  value: unknown,
  modulePath: string,
  name: string,
): Promise<LoadedDocuments> {
  if (typeof value === "function" && !isRouter(value)) {
    return fromExport(
      await (value as () => unknown)(),
      modulePath,
      `${name}()`,
    );
  }
  if (isOpenApi(value)) return { openapi: value, warnings: [] };
  if (isRecord(value) && isOpenApi(value.document)) {
    return {
      openapi: value.document,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.map(producerWarning)
        : [],
    };
  }
  if (isRecord(value) && isOpenApi(value.openapi)) {
    return {
      openapi: value.openapi,
      ...(isRecord(value.asyncapi) ? { asyncapi: value.asyncapi } : {}),
      warnings: [],
    };
  }
  const router = isRouter(value)
    ? value
    : isRecord(value) && isRouter(value.router)
      ? value.router
      : undefined;
  if (router === undefined) {
    throw new Error(
      `--module ${modulePath}: export "${name}" is not a router, an OpenAPI document, a generateOpenApi() result, { openapi, asyncapi }, an object with a router, or a function returning one`,
    );
  }
  const docs = await importDocs(modulePath);
  const result = docs.generateOpenApi(router, { ...MODULE_DOCUMENT_INFO });
  const warnings = result.warnings.map(producerWarning);
  // What the zod schemas hold that the document cannot (plan §5.3): only
  // the router's own schemas show it, so only a module source reports it.
  const listRoutes = await importListRoutes(modulePath);
  if (listRoutes !== undefined)
    warnings.push(
      ...routeDropWarnings(listRoutes(router), documentedKeys(result.document)),
    );
  let asyncapi: object | undefined;
  if (typeof docs.generateAsyncApi === "function") {
    try {
      asyncapi = docs.generateAsyncApi(router, {
        ...MODULE_DOCUMENT_INFO,
      }).document;
    } catch (error) {
      warnings.push({
        at: "document",
        message: `the AsyncAPI document could not be built, so the hash covers the OpenAPI one alone: ${(error as Error).message}`,
      });
    }
  }
  return {
    openapi: result.document,
    ...(asyncapi === undefined ? {} : { asyncapi }),
    warnings,
  };
}

/** One of `generateOpenApi`'s warnings, as the generator's. */
function producerWarning(raw: unknown): CodegenWarning {
  const warning = isRecord(raw) ? raw : {};
  const stage = typeof warning.stage === "string" ? warning.stage : "openapi";
  return {
    at:
      typeof warning.route === "string" ? warning.route : `document (${stage})`,
    message:
      typeof warning.message === "string"
        ? warning.message
        : JSON.stringify(raw),
  };
}

/**
 * Reads the documents from a successful response: one OpenAPI document (JSON,
 * or YAML by its content type), or the dev endpoint's `{ hash, openapi,
 * asyncapi }`. `bun-client watch` reads the dev endpoint's answers with it.
 *
 * @param response The response, already known to be `ok`.
 * @param where What the messages name (`--url <url>`).
 * @throws Error when the body is not one of those.
 */
export async function documentsFromResponse(
  response: Response,
  where: string,
): Promise<LoadedDocuments> {
  const type = response.headers.get("content-type") ?? "";
  const value = parseDocument(await response.text(), /yaml/i.test(type), where);
  if (isOpenApi(value)) return { openapi: value, warnings: [] };
  if (isRecord(value) && isOpenApi(value.openapi)) {
    return {
      openapi: value.openapi,
      ...(isRecord(value.asyncapi) ? { asyncapi: value.asyncapi } : {}),
      warnings: [],
    };
  }
  throw new Error(
    `${where}: the answer is neither an OpenAPI document nor { openapi, asyncapi }`,
  );
}

/**
 * Reads the documents a source names.
 *
 * @param source A URL, files, or a module (see {@link DocumentSource}).
 * @param cwd The directory relative paths resolve from. Default: `process.cwd()`.
 * @throws Error when the source cannot be read, or holds no OpenAPI document.
 */
export async function loadDocuments(
  source: DocumentSource,
  cwd: string = process.cwd(),
): Promise<LoadedDocuments> {
  if ("url" in source) {
    let response: Response;
    try {
      response = await fetch(source.url, {
        headers: {
          accept: "application/json, application/yaml;q=0.9",
          ...source.headers,
        },
      });
    } catch (error) {
      throw new Error(`--url ${source.url}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new Error(
        `--url ${source.url}: answered ${response.status} ${response.statusText}`.trimEnd(),
      );
    }
    return documentsFromResponse(response, `--url ${source.url}`);
  }
  if ("openapi" in source) {
    const openapi = await readDocument(resolve(cwd, source.openapi));
    if (!isOpenApi(openapi))
      throw new Error(`--openapi ${source.openapi}: not an OpenAPI document`);
    return {
      openapi,
      ...(source.asyncapi === undefined
        ? {}
        : { asyncapi: await readDocument(resolve(cwd, source.asyncapi)) }),
      warnings: [],
    };
  }
  const modulePath = resolve(cwd, source.module);
  const name = source.export ?? "default";
  const loaded = (await import(pathToFileURL(modulePath).href)) as Record<
    string,
    unknown
  >;
  if (!Object.hasOwn(loaded, name)) {
    const names = Object.keys(loaded).sort();
    throw new Error(
      `--module ${source.module}: no export "${name}"${names.length > 0 ? ` (it exports ${names.map((each) => `"${each}"`).join(", ")}; pick one with --export)` : ""}`,
    );
  }
  return fromExport(loaded[name], modulePath, name);
}

/**
 * Reads an AsyncAPI document alone, from a file (see {@link AsyncApiFileSource}).
 *
 * @param source The file.
 * @param cwd The directory a relative path resolves from. Default: `process.cwd()`.
 * @throws Error when the file cannot be read or is not an AsyncAPI document.
 */
export async function loadAsyncApiFile(
  source: AsyncApiFileSource,
  cwd: string = process.cwd(),
): Promise<{
  /** The AsyncAPI document. */
  readonly asyncapi: object;
  /** Always empty: a file reports nothing. */
  readonly warnings: readonly CodegenWarning[];
}> {
  const asyncapi = await readDocument(resolve(cwd, source.asyncapiFile));
  if (!isRecord(asyncapi) || typeof asyncapi.asyncapi !== "string")
    throw new Error(
      `--asyncapi ${source.asyncapiFile}: not an AsyncAPI document (no "asyncapi" version field)`,
    );
  return { asyncapi, warnings: [] };
}
