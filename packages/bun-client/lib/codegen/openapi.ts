/**
 * OpenAPI 3.1 to the client's route map (typed-client plan §3.0, §3.2, §4,
 * PR-C2): {@link generateRoutes} writes a TypeScript module holding
 *
 * - every `components.schemas` entry as a named type (an `interface` for an
 *   object, a `type` otherwise), so a `$ref` reads as `User` and a
 *   recursive schema recurses through its name;
 * - `Routes`, the flat map `createClient<Routes>()` reads, one entry per
 *   operation keyed `"VERB /path"`: `x-bun-route-key` when the document has
 *   it (bun-common's generator writes it), else the OpenAPI path with
 *   `{id}` as `:id` (a document from any server);
 * - `manifest`, the runtime facts the types cannot carry (`operationId` for
 *   `api.op`, the declared statuses for `undeclaredStatus`, `x-bun-cache`'s
 *   tag templates for the query layer, `./query`), checked against `Routes`
 *   by `RouteManifest<Routes>`.
 *
 * Each entry is the wire side (plan §4.1): `params`, `query`, `headers` and
 * `body` are what a sender writes, `responses` what arrives, which the
 * client reads through `Jsonify`. `x-bun-errors` narrows the `code` of every
 * declared error body (§4.3); `x-bun-cache` becomes `cache`; a response
 * declaring `x-sse-events` (or served as `text/event-stream`) marks the entry
 * `stream: "sse"` with its `events` by name (`sse.md` S-D1).
 *
 * The output is deterministic: routes sorted by path then method, components
 * by name, statuses numerically, events by name; properties keep the
 * document's order. It is formatted as Prettier formats it (`./doc`).
 */
import type { Doc } from "./doc";
import type { SchemaContext } from "./schema";
import type { TsMember, TsType } from "./print";
import { pathParams } from "../path";
import {
  group,
  hardline,
  ifBreak,
  indent,
  join,
  line,
  PRINT_WIDTH,
  printDoc,
  softline,
} from "./doc";
import type { ParsedChannel } from "./asyncapi";
import { readChannels } from "./asyncapi";
import { framingOf, splitMultipart } from "./form";
import { documentsHash } from "./hash";
import { declaredHeaders, isStringSchema } from "./headers";
import { emitZodModule } from "./zod";
import {
  intersection,
  jsDoc,
  keyword,
  NO_KEYS,
  printType,
  printTypeAlias,
  propertyKey,
  quote,
  union,
  UNKNOWN,
} from "./print";
import {
  componentOf,
  isRecord,
  mediaKind,
  resolvePointer,
  schemaDoc,
  schemaToType,
} from "./schema";

/** A problem the generator typed around: what it was, and where. */
export interface CodegenWarning {
  /** Where: a route key and part (`"GET /users/:id response 200"`), a component (`"components.schemas.User"`), or `"document"`. */
  readonly at: string;
  /** What was degraded, and to what. */
  readonly message: string;
}

/** Options for {@link generateRoutes}. */
export interface GenerateRoutesOptions {
  /**
   * The server's AsyncAPI document, when it has one: covered by the header's
   * hash (so it equals the dev endpoint's, plan §3.3), and its WebSocket
   * channels written as `Channels` (their types, the `channel()` client's,
   * `websocket.md` §3) and `channels` (each one's descriptor), with
   * `channelSchemas` in the zod module. Default: none.
   */
  readonly asyncapi?: object;
  /**
   * Warnings the document's producer reported (bun-common's
   * `generateOpenApi` result's `warnings`, for `--module`), copied into the
   * header beside the generator's own. Default: none.
   */
  readonly documentWarnings?: readonly CodegenWarning[];
  /**
   * The module the generated file imports `RouteManifest` from (and the zod
   * module `schemasFromZod`, from its `/zod`). Default:
   * `"@kingsleyweb/bun-client"`.
   */
  readonly clientModule?: string;
  /**
   * Also write the runtime zod module (plan §5.2, PR-C4), returned as the
   * result's `zod`: the built-in schemas the client validates with. Default:
   * none.
   */
  readonly zod?: {
    /** `"mini"` imports `zod/mini`, `"classic"` imports `zod`. Default: `"mini"`. */
    readonly flavour?: "mini" | "classic";
    /**
     * The import specifier the zod module reads `Routes` from: the route map
     * module's path relative to it, without the extension (`"./api.gen"`).
     */
    readonly routesModule: string;
  };
}

/** What {@link generateRoutes} returns. */
export interface GenerateRoutesResult {
  /** The generated module's source, formatted, ending in a newline. */
  readonly code: string;
  /** Everything typed `unknown` or left out, in the order found; also listed in the file's header. */
  readonly warnings: readonly CodegenWarning[];
  /** The documents' hash (bun-common's `typesHash`), recorded in the header. */
  readonly hash: string;
  /** How many routes the map holds. */
  readonly routes: number;
  /** How many channels `Channels` holds (`0` without an AsyncAPI document, or with no WebSocket channel). */
  readonly channels: number;
  /** The zod module, when {@link GenerateRoutesOptions.zod} asked for it. */
  readonly zod?: {
    /** Its source, formatted, ending in a newline. */
    readonly code: string;
    /** What it does not check, in the order found; also listed in its header. */
    readonly warnings: readonly CodegenWarning[];
  };
}

/** The HTTP methods an OpenAPI path item may hold, in the order a path's routes are emitted. */
const METHODS = [
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "trace",
] as const;

/** Names the generated module itself uses, which a component must not take. */
export const RESERVED: ReadonlySet<string> = new Set([
  // TypeScript's own type names and keywords.
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "while",
  "with",
  "type",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
  // What the generated module refers to.
  "Routes",
  "manifest",
  "typesHash",
  "RouteManifest",
  "Channels",
  "channels",
  "ChannelDescriptors",
  "Record",
  "Omit",
  "Blob",
  "FormData",
  "URLSearchParams",
  "ReadableStream",
  "ArrayBuffer",
  "Uint8Array",
]);

