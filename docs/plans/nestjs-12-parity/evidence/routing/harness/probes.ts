/**
 * The groups of the differential routing harness: each is one Nest
 * application (a module, its configuration, its options), booted once per
 * adapter, and the requests sent to it. `area` is the results table a probe
 * is reported in.
 */
import type { INestApplication, NestApplicationOptions } from "@nestjs/common";
import { RequestMethod, VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import {
  DupModule,
  HAS_QUERY,
  header,
  LegacyGroupController,
  LegacyStarController,
  moduleOf,
  MwBasicModule,
  MwPrefixModule,
  MwVersionModule,
  OptionalController,
  PrefixModule,
  QueryController,
  RoutesModule,
  SpecModule,
  VersioningModule,
} from "./app";

export type Area =
  | "routes"
  | "syntax"
  | "prefix/exclude"
  | "versioning"
  | "middleware"
  | "not-found"
  | "HEAD/OPTIONS/QUERY"
  | "host"
  | "nest12-options";

export interface Probe {
  area: Area;
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export type Side = "express" | "bun";

export interface Group {
  name: string;
  module: new () => object;
  /** Called after create(), before init/listen. */
  configure?: (app: INestApplication) => void;
  options?: Record<string, unknown>;
  /** Extra BunHttpAdapter constructor options (second argument). */
  bunOptions?: Record<string, unknown>;
  /** Only run on Nest 12 (the options do not exist on 11). */
  only12?: boolean;
  probes: Probe[];
}

const get = (area: Area, name: string, path: string, headers?: Record<string, string>): Probe => ({
  area,
  name,
  path,
  headers,
});
const req = (area: Area, name: string, method: string, path: string, headers?: Record<string, string>): Probe => ({
  area,
  name,
  method,
  path,
  headers,
});

const routesProbes: Probe[] = [
  get("routes", "static after param: /users/me", "/users/me"),
  get("routes", "param: /users/42", "/users/42"),
  get("routes", "param with %20", "/users/a%20b"),
  get("routes", "param with encoded slash %2F", "/users/a%2Fb"),
  get("routes", "param with UTF-8 %C3%A9", "/users/caf%C3%A9"),
  get("routes", "param with malformed %E0%A4%A", "/users/%E0%A4%A"),
  get("routes", "param route + trailing slash", "/users/42/"),
  get("routes", "*path wildcard, 3 segments", "/files/a/b/c"),
  get("routes", "*path wildcard, encoded slash", "/files/a%2Fb"),
  get("routes", "*path wildcard, bare /files", "/files"),
  get("routes", "*path wildcard, /files/", "/files/"),
  get("routes", "{*path} wildcard, bare /files2", "/files2"),
  get("routes", "{*path} wildcard, /files2/x/y", "/files2/x/y"),
  get("routes", "trailing slash: /t", "/t"),
  get("routes", "trailing slash: /t/", "/t/"),
  get("routes", "case: /Case", "/Case"),
  get("routes", "case: /case", "/case"),
  get("routes", "case: /CASE", "/CASE"),
  get("routes", "dup slashes in declaration: /dbl/inner", "/dbl/inner"),
  get("routes", "dup slashes in declaration: /dbl/a/b", "/dbl/a/b"),
  get("routes", "dup slashes in request: /dbl//inner", "/dbl//inner"),
  get("routes", "dup slashes in request: //dbl//inner", "//dbl//inner"),
  get("routes", "dup slashes in request: /dbl/a//b", "/dbl/a//b"),
  req("routes", "@All GET", "GET", "/any"),
  req("routes", "@All POST", "POST", "/any"),
  req("routes", "@All PUT", "PUT", "/any"),
  req("routes", "@All DELETE", "DELETE", "/any"),
  req("routes", "@All PATCH", "PATCH", "/any"),
  req("routes", "@All SEARCH", "SEARCH", "/any"),
  get("routes", "@Redirect 301", "/redir"),
  req("routes", "@HttpCode(202) POST", "POST", "/code"),
  get("routes", "@Header x-custom", "/hdr"),
  req("HEAD/OPTIONS/QUERY", "@Head beside @Get: HEAD /hd", "HEAD", "/hd"),
  req("HEAD/OPTIONS/QUERY", "@Head beside @Get: GET /hd", "GET", "/hd"),
  req("HEAD/OPTIONS/QUERY", "HEAD falls back to @Get", "HEAD", "/gonly"),
  req("HEAD/OPTIONS/QUERY", "HEAD on @All", "HEAD", "/any"),
  req("HEAD/OPTIONS/QUERY", "@Options: OPTIONS /opts", "OPTIONS", "/opts"),
  req("HEAD/OPTIONS/QUERY", "OPTIONS on a GET-only route", "OPTIONS", "/gonly"),
  req("HEAD/OPTIONS/QUERY", "OPTIONS on @All", "OPTIONS", "/any"),
  req("HEAD/OPTIONS/QUERY", "@Search: SEARCH /srch", "SEARCH", "/srch"),
  req("HEAD/OPTIONS/QUERY", "GET on a SEARCH-only route", "GET", "/srch"),
  req("HEAD/OPTIONS/QUERY", "QUERY on @All", "QUERY", "/any"),
  req("HEAD/OPTIONS/QUERY", "QUERY on a GET-only route", "QUERY", "/gonly"),
  get("host", "host match a.example.com", "/host", { host: "a.example.com" }),
  get("host", "host match with port", "/host", { host: "a.example.com:8080" }),
  get("host", "host two-level sub a.b.example.com", "/host", { host: "a.b.example.com" }),
  get("host", "host no match example.com", "/host", { host: "example.com" }),
  get("host", "host case A.Example.com", "/host", { host: "A.Example.com" }),
  get("not-found", "unknown path", "/nope"),
  req("not-found", "method miss: POST on GET /t", "POST", "/t"),
  req("not-found", "method miss: PUT /users/42", "PUT", "/users/42"),
  req("not-found", "method miss: DELETE /hdr", "DELETE", "/hdr"),
];

const prefixExclude = {
  exclude: ["health", { path: "hello", method: RequestMethod.GET }, "files/*path"],
};

export const GROUPS: Group[] = [
  { name: "routes", module: RoutesModule, probes: routesProbes },
  {
    name: "query-method",
    module: moduleOf(QueryController),
    probes: [
      req("HEAD/OPTIONS/QUERY", `@QueryMethod: QUERY /q${HAS_QUERY ? "" : " (no @QueryMethod on this Nest)"}`, "QUERY", "/q"),
      req("HEAD/OPTIONS/QUERY", "GET on the QUERY-only route /q", "GET", "/q"),
      req("HEAD/OPTIONS/QUERY", "control: GET /gq beside it", "GET", "/gq"),
    ],
  },
  {
    name: "syntax-optional",
    module: moduleOf(OptionalController),
    probes: [
      get("syntax", "optional segment: /opt", "/opt"),
      get("syntax", "optional segment: /opt/1", "/opt/1"),
      get("syntax", "optional segment: /opt/1/2", "/opt/1/2"),
      get("syntax", "optional segment: /opt/", "/opt/"),
    ],
  },
  {
    name: "syntax-legacy-star",
    module: moduleOf(LegacyStarController),
    probes: [
      get("syntax", "legacy /legacy/*: /legacy/a/b", "/legacy/a/b"),
      get("syntax", "legacy /legacy/*: /legacy", "/legacy"),
      get("syntax", "legacy /legacy/*: /legacy/", "/legacy/"),
      get("syntax", "legacy /legacy/*: literal /legacy/*", "/legacy/*"),
    ],
  },
  {
    name: "syntax-legacy-group",
    module: moduleOf(LegacyGroupController),
    probes: [
      get("syntax", "legacy /old/(.*): /old/x/y", "/old/x/y"),
      get("syntax", "legacy /old/(.*): /old", "/old"),
      get("syntax", "legacy /old/(.*): literal /old/(.*)", "/old/(.*)"),
    ],
  },
  {
    name: "prefix",
    module: PrefixModule,
    configure: (app) => app.setGlobalPrefix("api", prefixExclude as never),
    probes: [
      get("prefix/exclude", "prefixed GET /api/hello", "/api/hello"),
      req("prefix/exclude", "prefixed POST /api/hello", "POST", "/api/hello"),
      get("prefix/exclude", "excluded {hello,GET}: GET /hello", "/hello"),
      req("prefix/exclude", "excluded {hello,GET}: HEAD /hello", "HEAD", "/hello"),
      get("prefix/exclude", "excluded 'health': /health", "/health"),
      get("prefix/exclude", "excluded 'health' under prefix: /api/health", "/api/health"),
      get("prefix/exclude", "excluded 'files/*path': /files/a/b", "/files/a/b"),
      get("prefix/exclude", "excluded 'files/*path' under prefix", "/api/files/a/b"),
      get("prefix/exclude", "bare prefix /api", "/api"),
      get("prefix/exclude", "bare prefix /api/", "/api/"),
      req("not-found", "method miss on excluded route: POST /health (#17923)", "POST", "/health"),
      req("not-found", "method miss on excluded {hello,GET}: PUT /hello (#17923)", "PUT", "/hello"),
      req("not-found", "method miss on prefixed: PUT /api/hello", "PUT", "/api/hello"),
      get("not-found", "unknown under prefix /api/nope", "/api/nope"),
      get("not-found", "unknown outside prefix /nope", "/nope"),
      get("not-found", "unknown, prefix as substring /apiary", "/apiary"),
    ],
  },
  {
    name: "prefix-array",
    module: PrefixModule,
    configure: (app) => app.setGlobalPrefix(["api", "v1"] as never),
    probes: [
      get("prefix/exclude", "array prefix: /api/hello", "/api/hello"),
      get("prefix/exclude", "array prefix: /v1/hello", "/v1/hello"),
      get("prefix/exclude", "array prefix: /api,v1/hello", "/api,v1/hello"),
      get("prefix/exclude", "array prefix: /hello", "/hello"),
    ],
  },
  {
    name: "ver-uri",
    module: VersioningModule,
    configure: (app) => app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" }),
    probes: [
      get("versioning", "URI /v1/ver", "/v1/ver"),
      get("versioning", "URI /v2/ver", "/v2/ver"),
      get("versioning", "URI /v3/ver", "/v3/ver"),
      get("versioning", "URI /ver (neutral)", "/ver"),
      get("versioning", "URI /v9/ver", "/v9/ver"),
      get("versioning", "URI controller v2 /v2/cv", "/v2/cv"),
      get("versioning", "URI controller v2 /cv", "/cv"),
      get("versioning", "URI defaultVersion /v1/plain", "/v1/plain"),
      get("versioning", "URI defaultVersion /plain", "/plain"),
    ],
  },
  {
    name: "ver-header",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({ type: VersioningType.HEADER, header: "X-API-Version", defaultVersion: "1" }),
    probes: [
      get("versioning", "HEADER 1", "/ver", { "x-api-version": "1" }),
      get("versioning", "HEADER 2", "/ver", { "x-api-version": "2" }),
      get("versioning", "HEADER 3", "/ver", { "x-api-version": "3" }),
      get("versioning", "HEADER none", "/ver"),
      get("versioning", "HEADER 9", "/ver", { "x-api-version": "9" }),
      get("versioning", "HEADER cv 2", "/cv", { "x-api-version": "2" }),
      get("versioning", "HEADER plain none (defaultVersion 1)", "/plain"),
      get("versioning", "HEADER plain 1", "/plain", { "x-api-version": "1" }),
    ],
  },
  {
    name: "ver-header-neutral-default",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({
        type: VersioningType.HEADER,
        header: "X-API-Version",
        defaultVersion: [VERSION_NEUTRAL, "1"],
      }),
    probes: [
      get("versioning", "HEADER default [NEUTRAL,1]: plain none", "/plain"),
      get("versioning", "HEADER default [NEUTRAL,1]: plain 1", "/plain", { "x-api-version": "1" }),
      get("versioning", "HEADER default [NEUTRAL,1]: plain 5", "/plain", { "x-api-version": "5" }),
    ],
  },
  {
    name: "ver-media",
    module: VersioningModule,
    configure: (app) => app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: "v=" }),
    probes: [
      get("versioning", "MEDIA v=1", "/ver", { accept: "application/json;v=1" }),
      get("versioning", "MEDIA v=3", "/ver", { accept: "application/json;v=3" }),
      get("versioning", "MEDIA none", "/ver", { accept: "application/json" }),
      get("versioning", "MEDIA v=9", "/ver", { accept: "application/json;v=9" }),
      get("versioning", "MEDIA with space ; v=1", "/ver", { accept: "application/json; v=1" }),
      get("versioning", "MEDIA cv v=2", "/cv", { accept: "application/json;v=2" }),
    ],
  },
  {
    name: "ver-custom",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor: (r: unknown) => {
          const raw = header(r as Record<string, unknown>, "x-ver");
          return raw ? raw.split(",").map((v) => v.trim()).sort().reverse() : "";
        },
      }),
    probes: [
      get("versioning", "CUSTOM 1", "/ver", { "x-ver": "1" }),
      get("versioning", "CUSTOM 2", "/ver", { "x-ver": "2" }),
      get("versioning", "CUSTOM 3,1 (array)", "/ver", { "x-ver": "3,1" }),
      get("versioning", "CUSTOM none", "/ver"),
      get("versioning", "CUSTOM 9", "/ver", { "x-ver": "9" }),
    ],
  },
  {
    name: "mw-basic",
    module: MwBasicModule,
    probes: [
      get("middleware", "'users' string: /users (no handler)", "/users"),
      get("middleware", "'users' string: /users/42", "/users/42"),
      get("middleware", "controller w/ exclude users/me: /users/me", "/users/me"),
      get("middleware", "'files/*path': /files/a", "/files/a"),
      get("middleware", "'files/*path': /files (no handler)", "/files"),
      req("middleware", "{t, POST}: POST /t", "POST", "/t"),
      get("middleware", "{t, POST}: GET /t", "/t"),
      get("middleware", "{hd, GET}: GET /hd", "/hd"),
      req("middleware", "{hd, GET}: HEAD /hd", "HEAD", "/hd"),
      get("middleware", "exclude {gonly, GET}: GET /gonly", "/gonly"),
      req("middleware", "exclude {gonly, GET} covers HEAD (#17950)", "HEAD", "/gonly"),
      get("middleware", "controller '/slash/' + '/x' (#18075)", "/slash/x"),
      get("middleware", "transient then next (#17846)", "/trans"),
      get("middleware", "'*' on unknown path", "/nope"),
      req("middleware", "method miss POST /users/42", "POST", "/users/42"),
    ],
  },
  {
    name: "mw-prefix",
    module: MwPrefixModule,
    configure: (app) => app.setGlobalPrefix("api", { exclude: ["health"] }),
    probes: [
      get("middleware", "'*' + prefix: bare /api (#17942)", "/api"),
      get("middleware", "'*' + prefix: /api/", "/api/"),
      get("middleware", "'*' + prefix: /api/hello", "/api/hello"),
      get("middleware", "'*' + prefix: excluded /health", "/health"),
      get("middleware", "'*' + prefix: /nope (outside)", "/nope"),
      get("middleware", "'*' + prefix: /api/nope", "/api/nope"),
      req("middleware", "'*' + prefix: POST /api/hello", "POST", "/api/hello"),
    ],
  },
  {
    name: "mw-version",
    module: MwVersionModule,
    configure: (app) => app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" }),
    probes: [
      get("middleware", "VERSION_NEUTRAL route info: /ver (#17947)", "/ver"),
      get("middleware", "{ver, GET, v1}: /v1/ver", "/v1/ver"),
      req("middleware", "{ver, GET, v1}: HEAD /v1/ver", "HEAD", "/v1/ver"),
      get("middleware", "versioned controller: /v2/ver", "/v2/ver"),
      get("middleware", "versioned: /v1/plain (no mw)", "/v1/plain"),
    ],
  },
  ...specGroups(),
];

