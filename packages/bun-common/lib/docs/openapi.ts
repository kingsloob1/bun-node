/**
 * The OpenAPI 3.1 generator (AD (a), plan `docs/plans/api-docs-generation/`
 * §3.3): builds a document from a router's routes — the ones
 * `listRoutes(router)` (bun-validate V12) lists — merged with the `.describe()`
 * docs (`./routeDoc`). Discovery and the contract side are V12's; this module
 * never re-walks routes itself.
 *
 * What a route contributes:
 *
 * - its path, through {@link toOpenApiPath} (plan §10.2's rules: wildcards are
 *   undocumentable, `:id(\d+)` lifts a `pattern`, `:a?` documents as two paths
 *   by default, `:a-:b` documents with a warning);
 * - its request, from the contract's inbound rows (params → path parameters,
 *   query, headers, cookies as `in: "cookie"`, body via V12's
 *   `bodyPlacement`), a `.describe({ request })` target replacing the
 *   discovered one wholesale (with a warning when it disagrees with a
 *   *checking* schema — plan §3.2), and `.describe({ request: { files } })`
 *   adding a multipart body's file fields as `format: binary` properties;
 * - its responses, from the contract's outbound rows, the validator winning
 *   over `.describe({ responses })` on a disagreement (Decision 4), variant
 *   statuses emitted with `oneOf` bodies and an `x-variants` table (plan
 *   §4.12 of bun-validate);
 * - its prose, from `.describe()`;
 * - the typed client's extensions (typed-client plan §3.0, §8.2):
 *   `x-bun-route-key` on every operation (the listing's key), `x-bun-errors`
 *   from `.describe({ errors })` and `x-bun-cache` from `.describe({ cache })`;
 *   on a body's schema, `x-bun-chunks` for a `chunks()` stream's framing and
 *   `x-bun-max-bytes` for a documented file's size limit.
 *
 * Nothing here throws for a documentation problem in lenient mode (the
 * default): it records a {@link DocWarning} and emits what it knows. `strict:
 * "strict"` escalates every warning to a {@link ConfigError}. The genuine
 * configuration mistakes — a duplicate operation id, a security requirement
 * naming an undeclared scheme — are always a `ConfigError`. One route at
 * several mounts is not a duplicate: a declared id is suffixed per later
 * mount ({@link OpenApiOptions.operationId}).
 *
 * Deterministic: two calls over one router deep-equal (plan §9.2).
 */
import type { ContractEntry } from "../contract/describe";
import { isSchema } from "../contract/transport";
import type { BunRouter } from "../BunRouter";
import type { DtoClass } from "../classDto";
import { fromDto, isDtoClass } from "../classDto";
import { ConfigError } from "../errors";
import type { LoggerLike } from "../logging";
import type { ListedRoute } from "../routeModel";
import type { StandardSchemaV1 } from "../types/standardSchema";
import { bodyPlacement, listRoutes } from "../routeModel";
import type {
  JsonSchemaConverter,
  JsonSchemaLike,
  SchemaDirection,
} from "./convert";
import type { LiftedSchema } from "./lift";
import type { RouteDoc, RouteResponseDoc } from "./routeDoc";
import type { OpenApiSecurityScheme } from "./security";
import type { OpenApiDocument } from "./types";
import { toJsonSchema } from "./convert";
import { liftComponents } from "./lift";
import { danglingRefs, pruneSchemaComponents } from "./refs";
import { routeDocFor } from "./routeDoc";
import { openApiSecurity } from "./security";

/**
 * An OpenAPI 3.1 document, as {@link generateOpenApi} builds it. Typed loosely
 * on purpose: only the version is pinned, and the document is checked against
 * the OpenAPI 3.1 meta-schema in the tests rather than modelled here.
 */
export type { OpenApiDocument } from "./types";

/**
 * A problem the generator degraded past in lenient mode (and `strict`
 * escalates to a {@link ConfigError}): an undocumentable path, a missing
 * response declaration, a schema nothing could convert, a `.describe()` that
 * disagrees with a validator.
 */
export interface DocWarning {
  /** Which part of the document the warning is about. */
  readonly stage: "path" | "request" | "response" | "operation" | "security";
  /** What happened, naming what was emitted instead. */
  readonly message: string;
  /** The route it is about (`"GET /users/:id"`), when one is. */
  readonly route?: string;
}

/** One path parameter of an OpenAPI path template. */
export interface OpenApiPathParam {
  /** The parameter's name (`{id}`). */
  name: string;
  /**
   * The anchored pattern a `:name(…)` regex constraint declared, e.g.
   * `"^(?:\\d+)$"`; lifted onto the parameter's schema (plan §10.2).
   */
  pattern?: string;
}

/** One OpenAPI path template a route path expands to. */
export interface OpenApiPathTemplate {
  /** The template, e.g. `"/users/{id}"`. */
  path: string;
  /** Its path parameters, in order. */
  params: OpenApiPathParam[];
}

/** What {@link toOpenApiPath} returns. */
export interface OpenApiPathResult {
  /**
   * The templates the path expands to: one, or two for an optional parameter
   * under the default `"two-paths"` rule. Empty when the path cannot be
   * expressed — then {@link undocumentable} says why.
   */
  templates: OpenApiPathTemplate[];
  /** Non-fatal caveats (a poorly-supported form documented anyway). */
  warnings: string[];
  /** Why the path cannot be expressed in OpenAPI, when it cannot. */
  undocumentable?: string;
}

/** What {@link toOpenApiPath} takes. */
export interface OpenApiPathOptions {
  /**
   * How an optional parameter (`/opt/:a?`, or an optional `{…}` group)
   * documents (plan §10.2; OpenAPI path parameters are always
   * `required: true`):
   *
   * - `"two-paths"` (default) — two paths, with and without the optional part;
   * - `"warn"` — one path, the optional parameter documented as required,
   *   plus a warning saying it is optional at runtime.
   */
  optionalParams?: "two-paths" | "warn";
}

/** A piece of a route path, mid-scan. */
type PathPiece =
  | { kind: "text"; text: string }
  | {
      kind: "param";
      name: string;
      pattern?: string;
      optional: boolean;
      /** Set when literal text or a param precedes this one inside its segment (`:a-:b`). */
      segmentInternal: boolean;
    }
  | { kind: "group"; pieces: PathPiece[] };

/** A parameter name, as routejs accepts (`\w+`). */
const PARAM_NAME = /^\w+$/;

/** The scan's failure: why the path has no OpenAPI form. */
interface ScanError {
  undocumentable: string;
}

/** The scan of one path (or one group's content). */
interface PathScan {
  pieces: PathPiece[];
  warnings: string[];
}

/** Whether the scan failed. */
function isScanError(scan: PathScan | ScanError): scan is ScanError {
  return "undocumentable" in scan;
}

/**
 * Scans a path (or a group's content) into pieces. Handles both syntaxes
 * `compileRoutePath` accepts: path-to-regexp 8's (`:name`, `*name`, `{…}`
 * optional groups) and routejs's legacy (`:name?`, `:name(…)`, a bare `(…)`).
 */
function scanPath(path: string): PathScan | ScanError {
  const pieces: PathPiece[] = [];
  const warnings: string[] = [];
  const chars = [...path];
  let i = 0;
  /** Whether the current segment already holds text or a param (`:a-:b`). */
  let segmentHasContent = false;

  /** Reads a `(...)` constraint starting at `from` (chars[from] === "("). */
  const readConstraint = (
    from: number,
  ): { pattern: string; end: number } | undefined => {
    let depth = 0;
    let pattern = "";
    for (let j = from; j < chars.length; j++) {
      const c = chars[j];
      if (c === "\\") {
        pattern += c + (chars[j + 1] ?? "");
        j++;
        continue;
      }
      if (c === "(") {
        depth++;
        if (depth > 1) pattern += c;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 0) return { pattern, end: j + 1 };
        pattern += c;
        continue;
      }
      pattern += c;
    }
    return undefined;
  };

  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\") {
      const next = chars[i + 1];
      if (next === undefined) {
        return { undocumentable: "the path ends in an escape" };
      }
      pieces.push({ kind: "text", text: next });
      segmentHasContent = true;
      i += 2;
      continue;
    }
    if (c === "*") {
      return {
        undocumentable:
          "a wildcard matches `/`, which an OpenAPI path parameter cannot express",
      };
    }
    if (c === "{") {
      const close = chars.indexOf("}", i);
      if (close === -1) {
        return { undocumentable: "an unterminated `{…}` group" };
      }
      const inner = chars.slice(i + 1, close).join("");
      if (inner.startsWith("*")) {
        return {
          undocumentable:
            "a wildcard matches `/`, which an OpenAPI path parameter cannot express",
        };
      }
      const innerScan = scanPath(inner);
      if (isScanError(innerScan)) {
        return {
          undocumentable: `the optional group {${inner}}: ${innerScan.undocumentable}`,
        };
      }
      warnings.push(...innerScan.warnings);
      pieces.push({ kind: "group", pieces: innerScan.pieces });
      segmentHasContent = true;
      i = close + 1;
      continue;
    }
    if (c === "(" || c === ")") {
      return { undocumentable: "a bare `(…)` group has no OpenAPI form" };
    }
    if (c === ":") {
      let j = i + 1;
      let name = "";
      while (j < chars.length && /^\w$/.test(chars[j])) {
        name += chars[j++];
      }
      if (name === "" || !PARAM_NAME.test(name)) {
        return {
          undocumentable:
            "a parameter whose name is not `\\w+` has no OpenAPI form",
        };
      }
      let pattern: string | undefined;
      if (chars[j] === "(") {
        const constraint = readConstraint(j);
        if (constraint === undefined) {
          return {
            undocumentable: `the constraint of ":${name}(…)" is unbalanced`,
          };
        }
        pattern = `^(?:${constraint.pattern})$`;
        j = constraint.end;
      }
      let optional = false;
      if (chars[j] === "?") {
        optional = true;
        j++;
      } else if (chars[j] === "+" || chars[j] === "*") {
        return {
          undocumentable: `":${name}${chars[j]}" repeats, which an OpenAPI path parameter cannot express`,
        };
      }
      pieces.push({
        kind: "param",
        name,
        optional,
        segmentInternal: segmentHasContent,
        ...(pattern === undefined ? {} : { pattern }),
      });
      segmentHasContent = true;
      i = j;
      continue;
    }
    if (c === "?") {
      // A routejs optional literal or group (`/ab?c`, `/(abc)?`).
      return {
        undocumentable: "an optional literal or group has no OpenAPI form",
      };
    }
    if (c === "+") {
      return {
        undocumentable: "a repeated literal or group has no OpenAPI form",
      };
    }
    segmentHasContent = c !== "/";
    pieces.push({ kind: "text", text: c });
    i++;
  }
  return { pieces, warnings };
}