/** A component name as a TypeScript identifier: itself when it is one, else PascalCase of its words. */
function identifierFor(name: string): string {
  if (/^[A-Z_$][\w$]*$/i.test(name)) return name;
  const words = name.split(/[^\w$]+/).filter((word) => word !== "");
  let id = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  if (id === "") id = "Schema";
  if (/^\d/.test(id)) id = `_${id}`;
  return id;
}

/**
 * Assigns each component a unique, unreserved identifier, in name order.
 *
 * @param names The component names, sorted.
 * @param reserved Identifiers a component must not take. Default: the
 *   types module's ({@link RESERVED}).
 */
export function componentIdentifiers(
  names: readonly string[],
  reserved: ReadonlySet<string> = RESERVED,
): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const name of names) {
    let id = identifierFor(name);
    if (reserved.has(id)) id = `${id}Schema`;
    let candidate = id;
    for (let n = 2; taken.has(candidate); n++) candidate = `${id}${n}`;
    taken.add(candidate);
    out.set(name, candidate);
  }
  return out;
}

/** A raw request body, as the client passes one through unchanged. */
const RAW_BODY: TsType = union([
  { kind: "ref", name: "Blob" },
  { kind: "ref", name: "ArrayBuffer" },
  {
    kind: "ref",
    name: "ReadableStream",
    args: [{ kind: "ref", name: "Uint8Array" }],
  },
]);

/** One operation found in the document. */
export interface FoundOperation {
  /** The upper-case method. */
  readonly method: string;
  /** The OpenAPI path template, `/users/{id}`. */
  readonly template: string;
  /** The operation object. */
  readonly operation: Record<string, unknown>;
  /** Its parameters, the path item's merged under the operation's, `$ref`s resolved. */
  readonly parameters: readonly Record<string, unknown>[];
}

/** An OpenAPI path template (or an AsyncAPI address) as a route key's path: `{id}` → `:id`. */
export function expressPath(template: string): string {
  let out = "";
  const pattern = /\{([^}]*)\}/g;
  let last = 0;
  const literal = (text: string) =>
    text.replace(/[\\:*{}()?+!]/g, (char) => `\\${char}`);
  for (
    let match = pattern.exec(template);
    match;
    match = pattern.exec(template)
  ) {
    out += literal(template.slice(last, match.index));
    const name = match[1];
    out += /^[A-Z_$][\w$]*$/i.test(name)
      ? `:${name}`
      : `:"${name.replace(/["\\]/g, (char) => `\\${char}`)}"`;
    last = match.index + match[0].length;
  }
  return out + literal(template.slice(last));
}

/** Compares two route keys: by path, then by method in {@link METHODS} order. */
function compareKeys(a: string, b: string): number {
  const [methodA, ...pathA] = a.split(" ");
  const [methodB, ...pathB] = b.split(" ");
  const pa = pathA.join(" ");
  const pb = pathB.join(" ");
  if (pa !== pb) return pa < pb ? -1 : 1;
  const order = (method: string) => {
    const index = (METHODS as readonly string[]).indexOf(method.toLowerCase());
    return index === -1 ? METHODS.length : index;
  };
  const diff = order(methodA) - order(methodB);
  if (diff !== 0) return diff;
  return methodA < methodB ? -1 : methodA > methodB ? 1 : 0;
}

/**
 * Generates the route map module from an OpenAPI 3.1 document (3.0's
 * `nullable` and array-form `items` are read too).
 *
 * @param openapi The document: `generateOpenApi(...).document`, a parsed
 *   `openapi.json`, or the dev endpoint's `openapi`.
 * @param options See {@link GenerateRoutesOptions}.
 * @throws TypeError when `openapi` is not an OpenAPI 3.x document.
 */