function specProbes(): Probe[] {
  return [
    get("nest12-options", "static after param: /s/me", "/s/me"),
    get("nest12-options", "param: /s/1", "/s/1"),
    get("nest12-options", "literal after param: /s/a/b", "/s/a/b"),
    get("nest12-options", "param after wildcard: /s/a/z", "/s/a/z"),
    get("nest12-options", "wildcard: /s/x/y/z", "/s/x/y/z"),
    get("nest12-options", "@All declared before @Get: GET /ag", "/ag"),
    req("nest12-options", "@All declared before @Get: POST /ag", "POST", "/ag"),
  ];
}

function specGroups(): Group[] {
  const strict = {
    routeResolutionStrategy: "specificity",
    routeConflictPolicy: { duplicate: "error", shadow: "warn" },
  };
  return [
    { name: "n12-declaration", module: SpecModule, only12: true, probes: specProbes() },
    { name: "n12-specificity", module: SpecModule, only12: true, options: strict, probes: specProbes() },
    {
      name: "n12-specificity+bun-routeSpecificity",
      module: SpecModule,
      only12: true,
      options: strict,
      bunOptions: { router: { routeSpecificity: true } },
      probes: specProbes(),
    },
    {
      name: "n12-declaration+bun-routeSpecificity",
      module: SpecModule,
      only12: true,
      bunOptions: { router: { routeSpecificity: true } },
      probes: specProbes(),
    },
    {
      name: "n12-conflict-warn",
      module: DupModule,
      only12: true,
      options: { routeConflictPolicy: { duplicate: "warn", shadow: "warn" } },
      probes: [get("nest12-options", "duplicate GET /dupx: winner", "/dupx"), ...specProbes().slice(0, 1)],
    },
    {
      name: "n12-conflict-error",
      module: DupModule,
      only12: true,
      options: strict,
      probes: [get("nest12-options", "duplicate GET /dupx with duplicate:'error'", "/dupx")],
    },
  ];
}

export type { NestApplicationOptions };