/** One item of an expanded combination: kept text, a kept param, or a dropped optional piece. */
type CombinationItem =
  | { kind: "text"; text: string }
  | { kind: "param"; name: string; pattern?: string }
  | { kind: "dropped"; wholeSegment: boolean };

/** Whether the piece at `index` alone fills its segment (`/opt/:a?`, `/a{/:b}`). */
function wholeSegment(pieces: readonly PathPiece[], index: number): boolean {
  const previous = pieces[index - 1];
  const next = pieces[index + 1];
  return (
    previous !== undefined &&
    previous.kind === "text" &&
    previous.text.endsWith("/") &&
    (next === undefined || (next.kind === "text" && next.text.startsWith("/")))
  );
}

/** The cap on a path's expansions (path-to-regexp caps its own at 256). */
const MAX_TEMPLATES = 64;

/**
 * Every combination `pieces` expands to, as item lists: the cartesian product
 * over the optional pieces (`:a?` params and `{…}` groups), a present group
 * expanding its own optionals in turn. `undefined` past {@link MAX_TEMPLATES}.
 */
function expandPieces(
  pieces: readonly PathPiece[],
): CombinationItem[][] | undefined {
  const perPiece: CombinationItem[][][] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind === "text") {
      perPiece.push([[{ kind: "text", text: piece.text }]]);
      continue;
    }
    if (piece.kind === "param") {
      const kept: CombinationItem = {
        kind: "param",
        name: piece.name,
        ...(piece.pattern === undefined ? {} : { pattern: piece.pattern }),
      };
      perPiece.push(
        piece.optional
          ? [
              [kept],
              [{ kind: "dropped", wholeSegment: wholeSegment(pieces, index) }],
            ]
          : [[kept]],
      );
      continue;
    }
    // A group: absent, or present with each of its own expansions.
    const inner = expandPieces(piece.pieces);
    if (inner === undefined) return undefined;
    perPiece.push([
      ...inner,
      [{ kind: "dropped", wholeSegment: wholeSegment(pieces, index) }],
    ]);
  }
  let combinations: CombinationItem[][] = [[]];
  for (const alternatives of perPiece) {
    const next: CombinationItem[][] = [];
    for (const prefix of combinations) {
      for (const alternative of alternatives) {
        next.push([...prefix, ...alternative]);
      }
    }
    if (next.length > MAX_TEMPLATES) return undefined;
    combinations = next;
  }
  return combinations;
}

/**
 * Joins one combination into a template. A dropped whole-segment piece takes
 * the `/` before it with it (`/opt/:a?` → `/opt`, never `/opt/`).
 */
function toTemplate(items: readonly CombinationItem[]): OpenApiPathTemplate {
  let path = "";
  const params: OpenApiPathParam[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      path += item.text;
    } else if (item.kind === "param") {
      path += `{${item.name}}`;
      params.push({
        name: item.name,
        ...(item.pattern === undefined ? {} : { pattern: item.pattern }),
      });
    } else if (item.wholeSegment && path !== "/" && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
  }
  return { path: path === "" ? "/" : path, params };
}

/**
 * Converts an Express/routejs route path to its OpenAPI path template(s), the
 * ported `toOpenApiPath` of bun-jobs' `lib/api/spec/openapi.ts` extended with
 * plan §10.2's rules. Never throws:
 *
 * | Path | Result |
 * |---|---|
 * | `/users/:id` | `/users/{id}` |
 * | `/files/*name`, `/{*name}`, a bare `*` | undocumentable — a wildcard matches `/`, which a path parameter cannot express |
 * | `/re/:id(\d+)` | `/re/{id}`, the constraint lifted to `pattern: "^(?:\\d+)$"` |
 * | `/opt/:a?` | two paths (`/opt`, `/opt/{a}`) by default; one with a warning under `optionalParams: "warn"` |
 * | `/a{/:b}` | two paths (`/a`, `/a/{b}`), as `:b?` |
 * | `/slug/:a-:b` | `/slug/{a}-{b}`, with a warning (legal, poorly supported by viewers) |
 * | `/a/(b)` or `/ab?c` (a bare group or optional literal) | undocumentable |
 *
 * @param path The path as registered (`ListedRoute.path`).
 * @param options See {@link OpenApiPathOptions}.
 */
export function toOpenApiPath(
  path: string,
  options: OpenApiPathOptions = {},
): OpenApiPathResult {
  if (path === "*" || path === "") {
    return {
      templates: [],
      warnings: [],
      undocumentable:
        "a pathless route matches every path; OpenAPI cannot say so",
    };
  }
  const scan = scanPath(path);
  if (isScanError(scan)) {
    return { templates: [], warnings: [], undocumentable: scan.undocumentable };
  }
  const warnings = [...scan.warnings];
  if (
    scan.pieces.some((piece) => piece.kind === "param" && piece.segmentInternal)
  ) {
    warnings.push(
      "path parameters inside a segment (like `:a-:b`) are legal OpenAPI but poorly supported by viewers",
    );
  }

  if ((options.optionalParams ?? "two-paths") === "warn") {
    if (
      scan.pieces.some(
        (piece) =>
          (piece.kind === "param" && piece.optional) || piece.kind === "group",
      )
    ) {
      warnings.push(
        'an optional part of the path is documented as always present: OpenAPI path parameters are always required (the default `optionalParams: "two-paths"` documents both forms)',
      );
    }
    return {
      templates: [
        toTemplate(
          scan.pieces.flatMap((piece): CombinationItem[] => {
            if (piece.kind === "text") {
              return [{ kind: "text", text: piece.text }];
            }
            if (piece.kind === "group") {
              return scanGroupPresent(piece.pieces);
            }
            return [
              {
                kind: "param",
                name: piece.name,
                ...(piece.pattern === undefined
                  ? {}
                  : { pattern: piece.pattern }),
              },
            ];
          }),
        ),
      ],
      warnings,
    };
  }

  const combinations = expandPieces(scan.pieces);
  if (combinations === undefined) {
    return {
      templates: [],
      warnings,
      undocumentable: `more than ${MAX_TEMPLATES} expansions of the optional parts`,
    };
  }
  const seen = new Set<string>();
  const templates: OpenApiPathTemplate[] = [];
  for (const combination of combinations) {
    const template = toTemplate(combination);
    if (seen.has(template.path)) continue;
    seen.add(template.path);
    templates.push(template);
  }
  return { templates, warnings };
}

/** A present group's pieces as combination items (every inner optional kept). */
function scanGroupPresent(pieces: readonly PathPiece[]): CombinationItem[] {
  return pieces.flatMap((piece): CombinationItem[] => {
    if (piece.kind === "text") return [{ kind: "text", text: piece.text }];
    if (piece.kind === "group") return scanGroupPresent(piece.pieces);
    return [
      {
        kind: "param",
        name: piece.name,
        ...(piece.pattern === undefined ? {} : { pattern: piece.pattern }),
      },
    ];
  });
}