export function generateRoutes(
  openapi: object,
  options: GenerateRoutesOptions = {},
): GenerateRoutesResult {
  const document = openapi as Record<string, unknown>;
  if (
    !isRecord(document) ||
    typeof document.openapi !== "string" ||
    !document.openapi.startsWith("3.")
  ) {
    throw new TypeError(
      "generateRoutes(): expected an OpenAPI 3.x document (its `openapi` field names the version)",
    );
  }

  const warnings: CodegenWarning[] = [];
  const warn = (at: string, message: string): void => {
    warnings.push({ at, message });
  };

  const componentSchemas =
    isRecord(document.components) && isRecord(document.components.schemas)
      ? document.components.schemas
      : {};
  const componentNames = Object.keys(componentSchemas).sort();
  const identifiers = componentIdentifiers(componentNames);
  const context: SchemaContext = {
    document,
    componentType: (name) => identifiers.get(name),
    warn,
  };

  /* Components. */
  const declarations: Doc[] = [];
  for (const name of componentNames) {
    const id = identifiers.get(name)!;
    const schema = componentSchemas[name];
    const type = schemaToType(schema, context, `components.schemas.${name}`);
    const doc = schemaDoc(schema);
    const head: Doc = doc === undefined ? [] : [jsDoc(doc), hardline];
    if (type.kind === "object") {
      declarations.push([head, `export interface ${id} `, printType(type)]);
    } else {
      declarations.push([head, printTypeAlias(id, type)]);
    }
  }

  /* Operations, grouped by route key. */
  const byKey = new Map<string, FoundOperation[]>();
  const paths = isRecord(document.paths) ? document.paths : {};
  for (const template of Object.keys(paths)) {
    let item = paths[template];
    if (isRecord(item) && typeof item.$ref === "string") {
      item = resolvePointer(document, item.$ref);
    }
    if (!isRecord(item)) continue;
    const shared = resolveParameters(item.parameters, document, warn, template);
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const own = resolveParameters(
        operation.parameters,
        document,
        warn,
        `${method.toUpperCase()} ${template}`,
      );
      // An operation's parameter replaces the path item's of the same name
      // and location; header names are case-insensitive.
      const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        a.in === b.in &&
        (a.in === "header"
          ? String(a.name).toLowerCase() === String(b.name).toLowerCase()
          : a.name === b.name);
      const parameters = [
        ...shared.filter((param) => !own.some((mine) => same(mine, param))),
        ...own,
      ];
      const key = routeKey(method, template, operation, warn);
      const found: FoundOperation = {
        method: method.toUpperCase(),
        template,
        operation,
        parameters,
      };
      byKey.set(key, [...(byKey.get(key) ?? []), found]);
    }
  }
  const keys = [...byKey.keys()].sort(compareKeys);

  /* Entries and the manifest. */
  const entries: Doc[] = [];
  const manifestEntries: Doc[] = [];
  const operationIds = new Map<string, string>();
  for (const key of keys) {
    const found = byKey.get(key)!;
    const built = buildEntry(key, found, context, warn, operationIds);
    entries.push([
      built.doc === undefined ? [] : [jsDoc(built.doc), hardline],
      quote(key),
      ": ",
      printType(built.type),
      ";",
    ]);
    const facts: Doc[] = [];
    if (built.operationId !== undefined)
      facts.push(`operationId: ${quote(built.operationId)}`);
    if (built.statuses !== undefined)
      facts.push([
        "statuses: ",
        group([
          "[",
          indent([softline, join([",", line], built.statuses.map(String))]),
          ifBreak(","),
          softline,
          "]",
        ]),
      ]);
    if (built.cache !== undefined) {
      const lists: Doc[] = [];
      for (const field of ["tags", "invalidates"] as const) {
        const list = built.cache[field];
        if (list === undefined) continue;
        lists.push([
          `${field}: `,
          group([
            "[",
            indent([softline, join([",", line], list.map(quote))]),
            ifBreak(","),
            softline,
            "]",
          ]),
        ]);
      }
      facts.push([
        "cache: ",
        group([
          "{",
          indent([line, join([",", line], lists)]),
          ifBreak(","),
          line,
          "}",
        ]),
      ]);
    }
    if (built.bodyType !== undefined)
      facts.push(`bodyType: ${quote(built.bodyType)}`);
    if (built.chunks !== undefined)
      facts.push([
        "chunks: ",
        group([
          "{",
          indent([
            line,
            join(
              [",", line],
              built.chunks.map(
                ([status, framing]) => `${status}: ${quote(framing)}`,
              ),
            ),
          ]),
          ifBreak(","),
          line,
          "}",
        ]),
      ]);
    if (facts.length > 0) {
      const object = group([
        "{",
        indent([line, join([",", line], facts)]),
        ifBreak(","),
        line,
        "}",
      ]);
      // Prettier's "fluid" assignment layout: a key so long that `key: {`
      // passes the line's end moves the value to the next line, indented.
      manifestEntries.push(
        2 + quote(key).length + ": {".length > PRINT_WIDTH
          ? [quote(key), ":", indent([hardline, object])]
          : [quote(key), ": ", object],
      );
    }
  }

  /* Channels (websocket.md §3), from the AsyncAPI document. */
  const channelList =
    options.asyncapi === undefined
      ? []
      : readChannels(options.asyncapi, expressPath, warn);
  const channelDocs = channelsDoc(channelList, options.asyncapi ?? {}, warn);

  const hash = documentsHash({
    openapi: document,
    ...(options.asyncapi === undefined ? {} : { asyncapi: options.asyncapi }),
  });
  // Sorted, so the header does not depend on the order the document lists
  // its paths in; the producer's own come first, in its order.
  const allWarnings = [
    ...(options.documentWarnings ?? []),
    ...warnings.toSorted((a, b) =>
      a.at === b.at
        ? a.message < b.message
          ? -1
          : a.message > b.message
            ? 1
            : 0
        : a.at < b.at
          ? -1
          : 1,
    ),
  ];

  const header = [
    "Generated by `bun-client generate` (@kingsleyweb/bun-client) from an",
    "OpenAPI document: the route map `createClient<Routes>()` reads and the",
    "`manifest` it takes. Do not edit; regenerate it, and run the same command",
    "with `--check` in CI.",
    "",
    `typesHash: ${hash}`,
    ...(allWarnings.length === 0
      ? []
      : [
          "",
          "Warnings:",
          ...allWarnings.map(
            (warning) => `- ${warning.at}: ${warning.message}`,
          ),
        ]),
  ].join("\n");

  const routesDoc: Doc =
    entries.length === 0
      ? "export interface Routes {}"
      : [
          "export interface Routes {",
          indent([hardline, join(hardline, entries)]),
          hardline,
          "}",
        ];
  const manifestDoc: Doc = [
    "export const manifest = ",
    manifestEntries.length === 0
      ? "{}"
      : [
          "{",
          indent([hardline, join([",", hardline], manifestEntries), ","]),
          hardline,
          "}",
        ],
    " as const satisfies RouteManifest<Routes>;",
  ];

  const module: Doc = join(
    [hardline, hardline],
    [
      [
        jsDoc(header),
        hardline,
        `import type { RouteManifest } from ${quote(options.clientModule ?? "@kingsleyweb/bun-client")};`,
        channelList.length === 0
          ? []
          : [
              hardline,
              `import type { ChannelDescriptors } from ${quote(`${options.clientModule ?? "@kingsleyweb/bun-client"}/channel`)};`,
            ],
      ],
      // The header's hash as a value: a persisted cache's `buster`
      // (`./persist`, plan §6.4), so a schema change drops it.
      [
        jsDoc(
          "The documents' hash, as the header records it: the `buster` of a\npersisted query cache (`@kingsleyweb/bun-client/persist`).",
        ),
        hardline,
        `export const typesHash = ${quote(hash)};`,
      ],
      ...declarations,
      routesDoc,
      manifestDoc,
      ...channelDocs,
    ],
  );
  const zod =
    options.zod === undefined
      ? undefined
      : emitZodModule({
          document,
          componentNames,
          keys,
          operations: byKey,
          hash,
          flavour: options.zod.flavour ?? "mini",
          routesModule: options.zod.routesModule,
          clientModule: options.clientModule ?? "@kingsleyweb/bun-client",
          channels: channelList,
        });
  return {
    code: `${printDoc(module)}\n`,
    warnings: allWarnings,
    hash,
    routes: keys.length,
    channels: channelList.length,
    ...(zod === undefined ? {} : { zod }),
  };
}