/** Options for {@link generateOpenApi}. */
export interface OpenApiOptions {
  /** `info.title`. Required — OpenAPI has no sensible default. */
  title: string;
  /** `info.version`. Required. */
  version: string;
  /** `info.description`, CommonMark. Default: none. */
  description?: string;
  /** The rest of `info` (`contact`, `license`, `termsOfService`, `summary`). */
  info?: Readonly<Record<string, unknown>>;
  /**
   * `servers`. Default: `[{ url: "/" }]`, so paths are relative to wherever
   * the document is served from.
   */
  servers?: readonly {
    url: string;
    description?: string;
    variables?: unknown;
  }[];
  /** `components.securitySchemes`. Default: none declared. */
  securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  /**
   * The document-wide `security` requirement. Default: with schemes declared,
   * "any one of them"; with none, absent.
   */
  security?: readonly Record<string, readonly string[]>[];
  /**
   * Tag descriptions, by tag name. A tag a route uses but this does not name
   * still appears, without a description. Default: `{}`.
   */
  tags?: Readonly<
    Record<string, { description?: string; externalDocs?: unknown }>
  >;
  /**
   * Decides which routes are documented, on top of `hidden`. Return `false`
   * to drop one. Default: every non-hidden endpoint route.
   */
  filter?: (route: ListedRoute) => boolean;
  /**
   * Names an operation that declared no `operationId`. Default:
   * `camelCase(method + path)` with params as `By<Name>` —
   * `GET /users/:id/posts` → `getUsersByIdPosts`. Collisions are a
   * `ConfigError`, never a silent rename.
   *
   * One exception, for **declared** ids only (`.describe({ operationId })`,
   * a `defineRoutes` property name): a router mounted at several paths
   * declares its ids once per mount, so the route at the first mount (in
   * registration order) keeps its id and the same route at each later mount
   * gets the id suffixed with where its mount differs from the first one's,
   * spelt as here — `getUser` at `/users` and `/v2/users` documents as
   * `getUser` and `getUserV2`; at `/api/v1` and `/api/v2`, `getUser` and
   * `getUserV2`; at `/teams` and `/orgs/:org`, `getUser` and
   * `getUserOrgsByOrg`. "The same route" means the same terminal callback,
   * method and path within the mount. A suffixed id another route already
   * uses, and a later mount at `/` (no words to suffix), are still a
   * `ConfigError`, as is a duplicate this callback returns.
   *
   * A second exception, for a declared id or one this callback returns: an
   * optional param documents its route on several paths
   * ({@link OpenApiOptions.optionalParams}), and an id is unique in a
   * document, so the path with every param keeps it and each shorter path
   * gets `Without<Params>` — `getPage` on `/page/:n?` documents as `getPage`
   * at `/page/{n}` and `getPageWithoutN` at `/page`; on `/x/:a?/:b?`, the
   * others are `getXWithoutB`, `getXWithoutA` and `getXWithoutAAndB`.
   */
  operationId?: (route: ListedRoute) => string;
  /**
   * How hard to be about incomplete documentation.
   * - `"lenient"` (default) — emit what is known, collect the rest in
   *   {@link OpenApiResult.warnings}.
   * - `"strict"` — throw `ConfigError` on an undocumentable path, a route
   *   with no declared responses, a schema no converter handled — on any
   *   warning at all, in fact.
   */
  strict?: "lenient" | "strict";
  /**
   * Standard Schema → JSON Schema converters, tried before the built-in
   * registry and keyed by `~standard.vendor`. Default: `{}`.
   */
  converters?: Readonly<Record<string, JsonSchemaConverter>>;
  /**
   * Names a schema so it is emitted once under `components.schemas` and
   * referenced with `$ref` everywhere. Return `undefined` to inline.
   * Default: a schema's own `$id`/`title`, else inline (plan §4.4).
   */
  componentName?: (
    schema: StandardSchemaV1 | JsonSchemaLike,
  ) => string | undefined;
  /**
   * How an optional path parameter documents. Default `"two-paths"`; see
   * {@link OpenApiPathOptions.optionalParams}.
   */
  optionalParams?: "two-paths" | "warn";
}

/** What {@link generateOpenApi} returns. */
export interface OpenApiResult {
  /** The document. Fresh objects; the caller owns it. */
  document: OpenApiDocument;
  /**
   * Everything `lenient` mode swallowed: undocumentable paths, missing
   * responses, unconverted schemas, disagreements `.describe()` lost.
   */
  warnings: readonly DocWarning[];
}

/** Reason phrases for the statuses a reason phrase exists for. */
const REASON_PHRASES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/** The status's reason phrase, or a neutral stand-in for one without. */
function reasonPhrase(status: number): string {
  return REASON_PHRASES[status] ?? `Status ${status}`;
}

/** JSON with sorted keys and no `$schema`, so two JSON Schemas compare by content. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return child;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(child).sort()) {
      if (key !== "$schema") {
        sorted[key] = (child as Record<string, unknown>)[key];
      }
    }
    return sorted;
  });
}

/** The default operation id: `camelCase(method + path)`, params as `By<Name>`. */
function defaultOperationId(method: string, template: string): string {
  const words: string[] = [];
  const pushLiteral = (text: string): void => {
    for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
      if (word !== "") words.push(word);
    }
  };
  for (const segment of template.split("/")) {
    if (segment === "") continue;
    const marker = /\{([^}]*)\}/g;
    let last = 0;
    let match = marker.exec(segment);
    while (match !== null) {
      pushLiteral(segment.slice(last, match.index));
      words.push("by", match[1]);
      last = match.index + match[0].length;
      match = marker.exec(segment);
    }
    pushLiteral(segment.slice(last));
  }
  let id = method.toLowerCase();
  for (const word of words) {
    id += word.charAt(0).toUpperCase() + word.slice(1);
  }
  return id;
}

/**
 * Who claimed an operation id, and what makes two claims the same route at
 * two mounts: one terminal callback (so one `.describe()` doc), one method,
 * one path within the mount, two different mounts.
 */
interface OperationIdClaim {
  /** The claiming route's listing key (`"GET /users/:id"`). */
  readonly key: string;
  /** Its method, as the listing carries it. */
  readonly method: string;
  /** Its terminal callback, the key of its `.describe()` doc. */
  readonly terminal: unknown;
  /** Its mount: the route record's `group` as written, `""` outside any mount. */
  readonly mount: string;
  /** Its path within the mount; `undefined` when the path does not start with it. */
  readonly within: string | undefined;
}

/** A route record's mount — its `group`, joined across nested mounts — `""` for none. */
function mountOf(record: unknown): string {
  const group = (record as { group?: unknown } | undefined)?.group;
  return typeof group === "string" ? group : "";
}

/** The part of `path` after `mount`; `undefined` when `path` does not start with it. */
function pathWithinMount(path: string, mount: string): string | undefined {
  const prefix = mount.replace(/\/+$/, "");
  if (prefix === "") return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** Whether `claim` is the same route as `other`, mounted somewhere else. */
function isRemount(claim: OperationIdClaim, other: OperationIdClaim): boolean {
  return (
    claim.terminal !== undefined &&
    claim.terminal === other.terminal &&
    claim.method === other.method &&
    claim.mount !== other.mount &&
    claim.within !== undefined &&
    claim.within === other.within
  );
}

/**
 * The suffix that tells an optional param's shorter path from its full one:
 * `Without` and the camelCase names of the params `template` drops, joined by
 * `And` (`/x/{a}/{b}` against `/x/{b}` is `"WithoutA"`; against `/x` it is
 * `"WithoutAAndB"`).
 */
function withoutSuffix(
  full: OpenApiPathTemplate,
  template: OpenApiPathTemplate,
): string {
  const kept = new Set(template.params.map((param) => param.name));
  const words = full.params
    .filter((param) => !kept.has(param.name))
    .map((param) => param.name.replace(/^./, (c) => c.toUpperCase()));
  return `Without${words.join("And")}`;
}

/**
 * The suffix that tells a later mount's operation from the first mount's:
 * the segments of `mount` where it differs from `first` (the common leading
 * and trailing segments dropped; all of `mount` when nothing is left), as the
 * default operation id spells a path — camelCase words, a param as
 * `By<Name>`. `"/v2/users"` against `"/users"` is `"V2"`; `"/api/v2"`
 * against `"/api/v1"` is `"V2"`; `"/orgs/:org"` against `"/teams"` is
 * `"OrgsByOrg"`. `""` when `mount` has no words (the root mount).
 */
function mountSuffix(mount: string, first: string): string {
  const own = mount.split("/").filter((segment) => segment !== "");
  const theirs = first.split("/").filter((segment) => segment !== "");
  let start = 0;
  while (
    start < own.length &&
    start < theirs.length &&
    own[start] === theirs[start]
  ) {
    start++;
  }
  let end = own.length;
  let theirEnd = theirs.length;
  while (
    end > start &&
    theirEnd > start &&
    own[end - 1] === theirs[theirEnd - 1]
  ) {
    end--;
    theirEnd--;
  }
  const differing = end > start ? own.slice(start, end) : own;
  // As a template, for the default id's word rule: an Express param
  // (`:org`, `*rest`, a routejs `:id(\d+)` or `:id?`) as `{org}`, and an
  // optional group's braces as separators.
  const template = `/${differing.join("/")}`
    .replace(/[{}]/g, "/")
    .replace(/[:*]([\p{L}\p{N}_$]+)(?:\([^)]*\))?\??/gu, "{$1}");
  return defaultOperationId("", template);
}

/** Whether a converted JSON Schema describes an array (bun-jobs' emission rule). */
function isArraySchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const type = (schema as { type?: unknown }).type;
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

/** The media type a body with files is documented as. */
const MULTIPART = "multipart/form-data";

/** Whether `value` is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A `.describe()` response entry, normalised to the object form. */
function normalizeResponseDoc(
  spec: RouteResponseDoc | StandardSchemaV1 | DtoClass | null,
): RouteResponseDoc | null {
  if (spec === null) return null;
  // A bare Standard Schema (or a DTO class, AD (b2)) is the shorthand for
  // `{ schema }`. A bare plain object reads as a RouteResponseDoc — a raw
  // JSON Schema goes under `schema:` (the two cannot be told apart safely).
  if (isSchema(spec) || isDtoClass(spec)) return { schema: spec };
  return spec;
}

/**
 * Builds the OpenAPI 3.1 document for a router's routes.
 *
 * Reads `listRoutes(router)` (bun-validate V12 — the discovery and contract
 * side are its, including the middleware replay) and merges what it finds
 * with `.describe()` docs. `router.routes()` is read once more to find each
 * route's terminal callback for the `.describe()` lookup; register every
 * route before calling.
 *
 * @param router  The router (or adapter) to document.
 * @param options See {@link OpenApiOptions}.
 * @throws ConfigError on a genuine configuration mistake (a duplicate
 *   operation id — one route at several mounts is not one, see
 *   {@link OpenApiOptions.operationId} — a security requirement naming an
 *   undeclared scheme), and —
 *   under `strict: "strict"` — on any warning.
 */