/** A parameter list with `$ref`s resolved; anything that is not a parameter dropped with a warning. */
function resolveParameters(
  list: unknown,
  document: unknown,
  warn: (at: string, message: string) => void,
  at: string,
): Record<string, unknown>[] {
  if (!Array.isArray(list)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of list) {
    let param: unknown = raw;
    if (isRecord(param) && typeof param.$ref === "string") {
      param = resolvePointer(document, param.$ref);
    }
    if (
      isRecord(param) &&
      typeof param.name === "string" &&
      typeof param.in === "string"
    ) {
      out.push(param);
    } else {
      warn(
        at,
        "a parameter that is not one (or does not resolve) was left out",
      );
    }
  }
  return out;
}

/** The operation's route key: `x-bun-route-key` when present and well formed, else derived from the path. */
function routeKey(
  method: string,
  template: string,
  operation: Record<string, unknown>,
  warn: (at: string, message: string) => void,
): string {
  const derived = `${method.toUpperCase()} ${expressPath(template)}`;
  const given = operation["x-bun-route-key"];
  if (given === undefined) return derived;
  if (
    typeof given === "string" &&
    given.startsWith(`${method.toUpperCase()} /`)
  )
    return given;
  warn(
    `${method.toUpperCase()} ${template}`,
    `\`x-bun-route-key\` ${JSON.stringify(given)} is not "${method.toUpperCase()} /…"; keyed "${derived}" instead`,
  );
  return derived;
}

/** A parameter's type: its `schema`, or its `content`'s schema. */
function parameterType(
  param: Record<string, unknown>,
  context: SchemaContext,
  at: string,
): TsType {
  if ("schema" in param) return schemaToType(param.schema, context, at);
  if (isRecord(param.content)) {
    const first = Object.values(param.content)[0];
    if (isRecord(first) && "schema" in first)
      return schemaToType(first.schema, context, at);
  }
  return keyword("string");
}

/** What {@link buildEntry} returns. */
interface BuiltEntry {
  /** The entry's type. */
  readonly type: TsType;
  /** The JSDoc above it. */
  readonly doc?: string;
  /** Its `operationId`, kept for `api.op`. */
  readonly operationId?: string;
  /** Its declared statuses, for the manifest; `undefined` when none is numeric. */
  readonly statuses?: readonly number[];
  /** Its `x-bun-cache` lists, for the manifest (the query layer's tags); `undefined` when it has none. */
  readonly cache?: {
    /** The tag templates the response is filed under. */
    readonly tags?: readonly string[];
    /** The tag templates a successful call invalidates. */
    readonly invalidates?: readonly string[];
  };
  /** How a plain-object body is sent, when not as JSON. */
  readonly bodyType?: "multipart" | "urlencoded";
  /** The streamed statuses, by framing. */
  readonly chunks?: readonly (readonly [number, "ndjson" | "raw"])[];
}