export function generateOpenApi(
  router: BunRouter,
  options: OpenApiOptions,
): OpenApiResult {
  const strict = options.strict === "strict";
  const warnings: DocWarning[] = [];
  const warn = (
    stage: DocWarning["stage"],
    message: string,
    route?: string,
  ): void => {
    warnings.push({
      stage,
      message,
      ...(route === undefined ? {} : { route }),
    });
  };

  // The contract merges' own warnings (a part refined by an inner layer)
  // become DocWarnings too.
  const collecting: LoggerLike = {
    log: () => {},
    error: () => {},
    warn: (message: unknown, fields?: unknown) => {
      warn(
        "request",
        fields === undefined
          ? String(message)
          : `${String(message)} ${JSON.stringify(fields)}`,
      );
    },
  };

  const routes = listRoutes(router, { logger: collecting });
  // Read once, for the terminal-callback lookups; `ListedRoute.routeIndex`
  // indexes into exactly this table.
  const table = router.routes();

  /* ---------------------------------------------------------------- *
   * Components: every schema goes through toJsonSchema + liftComponents;
   * the lifted components accumulate here, with cross-schema name
   * collisions renamed deterministically (first claim keeps the name).
   * ---------------------------------------------------------------- */
  const components = new Map<string, JsonSchemaLike>();
  const claimed = new Map<string, string>(); // name → canonical body

  /** Rewrites `#/components/schemas/<name>` refs through `rename`. */
  const rewriteRefs = (
    node: unknown,
    rename: ReadonlyMap<string, string>,
  ): unknown => {
    if (Array.isArray(node)) {
      return node.map((child) => rewriteRefs(child, rename));
    }
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string") {
        const prefix = "#/components/schemas/";
        out[key] = child.startsWith(prefix)
          ? (() => {
              const name = child.slice(prefix.length);
              const renamed = rename.get(name);
              return renamed === undefined ? child : `${prefix}${renamed}`;
            })()
          : child;
        continue;
      }
      out[key] = rewriteRefs(child, rename);
    }
    return out;
  };

  /**
   * Registers a lifted batch, resolving name collisions against every schema
   * emitted so far, and returns the (possibly rewritten) schema to place.
   */
  const registerBatch = (
    batch: LiftedSchema,
    route: string | undefined,
  ): JsonSchemaLike => {
    const rename = new Map<string, string>();
    const bodies: [string, JsonSchemaLike][] = [];
    for (const [name, body] of Object.entries(batch.components)) {
      const canonical = canonicalJson(body);
      const existing = claimed.get(name);
      if (existing === canonical) {
        continue; // the same schema under the same name: dedup, drop the copy
      }
      let finalName = name;
      if (existing !== undefined) {
        let suffix = 2;
        while (
          claimed.has(`${name}${suffix}`) &&
          claimed.get(`${name}${suffix}`) !== canonical
        ) {
          suffix++;
        }
        finalName = `${name}${suffix}`;
        warn(
          "operation",
          `two schemas claimed the component name "${name}"; the later one was renamed "${finalName}"`,
          route,
        );
        rename.set(name, finalName);
      }
      if (!claimed.has(finalName)) {
        claimed.set(finalName, canonical);
        bodies.push([finalName, body]);
      }
    }
    let schema = batch.schema;
    if (rename.size > 0) {
      schema = rewriteRefs(schema, rename) as JsonSchemaLike;
      for (const [index, [name, body]] of bodies.entries()) {
        bodies[index] = [name, rewriteRefs(body, rename) as JsonSchemaLike];
      }
    }
    for (const [name, body] of bodies) {
      components.set(name, body);
    }
    return schema;
  };

  /**
   * Converts one schema and shapes it for the document. A schema named by
   * `options.componentName` (or carrying `$id`/`title`) is emitted once under
   * `components.schemas` and referenced; anything else inlines. A raw DTO
   * class (AD (b2)) is wrapped with `fromDto` first, so the registry's
   * `"class-validator"` converter reaches the class through the WeakMap —
   * and an unregistered adapter is the ConfigError naming `useClassDtos`.
   */
  const emitSchema = (
    schema: StandardSchemaV1 | JsonSchemaLike | DtoClass,
    direction: SchemaDirection,
    where: string,
    route: string | undefined,
  ): JsonSchemaLike => {
    const given = isDtoClass(schema) ? fromDto(schema) : schema;
    let json: JsonSchemaLike;
    if (isSchema(given)) {
      // `isSchema` narrows to its guard, not StandardSchemaV1 — cast back.
      json = toJsonSchema(given as StandardSchemaV1, {
        direction,
        ...(options.converters === undefined
          ? {}
          : { converters: options.converters }),
        onWarning: (warning) =>
          warn("operation", `${where}: ${warning.message}`, route),
      });
    } else if (isPlainObject(given)) {
      json = structuredClone(given);
    } else {
      warn("operation", `${where}: not a schema; emitted {}`, route);
      json = {};
    }
    const name =
      options.componentName?.(given) ??
      (typeof json.$id === "string" ? json.$id : undefined) ??
      (typeof json.title === "string" ? json.title : undefined);
    const lifted = liftComponents(json, {
      ...(name === undefined ? {} : { name }),
      onWarning: (warning) =>
        warn("operation", `${where}: ${warning.message}`, route),
    });
    let body = registerBatch(lifted, route);
    if (name !== undefined) {
      // The root goes under its name: either liftComponents already lifted it
      // (a root-relative ref), or register the body here.
      if (!(
        typeof body.$ref === "string" &&
        body.$ref.startsWith("#/components/schemas/")
      )) {
        const canonical = canonicalJson(body);
        const existing = claimed.get(name);
        let finalName = name;
        if (existing !== undefined && existing !== canonical) {
          let suffix = 2;
          while (
            claimed.has(`${name}${suffix}`) &&
            claimed.get(`${name}${suffix}`) !== canonical
          ) {
            suffix++;
          }
          finalName = `${name}${suffix}`;
          warn(
            "operation",
            `two schemas claimed the component name "${name}"; the later one was renamed "${finalName}"`,
            route,
          );
        }
        if (!claimed.has(finalName)) {
          claimed.set(finalName, canonical);
          components.set(finalName, body);
        }
        body = { $ref: `#/components/schemas/${finalName}` };
      }
    }
    return body;
  };

  /** The converted form of a `.describe()`/contract schema, for comparison. */
  const canonicalOf = (
    schema: StandardSchemaV1 | JsonSchemaLike | DtoClass,
    direction: SchemaDirection,
  ): string => {
    const given = isDtoClass(schema) ? fromDto(schema) : schema;
    if (isSchema(given)) {
      // `isSchema` narrows to its guard, not StandardSchemaV1 — cast back.
      return canonicalJson(
        toJsonSchema(given as StandardSchemaV1, {
          direction,
          ...(options.converters === undefined
            ? {}
            : { converters: options.converters }),
        }),
      );
    }
    return canonicalJson(given);
  };

  /* ---------------------------------------------------------------- *
   * The paths walk.
   * ---------------------------------------------------------------- */
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Map<string, OperationIdClaim>(); // id → its claim
  const tagsUsed: string[] = [];

  /** Parameters from a converted object schema's properties. */
  const parametersFrom = (
    json: JsonSchemaLike,
    location: "query" | "header" | "cookie",
    note: string | undefined,
  ): Record<string, unknown>[] => {
    const properties = isPlainObject(json.properties) ? json.properties : {};
    const required = new Set(
      Array.isArray(json.required) ? (json.required as string[]) : [],
    );
    const out: Record<string, unknown>[] = [];
    for (const [name, property] of Object.entries(properties)) {
      const schema = isPlainObject(property) ? property : {};
      out.push({
        name,
        in: location,
        required: required.has(name) && schema.default === undefined,
        ...(typeof schema.description === "string" || note !== undefined
          ? {
              description: [schema.description, note]
                .filter((part) => typeof part === "string" && part !== "")
                .join(" "),
            }
          : {}),
        schema,
        ...(isArraySchema(schema) &&
        (location === "query" || location === "cookie")
          ? { style: "form", explode: true }
          : {}),
      });
    }
    return out;
  };

  for (const route of routes) {
    const record = table[route.routeIndex] as
      { callbacks?: unknown[] } | undefined;
    const terminal = record?.callbacks?.at(-1);
    const doc = routeDocFor(terminal);
    if (doc?.hidden === true) continue;
    if (options.filter !== undefined && !options.filter(route)) continue;
    if (route.contract !== undefined && route.contract.transport !== "http") {
      warn(
        "operation",
        `${route.key} is a "${route.contract.transport}" route; OpenAPI documents HTTP only — skipped`,
        route.key,
      );
      continue;
    }
    if (route.method === "ALL") {
      warn(
        "operation",
        "an `all()` route matches every method; OpenAPI has no such operation — skipped",
        route.key,
      );
      continue;
    }
    if (route.partial === true) {
      warn(
        "operation",
        "no concrete request path could be synthesized for this route (a regex constraint or host scope), so the middleware before it was not replayed; the document uses the route's own callbacks alone",
        route.key,
      );
    }

    const pathResult = toOpenApiPath(route.path, {
      ...(options.optionalParams === undefined
        ? {}
        : { optionalParams: options.optionalParams }),
    });
    for (const message of pathResult.warnings) {
      warn("path", message, route.key);
    }
    if (pathResult.undocumentable !== undefined) {
      warn(
        "path",
        `${route.path}: ${pathResult.undocumentable} — the route is left out of the document`,
        route.key,
      );
      continue;
    }

    /* ------------------------------------------------------------ *
     * The request: discovered inbound rows, with `.describe({ request })`
     * replacing a target wholesale.
     * ------------------------------------------------------------ */
    const inbound = (route.contract?.entries ?? []).filter(
      (entry) => entry.side === "inbound",
    );
    const rowFor = (part: string): ContractEntry | undefined =>
      inbound.find((entry) => entry.part === part && entry.schema !== null);
    const bodyRows = inbound.filter(
      (entry) => entry.part === "body" && entry.schema !== null,
    );

    /** A `.describe()` override for a target, with the disagreement warning. */
    const overrideFor = (
      target: "params" | "query" | "headers" | "cookies",
      row: ContractEntry | undefined,
    ): JsonSchemaLike | undefined => {
      const given = doc?.request?.[target];
      if (given === undefined) return undefined;
      const checking =
        row?.schema != null &&
        row.vendor !== "bun-common/documented" &&
        row.implicit !== true
          ? row.schema
          : undefined;
      if (
        checking !== undefined &&
        canonicalOf(checking, "input") !== canonicalOf(given, "input")
      ) {
        warn(
          "request",
          `.describe() request.${target} disagrees with the validator's schema; the .describe() one is documented (a .describe() request schema documents without enforcing)`,
          route.key,
        );
      }
      return isSchema(given) || isDtoClass(given)
        ? emitSchema(given, "input", `request.${target}`, route.key)
        : structuredClone(given);
    };

    const direction: SchemaDirection =
      route.responseOutput === "parsed" ? "output" : "input";

    /* The typed client's extensions (typed-client plan §3.0, §8.2), once per
     * route: an optional param's two templates carry the same ones. */
    const bunExtensions = bunExtensionsFor(route, doc, warn);

    /* What this route's operation id claim records (see `isRemount`). */
    const mount = mountOf(record);
    const claim: OperationIdClaim = {
      key: route.key,
      method: route.method,
      terminal,
      mount,
      within: pathWithinMount(route.path, mount),
    };

    for (const template of pathResult.templates) {
      const method = route.method.toLowerCase();
      const item = (paths[template.path] ??= {});
      if (Object.hasOwn(item, method)) {
        warn(
          "operation",
          `two routes are registered for ${route.method} ${template.path}; the first one wins the paths entry`,
          route.key,
        );
        continue;
      }

      /* The parameters. */
      const parameters: Record<string, unknown>[] = [];
      const paramsJson = ((): JsonSchemaLike | undefined => {
        const override = overrideFor("params", rowFor("params"));
        if (override !== undefined) return override;
        const row = rowFor("params");
        return row?.schema != null
          ? emitSchema(row.schema, "input", "request.params", route.key)
          : undefined;
      })();
      const paramProperties = isPlainObject(paramsJson?.properties)
        ? paramsJson.properties
        : {};
      for (const name of Object.keys(paramProperties)) {
        if (!template.params.some((param) => param.name === name)) {
          warn(
            "request",
            `the params schema declares "${name}", which the path does not have — dropped`,
            route.key,
          );
        }
      }
      for (const param of template.params) {
        const property = isPlainObject(paramProperties[param.name])
          ? (paramProperties[param.name] as JsonSchemaLike)
          : undefined;
        let schema: JsonSchemaLike =
          property === undefined ? { type: "string" } : { ...property };
        if (param.pattern !== undefined && schema.pattern === undefined) {
          schema = { ...schema, pattern: param.pattern };
        }
        const description = schema.description;
        parameters.push({
          name: param.name,
          in: "path",
          required: true,
          ...(typeof description === "string" ? { description } : {}),
          schema,
        });
      }

      const queryJson =
        overrideFor("query", rowFor("query")) ??
        (rowFor("query")?.schema != null
          ? emitSchema(
              rowFor("query")!.schema!,
              "input",
              "request.query",
              route.key,
            )
          : undefined);
      if (queryJson !== undefined) {
        parameters.push(...parametersFrom(queryJson, "query", undefined));
      }
      const headersJson =
        overrideFor("headers", rowFor("headers")) ??
        (rowFor("headers")?.schema != null
          ? emitSchema(
              rowFor("headers")!.schema!,
              "input",
              "request.headers",
              route.key,
            )
          : undefined);
      if (headersJson !== undefined) {
        parameters.push(...parametersFrom(headersJson, "header", undefined));
      }
      const cookiesJson =
        overrideFor("cookies", rowFor("cookies")) ??
        (rowFor("cookies")?.schema != null
          ? emitSchema(
              rowFor("cookies")!.schema!,
              "input",
              "request.cookies",
              route.key,
            )
          : undefined);
      if (cookiesJson !== undefined) {
        parameters.push(...parametersFrom(cookiesJson, "cookie", undefined));
      }
      const signedRow = rowFor("signedCookies");
      if (signedRow?.schema != null) {
        const signedJson = emitSchema(
          signedRow.schema,
          "input",
          "request.signedCookies",
          route.key,
        );
        parameters.push(
          ...parametersFrom(signedJson, "cookie", "A signed cookie."),
        );
      }

      /* The request body, and the multipart body's files. */
      const files = doc?.request?.files;
      let requestBody: Record<string, unknown> | undefined;
      if (doc?.request?.body !== undefined) {
        const given = doc.request.body;
        const checking = bodyRows.find(
          (row) =>
            row.vendor !== "bun-common/documented" && row.implicit !== true,
        );
        if (
          checking?.schema != null &&
          canonicalOf(checking.schema, "input") !== canonicalOf(given, "input")
        ) {
          warn(
            "request",
            ".describe() request.body disagrees with the validator's schema; the .describe() one is documented (a .describe() request schema documents without enforcing)",
            route.key,
          );
        }
        const mediaTypes =
          doc.requestMediaTypes ??
          (files === undefined ? ["application/json"] : [MULTIPART]);
        const content: Record<string, unknown> = {};
        for (const mediaType of mediaTypes) {
          content[mediaType] = {
            schema: emitSchema(given, "input", "request.body", route.key),
          };
        }
        requestBody = {
          required: doc.requestRequired ?? true,
          content,
        };
      } else if (
        bodyRows.length === 1 &&
        bodyRows[0].mediaType === undefined &&
        (doc?.requestMediaTypes !== undefined || files !== undefined)
      ) {
        /* A validator's body declares no media type (JSON by default):
         * `requestMediaTypes`, or the files' multipart, re-homes it. */
        const row = bodyRows[0];
        const placement = bodyPlacement(row);
        const mediaTypes = doc?.requestMediaTypes ?? [MULTIPART];
        const content: Record<string, unknown> = {};
        for (const mediaType of mediaTypes) {
          content[mediaType] = {
            schema: emitSchema(row.schema!, "input", "request.body", route.key),
          };
        }
        requestBody = {
          required: doc?.requestRequired ?? placement.required,
          content,
        };
      } else if (bodyRows.length > 0) {
        const content: Record<string, unknown> = {};
        let required = false;
        for (const row of bodyRows) {
          const placement = bodyPlacement(row);
          required ||= placement.required;
          content[placement.mediaType] = {
            schema: emitSchema(row.schema!, "input", "request.body", route.key),
          };
        }
        requestBody = { required, content };
      } else if (files !== undefined) {
        /* Files and no fields: a multipart body of files alone. */
        const content: Record<string, unknown> = {};
        for (const mediaType of doc?.requestMediaTypes ?? [MULTIPART])
          content[mediaType] = {};
        requestBody = { required: doc?.requestRequired ?? false, content };
      }
      if (files !== undefined && requestBody !== undefined) {
        addFiles(requestBody, files, (message) =>
          warn("request", message, route.key),
        );
      }

      /* ------------------------------------------------------------ *
       * The responses: the contract's outbound rows, with
       * `.describe({ responses })` merged under them (Decision 4).
       * ------------------------------------------------------------ */
      const responses = buildResponses(
        route,
        doc,
        direction,
        emitSchema,
        canonicalOf,
        warn,
      );

      /* The operation id: declared, else the caller's namer, else derived.
       * A declared id (`.describe()`, a registry's property name) lives on
       * the terminal callback, so a route mounted twice declares it twice:
       * the first mount keeps it, each later one gets its mount's suffix.
       * Any other duplicate is a ConfigError. */
      const declared = doc?.operationId;
      const named = declared ?? options.operationId?.(route);
      /* A derived id already differs per path; a declared or named one is
       * the route's, and is shared by an optional param's paths. */
      const derived = named === undefined;
      let operationId =
        named ?? defaultOperationId(route.method, template.path);
      let owner = operationIds.get(operationId);
      if (
        declared !== undefined &&
        owner !== undefined &&
        owner.key !== route.key &&
        isRemount(claim, owner)
      ) {
        const suffix = mountSuffix(claim.mount, owner.mount);
        if (suffix === "") {
          throw new ConfigError(
            `The operation id "${declared}" is declared on a route mounted twice (${owner.key} and ${route.key}), and the mount "${claim.mount}" has no words to tell the two apart; mount it under a named path`,
            {
              operationId: declared,
              first: owner.key,
              second: route.key,
            },
          );
        }
        operationId = `${declared}${suffix}`;
        owner = operationIds.get(operationId);
      }
      /* An optional param documents the route on several paths; the first
       * (every param present) keeps the id, the others name what they drop. */
      if (!derived && template !== pathResult.templates[0]) {
        operationId = `${operationId}${withoutSuffix(pathResult.templates[0], template)}`;
        owner = operationIds.get(operationId);
      }
      if (owner !== undefined && owner.key !== route.key) {
        throw new ConfigError(
          `Two routes share the operation id "${operationId}" (${owner.key} and ${route.key})`,
          { operationId, first: owner.key, second: route.key },
        );
      }
      operationIds.set(operationId, claim);

      for (const tag of doc?.tags ?? []) {
        if (!tagsUsed.includes(tag)) tagsUsed.push(tag);
      }

      item[method] = {
        operationId,
        ...(doc?.summary === undefined ? {} : { summary: doc.summary }),
        ...(doc?.description === undefined
          ? {}
          : { description: doc.description }),
        ...(doc?.tags === undefined ? {} : { tags: [...doc.tags] }),
        ...(doc?.deprecated === true ? { deprecated: true } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody === undefined ? {} : { requestBody }),
        responses,
        ...(doc?.security === undefined
          ? {}
          : { security: doc.security.map((r) => ({ ...r })) }),
        ...(doc?.extensions === undefined ? {} : { ...doc.extensions }),
        ...bunExtensions,
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * The document.
   * ---------------------------------------------------------------- */
  const security = openApiSecurity(
    options.securitySchemes === undefined && options.security === undefined
      ? {}
      : {
          ...(options.securitySchemes === undefined
            ? {}
            : { securitySchemes: options.securitySchemes }),
          ...(options.security === undefined
            ? {}
            : { security: options.security }),
        },
  );

  const document: OpenApiDocument = {
    openapi: "3.1.2",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.info === undefined ? {} : { ...options.info }),
    },
    servers: structuredClone(options.servers ?? [{ url: "/" }]),
    ...(tagsUsed.length > 0
      ? {
          tags: tagsUsed.map((name) => ({
            name,
            ...(options.tags?.[name] === undefined
              ? {}
              : { ...options.tags[name] }),
          })),
        }
      : {}),
    paths,
    ...(components.size > 0 || security.securitySchemes !== undefined
      ? {
          components: {
            ...(components.size > 0
              ? {
                  schemas: Object.fromEntries(
                    [...components].sort(([a], [b]) => (a < b ? -1 : 1)),
                  ),
                }
              : {}),
            ...(security.securitySchemes === undefined
              ? {}
              : { securitySchemes: security.securitySchemes }),
          },
        }
      : {}),
    ...(security.security === undefined ? {} : { security: security.security }),
  };

  pruneSchemaComponents(
    document as unknown as Parameters<typeof pruneSchemaComponents>[0],
  );
  const dangling = danglingRefs(document);
  if (dangling.length > 0) {
    warn(
      "operation",
      `the document has ${dangling.length} dangling $ref(s): ${dangling.join(", ")}`,
    );
  }

  if (strict && warnings.length > 0) {
    throw new ConfigError(
      `generateOpenApi() in strict mode: ${warnings.length} warning(s):\n${warnings
        .map(
          (warning) =>
            `- [${warning.stage}]${warning.route === undefined ? "" : ` ${warning.route}:`} ${warning.message}`,
        )
        .join("\n")}`,
      { warnings: warnings.map((warning) => ({ ...warning })) },
    );
  }
  return { document, warnings };
}

/** The extension carrying the route's key (typed-client plan §3.0). */
const ROUTE_KEY_EXTENSION = "x-bun-route-key";
/** The extension carrying `.describe({ errors })` (typed-client plan §4.3). */
const ERRORS_EXTENSION = "x-bun-errors";
/** The extension carrying `.describe({ cache })` (typed-client plan §6.4). */
const CACHE_EXTENSION = "x-bun-cache";

/**
 * The operation's `x-bun-*` extensions (typed-client plan §3.0, §8.2), which
 * a typed client reads beside the standard fields:
 *
 * - `x-bun-route-key`, always: the listing's key (`"GET /users/:id"`), the
 *   Express-syntax path a client's route map is keyed by. It is the
 *   generator's own: a `.describe({ extensions })` value for it is dropped,
 *   with a warning when it differs.
 * - `x-bun-errors`, from `.describe({ errors })`: the error codes, in order.
 * - `x-bun-cache`, from `.describe({ cache })`: `{ tags?, invalidates? }`,
 *   each template checked against the route's own params.
 *
 * The typed fields win over a hand-written extension of the same name, with
 * a warning when the two differ; a hand-written one alone passes through
 * verbatim, as every extension does.
 */
function bunExtensionsFor(
  route: ListedRoute,
  doc: RouteDoc | undefined,
  warn: Warn,
): Record<string, unknown> {
  const given: Readonly<Record<string, unknown>> = doc?.extensions ?? {};
  const out: Record<string, unknown> = {};

  /** Warns when a hand-written extension disagrees with the generated value. */
  const agree = (name: string, value: unknown, source: string): void => {
    if (
      Object.hasOwn(given, name) &&
      canonicalJson(given[name]) !== canonicalJson(value)
    ) {
      warn(
        "operation",
        `.describe() extensions set "${name}", which ${source} also sets; ${source} wins`,
        route.key,
      );
    }
  };

  agree(ROUTE_KEY_EXTENSION, route.key, "the generator");
  out[ROUTE_KEY_EXTENSION] = route.key;

  /** A declared list, its non-strings dropped with a warning. */
  const strings = (list: unknown, field: string): string[] => {
    if (!Array.isArray(list)) {
      warn(
        "operation",
        `.describe() ${field} is not an array of strings; emitted []`,
        route.key,
      );
      return [];
    }
    const kept: string[] = [];
    for (const item of list as unknown[]) {
      if (typeof item === "string") {
        kept.push(item);
      } else {
        warn(
          "operation",
          `.describe() ${field} holds a non-string (${typeof item}); dropped`,
          route.key,
        );
      }
    }
    return kept;
  };

  if (doc?.errors !== undefined) {
    const errors = strings(doc.errors, "errors");
    agree(ERRORS_EXTENSION, errors, ".describe({ errors })");
    out[ERRORS_EXTENSION] = errors;
  }

  if (doc?.cache !== undefined) {
    const cache: Record<string, string[]> = {};
    for (const field of ["tags", "invalidates"] as const) {
      const list = doc.cache[field];
      if (list === undefined) continue;
      const templates = strings(list, `cache.${field}`);
      for (const template of templates) {
        for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
          if (!route.params.includes(match[1])) {
            warn(
              "operation",
              `.describe() cache.${field} template "${template}" names {${match[1]}}, which is not a param of the path; emitted as written`,
              route.key,
            );
          }
        }
      }
      cache[field] = templates;
    }
    agree(CACHE_EXTENSION, cache, ".describe({ cache })");
    out[CACHE_EXTENSION] = cache;
  }
  return out;
}