/** Builds one route's entry from its operations (two when an optional param documents as two paths). */
function buildEntry(
  key: string,
  found: readonly FoundOperation[],
  context: SchemaContext,
  warn: (at: string, message: string) => void,
  operationIds: Map<string, string>,
): BuiltEntry {
  const first = found[0];
  const { operation } = first;
  const members: TsMember[] = [];

  /* operationId: unique across the map. */
  let operationId: string | undefined;
  if (typeof operation.operationId === "string" && operation.operationId) {
    const owner = operationIds.get(operation.operationId);
    if (owner === undefined) {
      operationId = operation.operationId;
      operationIds.set(operationId, key);
      members.push({
        name: "operationId",
        optional: false,
        type: { kind: "literal", value: operationId },
      });
    } else {
      warn(
        key,
        `operationId "${operation.operationId}" is also ${owner}'s; left out of \`api.op\` for this route`,
      );
    }
  }

  /* params: the key's own, typed from the documented path parameters. */
  const keyPath = key.slice(key.indexOf(" ") + 1);
  const documented = new Map<string, Record<string, unknown>>();
  for (const variant of found) {
    for (const param of variant.parameters) {
      if (param.in === "path" && !documented.has(param.name as string))
        documented.set(param.name as string, param);
    }
  }
  const paramMembers: TsMember[] = [];
  const named = new Set<string>();
  for (const info of pathParams(keyPath)) {
    if (named.has(info.name)) continue;
    named.add(info.name);
    const param = documented.get(info.name);
    let type: TsType = info.wildcard
      ? { kind: "array", element: keyword("string") }
      : keyword("string");
    if (param !== undefined && !info.wildcard)
      type = parameterType(param, context, `${key} params.${info.name}`);
    const doc = param === undefined ? undefined : schemaDoc(param);
    paramMembers.push({
      name: info.name,
      optional: info.optional,
      type,
      ...(doc === undefined ? {} : { doc }),
    });
  }
  for (const name of documented.keys()) {
    if (!named.has(name))
      warn(
        key,
        `path parameter "${name}" is not in the route's path; left out`,
      );
  }
  members.push(partMember("params", paramMembers));

  /* query and headers. */
  for (const [part, location] of [
    ["query", "query"],
    ["headers", "header"],
  ] as const) {
    const partMembers: TsMember[] = [];
    const seen = new Set<string>();
    for (const param of first.parameters) {
      if (param.in !== location) continue;
      const name =
        location === "header"
          ? (param.name as string).toLowerCase()
          : (param.name as string);
      if (seen.has(name)) continue;
      seen.add(name);
      const doc = schemaDoc(param);
      partMembers.push({
        name,
        optional: param.required !== true,
        type: parameterType(param, context, `${key} ${part}.${name}`),
        ...(doc === undefined ? {} : { doc }),
      });
    }
    members.push(partMember(part, partMembers));
  }

  /* body, and a multipart body's files. */
  const requestBody = requestBodyParts(
    operation.requestBody,
    context,
    key,
    warn,
  );
  members.push({ name: "body", optional: false, type: requestBody.type });
  if (requestBody.files !== undefined)
    members.push({ name: "files", optional: false, type: requestBody.files });

  /* responses, events, error codes; the headers they declare. */
  const responses = buildResponses(operation, context, key, warn);
  members.push({ name: "responses", optional: false, type: responses.type });
  const responseHeaders = buildResponseHeaders(operation, context, key);
  if (responseHeaders !== undefined)
    members.push({
      name: "responseHeaders",
      optional: false,
      type: responseHeaders,
    });

  /* cache (x-bun-cache). */
  const cache = operation["x-bun-cache"];
  const cacheLists: {
    tags?: readonly string[];
    invalidates?: readonly string[];
  } = {};
  if (cache !== undefined) {
    const cacheMembers: TsMember[] = [];
    if (isRecord(cache)) {
      for (const field of ["tags", "invalidates"] as const) {
        const list = cache[field];
        if (list === undefined) continue;
        if (
          Array.isArray(list) &&
          list.every((item): item is string => typeof item === "string")
        ) {
          cacheLists[field] = list;
          cacheMembers.push({
            name: field,
            optional: false,
            type: {
              kind: "tuple",
              elements: list.map((value) => ({ kind: "literal", value })),
            },
          });
        } else {
          warn(
            key,
            `\`x-bun-cache\`.${field} is not a list of strings; left out`,
          );
        }
      }
    } else {
      warn(key, "`x-bun-cache` is not an object; left out");
    }
    if (cacheMembers.length > 0)
      members.push({
        name: "cache",
        optional: false,
        type: { kind: "object", members: cacheMembers },
      });
  }

  if (responses.stream) {
    members.push({
      name: "stream",
      optional: false,
      type: { kind: "literal", value: "sse" },
    });
    if (responses.events !== undefined)
      members.push({ name: "events", optional: false, type: responses.events });
  }

  const summary =
    typeof operation.summary === "string" && operation.summary.trim()
      ? operation.summary.trim()
      : typeof operation.description === "string" &&
          operation.description.trim()
        ? operation.description.trim()
        : undefined;
  const doc = [
    summary,
    operation.deprecated === true ? "@deprecated" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");

  return {
    type: { kind: "object", members },
    ...(doc === "" ? {} : { doc }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(responses.statuses === undefined
      ? {}
      : { statuses: responses.statuses }),
    ...(Object.keys(cacheLists).length === 0 ? {} : { cache: cacheLists }),
    ...(requestBody.bodyType === undefined
      ? {}
      : { bodyType: requestBody.bodyType }),
    ...(responses.chunks === undefined ? {} : { chunks: responses.chunks }),
  };
}

/** A request part's member: its object type, or `Record<never, never>` for none. */
function partMember(name: string, members: readonly TsMember[]): TsMember {
  return {
    name,
    optional: false,
    type: members.length === 0 ? NO_KEYS : { kind: "object", members },
  };
}

/** What {@link requestBodyParts} returns. */
interface RequestBodyParts {
  /** The type a call's `body` takes. */
  readonly type: TsType;
  /** The type a call's `files` takes; `undefined` when the body has none. */
  readonly files?: TsType;
  /** How a plain-object body is sent, when the body is a form only. */
  readonly bodyType?: "multipart" | "urlencoded";
}

/** A blob, or a list of them: a file field's type. */
const BLOB: TsType = { kind: "ref", name: "Blob" };

/**
 * `requestBody` (or its `$ref`) as the types a call's `body` and `files`
 * take (`other-transports.md` §3): a JSON body's schema; a multipart body's
 * fields (its files taken out into `files`, `Blob` or `Blob[]` each) or a
 * `FormData`; an urlencoded body's fields or a `URLSearchParams` (a
 * pre-built body passes through, unchecked); anything else a raw body. The manifest's
 * `bodyType` says which form a plain-object body is sent as when the route
 * takes no JSON.
 */
function requestBodyParts(
  raw: unknown,
  context: SchemaContext,
  key: string,
  warn: (at: string, message: string) => void,
): RequestBodyParts {
  if (raw === undefined) return { type: keyword("undefined") };
  let body: unknown = raw;
  if (isRecord(body) && typeof body.$ref === "string")
    body = resolvePointer(context.document, body.$ref);
  if (!isRecord(body)) {
    warn(
      key,
      "`requestBody` is not an object (or does not resolve); typed `unknown`",
    );
    return { type: UNKNOWN };
  }
  const content = isRecord(body.content) ? body.content : {};
  const types: TsType[] = [];
  const fileMembers: TsMember[] = [];
  const kinds = new Set<string>();
  let fieldless = false;
  for (const [mediaType, media] of Object.entries(content)) {
    const kind = mediaKind(mediaType);
    kinds.add(kind);
    const schema =
      isRecord(media) && "schema" in media ? media.schema : undefined;
    if (kind === "json") {
      types.push(
        schema === undefined
          ? UNKNOWN
          : schemaToType(schema, context, `${key} body`),
      );
    } else if (kind === "multipart") {
      if (schema === undefined) {
        types.push(UNKNOWN);
        continue;
      }
      const split = splitMultipart(
        schema,
        isRecord(media) ? media.encoding : undefined,
        context,
      );
      // A files-only body has no fields to send: the body is optional.
      if (split.fields === undefined) fieldless = true;
      else types.push(schemaToType(split.fields, context, `${key} body`));
      // A pre-built body still passes through, unchecked (§6.1).
      types.push({ kind: "ref", name: "FormData" });
      for (const file of split.files) {
        if (fileMembers.some((member) => member.name === file.name)) continue;
        fileMembers.push({
          name: file.name,
          optional: !file.required,
          type: file.multiple ? { kind: "array", element: BLOB } : BLOB,
          ...(file.description === undefined ? {} : { doc: file.description }),
        });
      }
    } else if (kind === "form") {
      types.push(
        schema === undefined
          ? UNKNOWN
          : schemaToType(schema, context, `${key} body`),
        { kind: "ref", name: "URLSearchParams" },
      );
    } else {
      types.push(RAW_BODY);
    }
  }
  const type = types.length === 0 ? UNKNOWN : union(types);
  const bodyType = kinds.has("json")
    ? undefined
    : kinds.has("multipart")
      ? "multipart"
      : kinds.has("form")
        ? "urlencoded"
        : undefined;
  return {
    type:
      body.required === true && !fieldless
        ? type
        : union([type, keyword("undefined")]),
    ...(fileMembers.length === 0
      ? {}
      : { files: { kind: "object", members: fileMembers } }),
    ...(bodyType === undefined ? {} : { bodyType }),
  };
}

/** What {@link buildResponses} returns. */
interface BuiltResponses {
  /** `{ 200: User; 404: … }`. */
  readonly type: TsType;
  /** The numeric statuses, for the manifest; `undefined` when there are none. */
  readonly statuses?: readonly number[];
  /** Whether a 2xx response is an event stream. */
  readonly stream: boolean;
  /** The events by name, from `x-sse-events`. */
  readonly events?: TsType;
  /** The statuses whose body streams, by framing, for the manifest. */
  readonly chunks?: readonly (readonly [number, "ndjson" | "raw"])[];
}

/** The operation's responses, by status, with `x-bun-errors` applied to the error bodies. */
function buildResponses(
  operation: Record<string, unknown>,
  context: SchemaContext,
  key: string,
  warn: (at: string, message: string) => void,
): BuiltResponses {
  const raw = isRecord(operation.responses) ? operation.responses : {};
  const codes = Array.isArray(operation["x-bun-errors"])
    ? operation["x-bun-errors"].filter(
        (code): code is string => typeof code === "string",
      )
    : [];
  if (
    operation["x-bun-errors"] !== undefined &&
    !Array.isArray(operation["x-bun-errors"])
  )
    warn(key, "`x-bun-errors` is not a list; ignored");

  const statuses: number[] = [];
  const members: TsMember[] = [];
  const chunks: [number, "ndjson" | "raw"][] = [];
  let stream = false;
  let events: TsType | undefined;
  let narrowed = false;
  let unnumbered: unknown;

  const numeric = Object.keys(raw)
    .filter((status) => /^[1-5]\d\d$/.test(status))
    .map(Number)
    .sort((a, b) => a - b);
  for (const status of Object.keys(raw)) {
    if (/^[1-5]\d\d$/.test(status)) continue;
    if (status === "default" && numeric.length === 0) {
      unnumbered = raw[status];
      continue;
    }
    warn(
      `${key} response ${status}`,
      status === "default"
        ? "a `default` response is not typed; a status the route does not declare is handled by `undeclaredStatus`"
        : "a status range is not typed; a status the route does not declare is handled by `undeclaredStatus`",
    );
  }

  for (const status of numeric) {
    const at = `${key} response ${status}`;
    const read = responseType(raw[String(status)], context, at, warn);
    if (read.framing !== undefined) chunks.push([status, read.framing]);
    let type = read.type;
    if (read.events !== undefined) events = read.events;
    if (read.stream && status >= 200 && status < 300) stream = true;
    if (codes.length > 0 && (status < 200 || status >= 300)) {
      const result = withCodes(type, read.schema, codes, context);
      if (result !== undefined) {
        type = result;
        narrowed = true;
      }
    }
    statuses.push(status);
    members.push({ name: status, optional: false, type });
  }

  if (codes.length > 0 && !narrowed)
    warn(
      key,
      "`x-bun-errors` lists codes, but no declared error response has a `code` property to narrow",
    );

  if (statuses.length === 0) {
    let read: ReadResponse =
      unnumbered === undefined
        ? { type: UNKNOWN, stream: false }
        : responseType(unnumbered, context, `${key} response default`, warn);
    // A `default` with no content (bun-common's placeholder for a route
    // that declares nothing) says nothing of the body.
    if (read.type.kind === "keyword" && read.type.name === "undefined")
      read = { type: UNKNOWN, stream: false };
    if (read.type === UNKNOWN)
      warn(key, "no response is declared; typed `{ 200: unknown }`");
    return {
      type: {
        kind: "object",
        members: [{ name: 200, optional: false, type: read.type }],
      },
      stream: read.stream,
      ...(read.events === undefined ? {} : { events: read.events }),
    };
  }
  return {
    type: { kind: "object", members },
    statuses,
    stream,
    ...(events === undefined ? {} : { events }),
    ...(chunks.length === 0 ? {} : { chunks }),
  };
}

/**
 * The headers each numeric status declares (§5.6), as the entry's
 * `responseHeaders`: by lower-case name, optional unless `required`, a
 * value typed by its schema when the schema describes strings and `string`
 * otherwise (a header arrives as a string; `./headers`). `undefined` when
 * no status declares one.
 */
function buildResponseHeaders(
  operation: Record<string, unknown>,
  context: SchemaContext,
  key: string,
): TsType | undefined {
  const raw = isRecord(operation.responses) ? operation.responses : {};
  const statuses: TsMember[] = [];
  for (const status of Object.keys(raw)
    .filter((code) => /^[1-5]\d\d$/.test(code))
    .map(Number)
    .sort((a, b) => a - b)) {
    const headers = declaredHeaders(context.document, raw[String(status)]);
    if (headers.length === 0) continue;
    statuses.push({
      name: status,
      optional: false,
      type: {
        kind: "object",
        members: headers.map((header) => ({
          name: header.name,
          optional: !header.required,
          type: isStringSchema(context.document, header.schema)
            ? schemaToType(
                header.schema,
                context,
                `${key} response ${status} headers.${header.name}`,
              )
            : keyword("string"),
          ...(header.description === undefined
            ? {}
            : { doc: header.description }),
        })),
      },
    });
  }
  return statuses.length === 0
    ? undefined
    : { kind: "object", members: statuses };
}

/** What one response's body reads as. */
interface ReadResponse {
  /** The body's type as the client returns it. */
  readonly type: TsType;
  /** The JSON body's schema, for `x-bun-errors`. */
  readonly schema?: unknown;
  /** Whether it is an event stream. */
  readonly stream: boolean;
  /** Its events, from `x-sse-events`. */
  readonly events?: TsType;
  /** How its body streams, when it does (`x-bun-chunks`, an NDJSON media type). */
  readonly framing?: "ndjson" | "raw";
}

/** One response object (or its `$ref`) as the body type the client returns for it. */
function responseType(
  raw: unknown,
  context: SchemaContext,
  at: string,
  warn: (at: string, message: string) => void,
): ReadResponse {
  let response: unknown = raw;
  if (isRecord(response) && typeof response.$ref === "string")
    response = resolvePointer(context.document, response.$ref);
  if (!isRecord(response)) {
    warn(at, "not a response object (or does not resolve); typed `unknown`");
    return { type: UNKNOWN, stream: false };
  }
  if (!isRecord(response.content) || Object.keys(response.content).length === 0)
    return { type: keyword("undefined"), stream: false };

  const types: TsType[] = [];
  let schema: unknown;
  let stream = false;
  let events: TsType | undefined;
  let framing: "ndjson" | "raw" | undefined;
  for (const [mediaType, media] of Object.entries(response.content)) {
    const kind = mediaKind(mediaType);
    const mediaSchema = isRecord(media) ? media.schema : undefined;
    const cut = framingOf(mediaType, mediaSchema);
    if (cut !== undefined) {
      // A streamed body (`other-transports.md` §4): the client iterates it,
      // one value per NDJSON line or the raw bytes.
      framing = cut;
      types.push({
        kind: "ref",
        name: "AsyncIterable",
        args: [
          cut === "raw"
            ? { kind: "ref", name: "Uint8Array" }
            : mediaSchema === undefined
              ? UNKNOWN
              : schemaToType(mediaSchema, context, at),
        ],
      });
      continue;
    }
    const declared =
      isRecord(mediaSchema) && isRecord(mediaSchema["x-sse-events"])
        ? mediaSchema["x-sse-events"]
        : undefined;
    if (declared !== undefined || kind === "events") {
      // The client reads no body for an event stream (`sse()` reads it,
      // PR-S1): the status's body is `undefined`, and the events are the
      // entry's.
      stream = true;
      types.push(keyword("undefined"));
      if (declared !== undefined)
        events = {
          kind: "object",
          members: Object.keys(declared)
            .sort()
            .map((name) => ({
              name,
              optional: false,
              type:
                // A `null` event carries no data (bun-common's `sse()`).
                declared[name] === null
                  ? keyword("undefined")
                  : schemaToType(
                      declared[name],
                      context,
                      `${at} event "${name}"`,
                    ),
            })),
        };
    } else if (kind === "json") {
      schema = mediaSchema;
      types.push(
        mediaSchema === undefined
          ? UNKNOWN
          : schemaToType(mediaSchema, context, at),
      );
    } else if (kind === "text") {
      types.push(keyword("string"));
    } else {
      types.push({ kind: "ref", name: "Blob" });
    }
  }
  return {
    type: union(types),
    stream,
    ...(schema === undefined ? {} : { schema }),
    ...(events === undefined ? {} : { events }),
    ...(framing === undefined ? {} : { framing }),
  };
}

/** Follows `$ref`s and `allOf` to say whether a schema's objects declare a `code` property, and whether it is required. */
function codeProperty(
  schema: unknown,
  context: SchemaContext,
  depth = 0,
): "required" | "optional" | undefined {
  if (depth > 32 || !isRecord(schema)) return undefined;
  if (typeof schema.$ref === "string") {
    const component = componentOf(schema.$ref);
    const target = resolvePointer(context.document, schema.$ref);
    const found = codeProperty(target, context, depth + 1);
    if (found !== undefined || component !== undefined) return found;
  }
  const own =
    isRecord(schema.properties) && Object.hasOwn(schema.properties, "code")
      ? Array.isArray(schema.required) && schema.required.includes("code")
        ? "required"
        : "optional"
      : undefined;
  if (own !== undefined) return own;
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const found = codeProperty(member, context, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The error body with its `code` narrowed to the route's codes (plan §4.3):
 * an inline object gets the union as its `code`'s type; a named one becomes
 * `Omit<Name, "code"> & { code: … }`; a `oneOf`/`anyOf` is narrowed member
 * by member. `undefined` when nothing has a `code` property.
 */
function withCodes(
  type: TsType,
  schema: unknown,
  codes: readonly string[],
  context: SchemaContext,
): TsType | undefined {
  const codeType = union(codes.map((value) => ({ kind: "literal", value })));
  if (type.kind === "union" && isRecord(schema)) {
    const alternatives = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : undefined;
    if (
      alternatives !== undefined &&
      alternatives.length === type.members.length
    ) {
      let any = false;
      const members = type.members.map((member, index) => {
        const narrowed = withCodes(member, alternatives[index], codes, context);
        if (narrowed === undefined) return member;
        any = true;
        return narrowed;
      });
      return any ? union(members) : undefined;
    }
  }
  const presence = codeProperty(schema, context);
  if (presence === undefined) return undefined;
  if (
    type.kind === "object" &&
    type.members.some((member) => member.name === "code")
  ) {
    return {
      ...type,
      members: type.members.map((member) =>
        member.name === "code" ? { ...member, type: codeType } : member,
      ),
    };
  }
  return intersection([
    {
      kind: "ref",
      name: "Omit",
      args: [type, { kind: "literal", value: "code" }],
    },
    {
      kind: "object",
      members: [
        { name: "code", optional: presence === "optional", type: codeType },
      ],
    },
  ]);
}

/** An object type of `entries`, or `Record<never, never>` for none. */
function objectOf(members: readonly TsMember[]): TsType {
  return members.length === 0 ? NO_KEYS : { kind: "object", members };
}

/**
 * The route module's `Channels` map and `channels` descriptors
 * (`websocket.md` §3.1): each channel's entry in the server's names
 * (`params`, `query` when declared, `receives`, `sends`, `replies`), each
 * message's data its JSON Schema's type (`undefined` for none), and each
 * descriptor's runtime facts (`path`, `idField` when not `"id"`, `replies`,
 * `subprotocol`, `codec` for a bun-nest gateway). Nothing when there is no
 * channel.
 */
function channelsDoc(
  channels: readonly ParsedChannel[],
  asyncapi: object,
  warn: (at: string, message: string) => void,
): Doc[] {
  if (channels.length === 0) return [];
  // The messages' `$ref`s are inlined already (`./asyncapi`), so the
  // channels name no component.
  const context: SchemaContext = {
    document: asyncapi,
    componentType: () => undefined,
    warn,
  };
  const messages = (list: ParsedChannel["sends"], at: string): TsType =>
    objectOf(
      list.map(([type, data]) => ({
        name: type,
        optional: false,
        type:
          data === null
            ? keyword("undefined")
            : schemaToType(data, context, `${at} message "${type}"`),
      })),
    );
  const entries: Doc[] = [];
  const descriptors: Doc[] = [];
  for (const channel of channels) {
    const at = `channel ${channel.key}`;
    const members: TsMember[] = [
      {
        name: "params",
        optional: false,
        type: objectOf(
          channel.params.map(([name, schema]) => ({
            name,
            optional: false,
            type:
              schema === undefined
                ? keyword("string")
                : schemaToType(schema, context, `${at} params.${name}`),
          })),
        ),
      },
      ...(channel.query === undefined
        ? []
        : [
            {
              name: "query",
              optional: false,
              type: schemaToType(channel.query, context, `${at} query`),
            },
          ]),
      {
        name: "receives",
        optional: false,
        type: messages(channel.receives, at),
      },
      { name: "sends", optional: false, type: messages(channel.sends, at) },
      {
        name: "replies",
        optional: false,
        type: objectOf(
          channel.replies.map(([type, reply]) => ({
            name: type,
            optional: false,
            type: { kind: "literal", value: reply },
          })),
        ),
      },
    ];
    entries.push([
      channel.doc === undefined ? [] : [jsDoc(channel.doc), hardline],
      quote(channel.key),
      ": ",
      printType({ kind: "object", members }),
      ";",
    ]);
    const facts: Doc[] = [`path: ${quote(channel.key)}`];
    if (channel.idField !== "id")
      facts.push(`idField: ${quote(channel.idField)}`);
    if (channel.replies.length > 0)
      facts.push([
        "replies: ",
        group([
          "{",
          indent([
            line,
            join(
              [",", line],
              channel.replies.map(
                ([type, reply]) => `${propertyKey(type)}: ${quote(reply)}`,
              ),
            ),
          ]),
          ifBreak(","),
          line,
          "}",
        ]),
      ]);
    if (channel.subprotocol !== undefined)
      facts.push(`subprotocol: ${quote(channel.subprotocol)}`);
    if (channel.codec !== undefined)
      facts.push(`codec: ${quote(channel.codec)}`);
    const object = group([
      "{",
      indent([line, join([",", line], facts)]),
      ifBreak(","),
      line,
      "}",
    ]);
    descriptors.push(
      2 + quote(channel.key).length + ": {".length > PRINT_WIDTH
        ? [quote(channel.key), ":", indent([hardline, object])]
        : [quote(channel.key), ": ", object],
    );
  }
  return [
    [
      jsDoc(
        "The WebSocket channels, from the AsyncAPI document: what `channel()`\n(`@kingsleyweb/bun-client/channel`) is typed by, each side in the server's\nnames (the client sends what the server `receives`).",
      ),
      hardline,
      "export interface Channels {",
      indent([hardline, join(hardline, entries)]),
      hardline,
      "}",
    ],
    [
      jsDoc(
        'Each channel\'s runtime facts, for `channel(api, channels["<path>"], …)`.',
      ),
      hardline,
      "export const channels: ChannelDescriptors<Channels> = {",
      indent([hardline, join([",", hardline], descriptors), ","]),
      hardline,
      "};",
    ],
  ];
}