/** What {@link buildResponses} takes along, to keep its signature readable. */
type EmitSchema = (
  schema: StandardSchemaV1 | JsonSchemaLike | DtoClass,
  direction: SchemaDirection,
  where: string,
  route: string | undefined,
) => JsonSchemaLike;

type Warn = (
  stage: DocWarning["stage"],
  message: string,
  route?: string,
) => void;

/**
 * One status's responses object entry, from the contract's outbound rows
 * merged with `.describe({ responses })` (Decision 4: the validator wins a
 * disagreement, with a warning).
 */
function buildResponses(
  route: ListedRoute,
  doc: RouteDoc | undefined,
  direction: SchemaDirection,
  emitSchema: EmitSchema,
  canonicalOf: (
    schema: StandardSchemaV1 | JsonSchemaLike | DtoClass,
    direction: SchemaDirection,
  ) => string,
  warn: Warn,
): Record<string, unknown> {
  const contract = route.contract;
  const outbound = (contract?.entries ?? []).filter(
    (entry) => entry.side === "outbound",
  );
  const keys =
    contract?.sides.outbound?.keys ??
    [...new Set(outbound.map((entry) => entry.key ?? ""))].filter(
      (key) => key !== "",
    );
  const variantsTable = contract?.sides.outbound?.variants ?? {};

  const responses: Record<string, unknown> = {};

  for (const key of keys) {
    const rows = outbound.filter((entry) => entry.key === key);
    const status = Number(key);
    const variants = variantsTable[key];
    const implicit =
      rows.length > 0 && rows.every((row) => row.implicit === true);

    /* Headers: one row per variant (or one for a plain status). */
    const headers: Record<string, unknown> = {};
    /** Header name → the variants declaring it (undefined = all of them). */
    const headerVariants = new Map<string, string[] | undefined>();
    const cookieNames = new Map<string, string[] | undefined>();
    for (const row of rows) {
      if (row.schema === null) continue;
      if (row.part === "headers") {
        const json = emitSchema(
          row.schema,
          direction,
          `response ${key} headers`,
          route.key,
        );
        const properties = isPlainObject(json.properties)
          ? json.properties
          : {};
        const required = new Set(
          Array.isArray(json.required) ? (json.required as string[]) : [],
        );
        for (const [name, property] of Object.entries(properties)) {
          const schema = isPlainObject(property) ? property : {};
          const declares = headerVariants.get(name);
          if (declares !== undefined || headerVariants.has(name)) {
            // Already seen: a non-variant row wins; a variant row merges.
            if (row.variant === undefined) headerVariants.set(name, undefined);
            else if (declares !== undefined) declares.push(row.variant);
            continue;
          }
          headerVariants.set(
            name,
            row.variant === undefined ? undefined : [row.variant],
          );
          headers[name] = {
            ...(typeof schema.description === "string"
              ? { description: schema.description }
              : {}),
            schema,
            ...(variants === undefined
              ? { required: required.has(name) && schema.default === undefined }
              : {}),
          };
        }
      } else if (row.part === "cookies") {
        const json = emitSchema(
          row.schema,
          direction,
          `response ${key} cookies`,
          route.key,
        );
        const properties = isPlainObject(json.properties)
          ? json.properties
          : {};
        for (const name of Object.keys(properties)) {
          const declares = cookieNames.get(name);
          if (declares !== undefined || cookieNames.has(name)) {
            if (row.variant === undefined) cookieNames.set(name, undefined);
            else if (declares !== undefined) declares.push(row.variant);
            continue;
          }
          cookieNames.set(
            name,
            row.variant === undefined ? undefined : [row.variant],
          );
        }
      }
    }
    if (cookieNames.size > 0) {
      const names = [...cookieNames.keys()];
      headers["Set-Cookie"] = {
        description: `Sets the cookie${names.length === 1 ? "" : "s"} ${names
          .map((name) => `\`${name}\``)
          .join(", ")}.`,
        schema: { type: "string" },
      };
    }
    // A variant-only header or cookie is `required: false`, named (plan
    // §4.12 of bun-validate: "a description naming them").
    if (variants !== undefined) {
      for (const [name, declares] of headerVariants) {
        if (declares === undefined) continue;
        const header = headers[name] as Record<string, unknown>;
        header.required = false;
        const note = `Present only in variant${
          declares.length === 1 ? "" : "s"
        }: ${declares.join(", ")}.`;
        header.description =
          typeof header.description === "string"
            ? `${header.description} ${note}`
            : note;
      }
      if (cookieNames.size > 0) {
        const partial = [...cookieNames.entries()].filter(
          ([, declares]) => declares !== undefined,
        );
        if (partial.length > 0) {
          const header = headers["Set-Cookie"] as Record<string, unknown>;
          header.required = false;
          header.description = `${String(header.description)} ${partial
            .map(
              ([name, declares]) =>
                `\`${name}\` only in variant${declares!.length === 1 ? "" : "s"}: ${declares!.join(", ")}`,
            )
            .join("; ")}.`;
        }
      }
    }

    /* Content: one media type per row, `oneOf` across variants. */
    const content: Record<string, unknown> = {};
    const byMedia = new Map<string, ContractEntry[]>();
    for (const row of rows) {
      if (row.part !== "body" || row.schema === null) continue;
      const mediaType = row.mediaType ?? "application/json";
      const list = byMedia.get(mediaType) ?? [];
      list.push(row);
      byMedia.set(mediaType, list);
    }
    /** Media types each variant declares (for `x-variants`). */
    const variantMedia = new Map<string, string[]>();
    for (const [mediaType, mediaRows] of byMedia) {
      if (variants !== undefined) {
        for (const row of mediaRows) {
          if (row.variant === undefined) continue;
          const list = variantMedia.get(row.variant) ?? [];
          if (!list.includes(mediaType)) list.push(mediaType);
          variantMedia.set(row.variant, list);
        }
      }
      const schemas: JsonSchemaLike[] = [];
      const canonical = new Set<string>();
      for (const row of mediaRows) {
        const schema = bodySchemaFor(
          row,
          mediaType,
          direction,
          emitSchema,
          route.key,
        );
        const key2 = canonicalJson(schema);
        if (!canonical.has(key2)) {
          canonical.add(key2);
          schemas.push(schema);
        }
      }
      content[mediaType] = {
        ...(schemas.length === 1
          ? { schema: schemas[0] }
          : { schema: { oneOf: schemas } }),
      };
    }

    const response: Record<string, unknown> = {
      description:
        rows.length > 0 || !Number.isNaN(status)
          ? reasonPhrase(status)
          : "A response.",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(content).length > 0 ? { content } : {}),
      ...(implicit
        ? {
            "x-implicit": true,
          }
        : {}),
    };
    if (implicit) {
      response.description = `${String(response.description)} Declared by the framework (a validator's failure response), not by the route.`;
    }
    if (variants !== undefined) {
      const perVariant: Record<string, unknown> = {};
      for (const name of variants.names) {
        perVariant[name] = {
          ...(variants.descriptions[name] === undefined
            ? {}
            : { description: variants.descriptions[name] }),
          headers: [...headerVariants.entries()]
            .filter(
              ([, declares]) =>
                declares === undefined || declares.includes(name),
            )
            .map(([headerName]) => headerName),
          cookies: [...cookieNames.entries()]
            .filter(
              ([, declares]) =>
                declares === undefined || declares.includes(name),
            )
            .map(([cookieName]) => cookieName),
          mediaTypes: variantMedia.get(name) ?? [],
        };
      }
      response["x-variants"] = {
        names: variants.names,
        conditional: variants.conditional,
        ...(variants.by === undefined ? {} : { by: variants.by }),
        ...(Object.keys(variants.descriptions).length > 0
          ? { descriptions: variants.descriptions }
          : {}),
        variants: perVariant,
      };
    }
    responses[key] = response;
  }

  /* `.describe({ responses })`: statuses the contract declares are merged
   * under it (the validator wins); the rest are verbatim. */
  for (const [statusKey, spec] of Object.entries(doc?.responses ?? {})) {
    const normalised = normalizeResponseDoc(spec);
    const declared = Object.hasOwn(responses, statusKey);
    if (declared) {
      const response = responses[statusKey] as Record<string, unknown>;
      if (normalised === null) {
        warn(
          "response",
          `.describe() declares ${statusKey} as having no body, but the validator declares the status — the validator wins`,
          route.key,
        );
        continue;
      }
      // The validator's status wins; the doc's prose fills in. A body schema
      // in both is compared: disagreement warns, and the validator's stays.
      if (normalised.schema !== undefined) {
        const content = isPlainObject(response.content) ? response.content : {};
        const mediaType = normalised.mediaType ?? "application/json";
        const media = isPlainObject(content[mediaType])
          ? content[mediaType]
          : undefined;
        const validatorSchema = media?.schema;
        if (
          validatorSchema !== undefined &&
          canonicalOf(normalised.schema, direction) !==
            canonicalJson(validatorSchema)
        ) {
          warn(
            "response",
            `.describe() responses.${statusKey} disagrees with the validator's response schema — the validator wins`,
            route.key,
          );
        } else if (validatorSchema === undefined) {
          warn(
            "response",
            `.describe() declares a body for ${statusKey} the validator does not declare — the validator wins (no body documented)`,
            route.key,
          );
        }
      }
      if (normalised.description !== undefined) {
        response.description = normalised.description;
      }
      if (normalised.headers !== undefined) {
        const headers = (response.headers ??= {}) as Record<string, unknown>;
        for (const [name, header] of Object.entries(normalised.headers)) {
          if (!Object.hasOwn(headers, name)) {
            headers[name] = {
              ...(header.description === undefined
                ? {}
                : { description: header.description }),
              schema:
                header.schema === undefined
                  ? { type: "string" }
                  : structuredClone(header.schema),
            };
          }
        }
      }
      continue;
    }
    /* A status only `.describe()` declares: verbatim. */
    if (normalised === null) {
      responses[statusKey] = {
        description: Number.isNaN(Number(statusKey))
          ? "A response."
          : reasonPhrase(Number(statusKey)),
      };
      continue;
    }
    const mediaType = normalised.mediaType ?? "application/json";
    const status = Number(statusKey);
    responses[statusKey] = {
      description:
        normalised.description ??
        (Number.isNaN(status) ? "A response." : reasonPhrase(status)),
      ...(normalised.headers === undefined
        ? {}
        : {
            headers: Object.fromEntries(
              Object.entries(normalised.headers).map(([name, header]) => [
                name,
                {
                  ...(header.description === undefined
                    ? {}
                    : { description: header.description }),
                  schema:
                    header.schema === undefined
                      ? { type: "string" }
                      : structuredClone(header.schema),
                },
              ]),
            ),
          }),
      ...(normalised.schema === undefined
        ? {}
        : {
            content: {
              [mediaType]: {
                schema: emitSchema(
                  normalised.schema,
                  direction,
                  `response ${statusKey}`,
                  route.key,
                ),
                ...(normalised.examples === undefined
                  ? {}
                  : { examples: structuredClone(normalised.examples) }),
              },
            },
          }),
    };
  }

  if (Object.keys(responses).length === 0) {
    warn(
      "response",
      "no responses declared (neither the validator nor .describe() declares any); a placeholder `default` was emitted — strict mode rejects this",
      route.key,
    );
    responses.default = { description: "Unspecified" };
  }
  return Object.fromEntries(
    Object.entries(responses).sort(([a], [b]) => {
      const na = Number(a);
      const nb = Number(b);
      const aNum = !Number.isNaN(na) && String(na) === a;
      const bNum = !Number.isNaN(nb) && String(nb) === b;
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

/** Whether `mediaType` is `multipart/form-data` (parameters and case aside). */
function isMultipart(mediaType: string): boolean {
  return mediaType.split(";")[0].trim().toLowerCase() === MULTIPART;
}

/** Whether a schema is an inline object a file property can join (no `$ref` or combinator to respect). */
function isInlineObject(schema: unknown): schema is Record<string, unknown> {
  return (
    isPlainObject(schema) &&
    schema.type === "object" &&
    schema.$ref === undefined &&
    schema.allOf === undefined &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    (schema.properties === undefined || isPlainObject(schema.properties))
  );
}

/**
 * Adds `RouteDoc.request.files` to each multipart media type of a request
 * body (typed-client plan, `other-transports.md` §3, §6): every file a
 * `{ type: "string", format: "binary" }` property (a list when `maxCount` is
 * above 1), `x-bun-max-bytes` for `maxBytes`, `required` for `required`, and
 * `encoding[field].contentType` for `mediaTypes`. They join an inline object
 * schema of the body's fields; any other fields schema (a `$ref`, a union)
 * is kept whole beside them under `allOf`. A file listed as a required body
 * makes the body required.
 */
function addFiles(
  requestBody: Record<string, unknown>,
  files: NonNullable<NonNullable<RouteDoc["request"]>["files"]>,
  warn: (message: string) => void,
): void {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  const encoding: Record<string, { contentType: string }> = {};
  for (const [name, file] of Object.entries(files)) {
    let count = file.maxCount ?? 1;
    if (
      count !== Number.POSITIVE_INFINITY &&
      !(Number.isInteger(count) && count >= 1)
    ) {
      warn(
        `request.files.${name}: maxCount ${String(count)} is not a positive integer or Infinity; documented as 1`,
      );
      count = 1;
    }
    const one: JsonSchemaLike = {
      type: "string",
      format: "binary",
      ...(file.maxBytes === undefined
        ? {}
        : { "x-bun-max-bytes": file.maxBytes }),
    };
    const described =
      file.description === undefined ? {} : { description: file.description };
    properties[name] =
      count === 1
        ? { ...one, ...described }
        : {
            type: "array",
            items: one,
            ...(Number.isFinite(count) ? { maxItems: count } : {}),
            ...described,
          };
    if (file.required === true) required.push(name);
    if (file.mediaTypes !== undefined && file.mediaTypes.length > 0)
      encoding[name] = { contentType: file.mediaTypes.join(", ") };
  }
  const content = requestBody.content as Record<
    string,
    Record<string, unknown>
  >;
  const multipart = Object.keys(content).filter(isMultipart);
  if (multipart.length === 0) {
    warn(
      `request.files documented, but the body's media types (${Object.keys(content).join(", ")}) include no ${MULTIPART}; the files are left out`,
    );
    return;
  }
  for (const mediaType of multipart) {
    const media = content[mediaType];
    const fields = media.schema;
    const filesObject: JsonSchemaLike = {
      type: "object",
      properties: structuredClone(properties),
      ...(required.length > 0 ? { required: [...required] } : {}),
    };
    let schema: JsonSchemaLike;
    if (fields === undefined) {
      schema = filesObject;
    } else if (isInlineObject(fields)) {
      const own = (fields.properties ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(properties)) {
        if (name in own)
          warn(
            `request.files.${name}: the body's fields declare "${name}" too; the file is documented`,
          );
      }
      const ownRequired = Array.isArray(fields.required)
        ? (fields.required as string[])
        : [];
      const allRequired = [...new Set([...ownRequired, ...required])];
      schema = {
        ...fields,
        properties: { ...own, ...structuredClone(properties) },
        ...(allRequired.length > 0 ? { required: allRequired } : {}),
      };
    } else {
      schema = { allOf: [fields as JsonSchemaLike, filesObject] };
    }
    media.schema = schema;
    if (Object.keys(encoding).length > 0)
      media.encoding = {
        ...((media.encoding as Record<string, unknown> | undefined) ?? {}),
        ...structuredClone(encoding),
      };
  }
  if (required.length > 0) requestBody.required = true;
}

/**
 * The JSON Schema of one outbound body row, by its kind (plan §4.12 M4): a
 * `value` row converts; `chunks` documents its chunk schema with a streaming
 * note and `x-bun-chunks` (its framing, `"ndjson"` or `"raw"`); `sse` documents a `text/event-stream` string with its events listed;
 * `opaque` documents nothing (the body is never read).
 */
function bodySchemaFor(
  row: ContractEntry,
  mediaType: string,
  direction: SchemaDirection,
  emitSchema: EmitSchema,
  route: string | undefined,
): JsonSchemaLike {
  const schema = row.schema;
  if (schema === null) return {};
  if (row.kind === "opaque") {
    return {
      description:
        "An opaque body (a file, an image, a proxied response); its content is not described.",
    };
  }
  if (row.kind === "chunks") {
    const chunk = (schema as { chunk?: unknown }).chunk;
    const framing = (schema as { framing?: unknown }).framing;
    const json = isSchema(chunk)
      ? emitSchema(chunk, direction, `response body (${mediaType})`, route)
      : {};
    return {
      ...json,
      description: [
        typeof json.description === "string" ? json.description : undefined,
        `Streamed: one value per ${
          framing === "ndjson" ? "newline-delimited JSON line" : "chunk"
        }.`,
      ]
        .filter((part): part is string => typeof part === "string")
        .join(" "),
      // How the body is cut into the values this schema describes, for a
      // client to iterate (typed-client plan, other-transports.md §4).
      "x-bun-chunks": framing === "ndjson" ? "ndjson" : "raw",
    };
  }
  if (row.kind === "sse") {
    const events = row.nested?.filter((nested) => nested.part === "data") ?? [];
    return {
      type: "string",
      description: `Server-sent events. Events: ${
        events.length === 0
          ? "unspecified"
          : events.map((event) => `\`${event.key ?? "message"}\``).join(", ")
      }. Each \`data:\` line carries one event's data as ${
        (schema as { data?: unknown }).data === "text" ? "text" : "JSON"
      }.`,
      "x-sse-events": Object.fromEntries(
        events.map((event) => [
          event.key ?? "message",
          event.schema === null
            ? null
            : emitSchema(
                event.schema,
                direction,
                `response body (${mediaType}) event "${event.key ?? "message"}"`,
                route,
              ),
        ]),
      ),
    };
  }
  return emitSchema(schema, direction, `response body (${mediaType})`, route);
}
