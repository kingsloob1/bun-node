/**
 * The groups of the routing differential: each is one Nest application (a
 * module, its configuration, its options), booted once per adapter, and the
 * requests sent to it. Ported from the plan's harness
 * (`docs/plans/nestjs-12-parity/evidence/routing/harness/probes.ts`), plus
 * the cases plan §5.6 asks to add: `:x?` and `:x(\d+)`, a trailing-slash
 * prefix, URI-versioned exclusions (#18072) and `RouterModule` paths
 * (#17710). Several applications on one adapter are
 * `notFoundMultiApp.nest.test.ts`'s.
 */
import type { Group, Probe } from "./harness";
import { RequestMethod, VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import {
  ConstrainedParamController,
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
  OptionalParamController,
  PrefixModule,
  QueryController,
  QueryMiddlewareModule,
  RouterModuleApp,
  RoutesModule,
  SpecModule,
  VersionedPrefixModule,
  VersioningModule,
} from "./app";
import { EXPRESS_HONOURS_EXACT_MARKER, NEST_12 } from "./harness";

/** A request with a method other than GET. */
function req(
  name: string,
  method: string,
  path: string,
  headers?: Record<string, string>,
): Probe {
  return { name, method, path, headers };
}

/** A GET request. */
function get(name: string, path: string, headers?: Record<string, string>) {
  return req(name, "GET", path, headers);
}

const routesProbes: Probe[] = [
  get("static after param: /users/me", "/users/me"),
  get("param: /users/42", "/users/42"),
  get("param with %20", "/users/a%20b"),
  get("param with encoded slash %2F", "/users/a%2Fb"),
  get("param with UTF-8 %C3%A9", "/users/caf%C3%A9"),
  get("param with malformed %E0%A4%A", "/users/%E0%A4%A"),
  get("param route + trailing slash", "/users/42/"),
  get("*path wildcard, 3 segments", "/files/a/b/c"),
  get("*path wildcard, encoded slash", "/files/a%2Fb"),
  get("*path wildcard, bare /files", "/files"),
  get("*path wildcard, /files/", "/files/"),
  get("{*path} wildcard, bare /files2", "/files2"),
  get("{*path} wildcard, /files2/x/y", "/files2/x/y"),
  get("trailing slash: /t", "/t"),
  get("trailing slash: /t/", "/t/"),
  get("case: /Case", "/Case"),
  get("case: /case", "/case"),
  get("case: /CASE", "/CASE"),
  get("dup slashes in declaration: /dbl/inner", "/dbl/inner"),
  get("dup slashes in declaration: /dbl/a/b", "/dbl/a/b"),
  get("dup slashes in request: /dbl//inner", "/dbl//inner"),
  get("dup slashes in request: //dbl//inner", "//dbl//inner"),
  get("dup slashes in request: //t", "//t"),
  get("dup slashes in request: /dbl/a//b", "/dbl/a//b"),
  req("@All GET", "GET", "/any"),
  req("@All POST", "POST", "/any"),
  req("@All PUT", "PUT", "/any"),
  req("@All DELETE", "DELETE", "/any"),
  req("@All PATCH", "PATCH", "/any"),
  req("@All SEARCH", "SEARCH", "/any"),
  get("@Redirect 301", "/redir"),
  req("@HttpCode(202) POST", "POST", "/code"),
  get("@Header x-custom", "/hdr"),
  req("@Head beside @Get: HEAD /hd", "HEAD", "/hd"),
  req("@Head beside @Get: GET /hd", "GET", "/hd"),
  req("HEAD falls back to @Get", "HEAD", "/gonly"),
  req("HEAD on @All", "HEAD", "/any"),
  req("@Options: OPTIONS /opts", "OPTIONS", "/opts"),
  req("OPTIONS on a GET-only route", "OPTIONS", "/gonly"),
  req("OPTIONS on @All", "OPTIONS", "/any"),
  req("@Search: SEARCH /srch", "SEARCH", "/srch"),
  req("GET on a SEARCH-only route", "GET", "/srch"),
  req("QUERY on @All", "QUERY", "/any"),
  req("QUERY on a GET-only route", "QUERY", "/gonly"),
  get("host match a.example.com", "/host", { host: "a.example.com" }),
  get("host match with port", "/host", { host: "a.example.com:8080" }),
  get("host two-level sub a.b.example.com", "/host", {
    host: "a.b.example.com",
  }),
  get("host no match example.com", "/host", { host: "example.com" }),
  get("host case A.Example.com", "/host", { host: "A.Example.com" }),
  get("unknown path", "/nope"),
  req("method miss: POST on GET /t", "POST", "/t"),
  req("method miss: PUT /users/42", "PUT", "/users/42"),
  req("method miss: DELETE /hdr", "DELETE", "/hdr"),
];

const prefixExclude = {
  exclude: [
    "health",
    { path: "hello", method: RequestMethod.GET },
    "files/*path",
  ],
};

/** Every routing group; a group whose `when` is false skips itself. */
export const GROUPS: Group[] = [
  { name: "routes", module: RoutesModule, probes: routesProbes },
  {
    name: "query-method",
    module: moduleOf(QueryController),
    when: HAS_QUERY,
    probes: [
      req("@QueryMethod: QUERY /q", "QUERY", "/q"),
      get("GET on the QUERY-only route /q", "/q"),
      get("control: GET /gq beside it", "/gq"),
    ],
  },
  {
    name: "query-middleware",
    module: QueryMiddlewareModule,
    when: HAS_QUERY,
    probes: [
      req("{q, QUERY} middleware: QUERY /q", "QUERY", "/q"),
      get("{q, QUERY} middleware skips GET /q", "/q"),
      req("{gq, ALL} middleware: QUERY /gq", "QUERY", "/gq"),
      get("{gq, ALL} middleware: GET /gq", "/gq"),
    ],
  },
  {
    name: "syntax-optional",
    module: moduleOf(OptionalController),
    probes: [
      get("optional segment: /opt", "/opt"),
      get("optional segment: /opt/1", "/opt/1"),
      get("optional segment: /opt/1/2", "/opt/1/2"),
      get("optional segment: /opt/", "/opt/"),
    ],
  },
  {
    name: "syntax-legacy-star",
    module: moduleOf(LegacyStarController),
    probes: [
      get("legacy /legacy/*: /legacy/a/b", "/legacy/a/b"),
      get("legacy /legacy/*: /legacy", "/legacy"),
      get("legacy /legacy/*: /legacy/", "/legacy/"),
      get("legacy /legacy/*: literal /legacy/*", "/legacy/*"),
    ],
  },
  {
    name: "syntax-legacy-group",
    module: moduleOf(LegacyGroupController),
    probes: [
      get("legacy /old/(.*): /old/x/y", "/old/x/y"),
      get("legacy /old/(.*): /old", "/old"),
      get("legacy /old/(.*): literal /old/(.*)", "/old/(.*)"),
    ],
  },
  {
    name: "syntax-optional-param",
    module: moduleOf(OptionalParamController),
    probes: [get(":x?: /optp", "/optp"), get(":x?: /optp/1", "/optp/1")],
  },
  {
    name: "syntax-constrained-param",
    module: moduleOf(ConstrainedParamController),
    probes: [
      get(":id(\\d+): /num/12", "/num/12"),
      get(":id(\\d+): /num/ab", "/num/ab"),
    ],
  },
  {
    name: "prefix",
    module: PrefixModule,
    configure: (app) => app.setGlobalPrefix("api", prefixExclude as never),
    probes: [
      get("prefixed GET /api/hello", "/api/hello"),
      req("prefixed POST /api/hello", "POST", "/api/hello"),
      get("excluded {hello,GET}: GET /hello", "/hello"),
      req("excluded {hello,GET}: HEAD /hello", "HEAD", "/hello"),
      get("excluded 'health': /health", "/health"),
      get("excluded 'health' under prefix: /api/health", "/api/health"),
      get("excluded 'files/*path': /files/a/b", "/files/a/b"),
      get("excluded 'files/*path' under prefix", "/api/files/a/b"),
      get("bare prefix /api", "/api"),
      get("bare prefix /api/", "/api/"),
      req(
        "method miss on excluded route: POST /health (#17923)",
        "POST",
        "/health",
      ),
      req(
        "method miss on excluded {hello,GET}: PUT /hello (#17923)",
        "PUT",
        "/hello",
      ),
      req("method miss on prefixed: PUT /api/hello", "PUT", "/api/hello"),
      get("unknown under prefix /api/nope", "/api/nope"),
      get("unknown outside prefix /nope", "/nope"),
      get("unknown, prefix as substring /apiary", "/apiary"),
      get("unknown, prefix in another case /API/nope", "/API/nope"),
    ],
  },
  {
    name: "prefix-trailing-slash",
    module: PrefixModule,
    configure: (app) => app.setGlobalPrefix("api/"),
    probes: [
      get("'api/' prefix: /api/hello", "/api/hello"),
      get("'api/' prefix: /api//hello", "/api//hello"),
      get("'api/' prefix: /hello", "/hello"),
      get("'api/' prefix: bare /api", "/api"),
      get("'api/' prefix: /api/nope", "/api/nope"),
      get("'api/' prefix: /nope", "/nope"),
    ],
  },
  {
    name: "prefix-array",
    module: PrefixModule,
    configure: (app) => app.setGlobalPrefix(["api", "v1"] as never),
    probes: [
      get("array prefix: /api/hello", "/api/hello"),
      get("array prefix: /v1/hello", "/v1/hello"),
      get("array prefix: /api,v1/hello", "/api,v1/hello"),
      get("array prefix: /hello", "/hello"),
    ],
  },
  {
    name: "prefix-versioned-exclude",
    module: VersionedPrefixModule,
    configure: (app) => {
      app.enableVersioning({ type: VersioningType.URI });
      app.setGlobalPrefix("api", {
        exclude: [{ path: "hello", method: RequestMethod.GET, version: "1" }],
      } as never);
    },
    probes: [
      get("excluded {hello,GET,v1}: /v1/hello", "/v1/hello"),
      get(
        "excluded {hello,GET,v1} under prefix: /api/v1/hello",
        "/api/v1/hello",
      ),
      req("not excluded POST: /api/v1/hello", "POST", "/api/v1/hello"),
      req(
        "method miss on the excluded path: POST /v1/hello (#18072)",
        "POST",
        "/v1/hello",
      ),
      req(
        "method miss on the excluded path: PUT /v1/hello (#18072)",
        "PUT",
        "/v1/hello",
      ),
      get("v2 stays prefixed: /api/v2/hello", "/api/v2/hello"),
      get("v2 not excluded: /v2/hello", "/v2/hello"),
      get("unknown outside prefix /nope", "/nope"),
    ],
  },
  {
    name: "router-module",
    module: RouterModuleApp,
    probes: [
      get("RouterModule 'admin/' + 'items': /admin/items/1", "/admin/items/1"),
      get(
        "RouterModule child '/nested//' + '/leaf/': /admin/nested/leaf",
        "/admin/nested/leaf",
      ),
      get(
        "RouterModule child, trailing slash: /admin/nested/leaf/",
        "/admin/nested/leaf/",
      ),
      get(
        "RouterModule child, dup slashes in request: /admin/nested//leaf",
        "/admin/nested//leaf",
      ),
      get("RouterModule, unrouted: /items/1", "/items/1"),
    ],
  },
  {
    name: "ver-uri",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" }),
    probes: [
      get("URI /v1/ver", "/v1/ver"),
      get("URI /v2/ver", "/v2/ver"),
      get("URI /v3/ver", "/v3/ver"),
      get("URI /ver (neutral)", "/ver"),
      get("URI /v9/ver", "/v9/ver"),
      get("URI controller v2 /v2/cv", "/v2/cv"),
      get("URI controller v2 /cv", "/cv"),
      get("URI defaultVersion /v1/plain", "/v1/plain"),
      get("URI defaultVersion /plain", "/plain"),
    ],
  },
  {
    name: "ver-header",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({
        type: VersioningType.HEADER,
        header: "X-API-Version",
        defaultVersion: "1",
      }),
    probes: [
      get("HEADER 1", "/ver", { "x-api-version": "1" }),
      get("HEADER 2", "/ver", { "x-api-version": "2" }),
      get("HEADER 3", "/ver", { "x-api-version": "3" }),
      get("HEADER none", "/ver"),
      get("HEADER 9", "/ver", { "x-api-version": "9" }),
      get("HEADER cv 2", "/cv", { "x-api-version": "2" }),
      get("HEADER plain none (defaultVersion 1)", "/plain"),
      get("HEADER plain 1", "/plain", { "x-api-version": "1" }),
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
      get("HEADER default [NEUTRAL,1]: plain none", "/plain"),
      get("HEADER default [NEUTRAL,1]: plain 1", "/plain", {
        "x-api-version": "1",
      }),
      get("HEADER default [NEUTRAL,1]: plain 5", "/plain", {
        "x-api-version": "5",
      }),
    ],
  },
  {
    name: "ver-media",
    module: VersioningModule,
    configure: (app) =>
      app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: "v=" }),
    probes: [
      get("MEDIA v=1", "/ver", { accept: "application/json;v=1" }),
      get("MEDIA v=3", "/ver", { accept: "application/json;v=3" }),
      get("MEDIA none", "/ver", { accept: "application/json" }),
      get("MEDIA v=9", "/ver", { accept: "application/json;v=9" }),
      get("MEDIA with space ; v=1", "/ver", {
        accept: "application/json; v=1",
      }),
      get("MEDIA cv v=2", "/cv", { accept: "application/json;v=2" }),
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
          return raw
            ? raw
                .split(",")
                .map((v) => v.trim())
                .sort()
                .reverse()
            : "";
        },
      }),
    probes: [
      get("CUSTOM 1", "/ver", { "x-ver": "1" }),
      get("CUSTOM 2", "/ver", { "x-ver": "2" }),
      get("CUSTOM 3,1 (array)", "/ver", { "x-ver": "3,1" }),
      get("CUSTOM none", "/ver"),
      get("CUSTOM 9", "/ver", { "x-ver": "9" }),
    ],
  },
  {
    name: "mw-basic",
    module: MwBasicModule,
    probes: [
      get("'users' string: /users (no handler)", "/users"),
      get("'users' string: /users/42", "/users/42"),
      get("controller w/ exclude users/me: /users/me", "/users/me"),
      get("'files/*path': /files/a", "/files/a"),
      get("'files/*path': /files (no handler)", "/files"),
      req("{t, POST}: POST /t", "POST", "/t"),
      get("{t, POST}: GET /t", "/t"),
      get("{hd, GET}: GET /hd", "/hd"),
      req("{hd, GET}: HEAD /hd", "HEAD", "/hd"),
      get("exclude {gonly, GET}: GET /gonly", "/gonly"),
      req("exclude {gonly, GET} covers HEAD (#17950)", "HEAD", "/gonly"),
      get("controller '/slash/' + '/x' (#18075)", "/slash/x"),
      get("transient then next (#17846)", "/trans"),
      get("'*' on unknown path", "/nope"),
      req("method miss POST /users/42", "POST", "/users/42"),
    ],
  },
  {
    name: "mw-prefix",
    module: MwPrefixModule,
    configure: (app) => app.setGlobalPrefix("api", { exclude: ["health"] }),
    probes: [
      get("'*' + prefix: bare /api (#17942)", "/api"),
      get("'*' + prefix: /api/", "/api/"),
      get("'*' + prefix: /api/hello", "/api/hello"),
      get("'*' + prefix: excluded /health", "/health"),
      get("'*' + prefix: /nope (outside)", "/nope"),
      get("'*' + prefix: /api/nope", "/api/nope"),
      req("'*' + prefix: POST /api/hello", "POST", "/api/hello"),
    ],
  },
  {
    name: "mw-version",
    module: MwVersionModule,
    configure: (app) =>
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" }),
    probes: [
      get("VERSION_NEUTRAL route info: /ver (#17947)", "/ver"),
      get("{ver, GET, v1}: /v1/ver", "/v1/ver"),
      req("{ver, GET, v1}: HEAD /v1/ver", "HEAD", "/v1/ver"),
      get("versioned controller: /v2/ver", "/v2/ver"),
      get("versioned: /v1/plain (no mw)", "/v1/plain"),
    ],
  },
  ...specGroups(),
];

/** The requests of the Nest 12 route-option groups. */
function specProbes(): Probe[] {
  return [
    get("static after param: /s/me", "/s/me"),
    get("param: /s/1", "/s/1"),
    get("literal after param: /s/a/b", "/s/a/b"),
    get("param after wildcard: /s/a/z", "/s/a/z"),
    get("wildcard: /s/x/y/z", "/s/x/y/z"),
    get("@All declared before @Get: GET /ag", "/ag"),
    req("@All declared before @Get: POST /ag", "POST", "/ag"),
  ];
}

/**
 * Nest 12's `routeResolutionStrategy` and `routeConflictPolicy`, alone and
 * with bun-common's own `routeSpecificity` on top. The options do not exist
 * on 11 (where Nest ignores them), so the groups run on 12 only.
 */
function specGroups(): Group[] {
  const strict = {
    routeResolutionStrategy: "specificity",
    routeConflictPolicy: { duplicate: "error", shadow: "warn" },
  };
  const bunSpecificity = { router: { routeSpecificity: true } };
  return [
    {
      name: "n12-declaration",
      module: SpecModule,
      when: NEST_12,
      probes: specProbes(),
    },
    {
      name: "n12-specificity",
      module: SpecModule,
      when: NEST_12,
      options: strict,
      probes: specProbes(),
    },
    {
      name: "n12-specificity+bun-routeSpecificity",
      module: SpecModule,
      when: NEST_12,
      options: strict,
      bunOptions: bunSpecificity,
      probes: specProbes(),
    },
    {
      name: "n12-declaration+bun-routeSpecificity",
      module: SpecModule,
      when: NEST_12,
      bunOptions: bunSpecificity,
      probes: specProbes(),
    },
    {
      name: "n12-conflict-warn",
      module: DupModule,
      when: NEST_12,
      options: { routeConflictPolicy: { duplicate: "warn", shadow: "warn" } },
      probes: [get("duplicate GET /dupx: winner", "/dupx"), specProbes()[0]!],
    },
    {
      name: "n12-conflict-error",
      module: DupModule,
      when: NEST_12,
      options: strict,
      probes: [get("duplicate GET /dupx with duplicate:'error'", "/dupx")],
    },
  ];
}

/** What a known difference covers: the fields that differ, and why. */
export interface KnownDifference {
  /** The compared fields that differ: `status`, `body`, `content-type`, `allow`, `location`, `x-custom`, `handler`, `trail`; for a boot, `boot-error` and `logs`. */
  fields: string[];
  /** The plan's D-row (§5.3), or `new` with what it is. */
  row: string;
  /** Why it differs, and which PR removes it. */
  reason: string;
}

/** One D-row's row id and reason. */
type Row = Pick<KnownDifference, "row" | "reason">;

const D6_REVERSED: Row = {
  row: "D6 (reversed, by design)",
  reason:
    "the `$` exact-match marker is honoured on every major; platform-express honours it from 12.1.3 only",
};
const D8: Row = {
  row: "D8 (opt-in)",
  reason:
    "bun-common's `routeSpecificity` ranks an exact method over `all` and re-ranks by path itself; Nest's sorter ranks segments only (to document, §5.4)",
};
/** The same known difference for several probes. */
function known(
  row: Row,
  fields: string[],
  keys: string[],
): Record<string, KnownDifference> {
  return Object.fromEntries(keys.map((key) => [key, { ...row, fields }]));
}

/**
 * Differences not fixed yet, keyed `"<group>/<probe>"` (a boot is
 * `"<group>/(boot)"`). Every other field of every probe must be Express's,
 * and every entry here must still differ, so the PR that fixes one fails
 * this test until it takes the entry off.
 */
export const KNOWN: Record<string, KnownDifference> = {
  // D8 (opt-in): bun-common's `routeSpecificity` also ranks an exact method
  // over `all`, and, without Nest's strategy, re-ranks the routes itself.
  ...known(
    D8,
    ["handler", "body"],
    [
      "n12-specificity+bun-routeSpecificity/@All declared before @Get: GET /ag",
      "n12-declaration+bun-routeSpecificity/@All declared before @Get: GET /ag",
      "n12-declaration+bun-routeSpecificity/static after param: /s/me",
      "n12-declaration+bun-routeSpecificity/literal after param: /s/a/b",
    ],
  ),
  // D6, reversed, where platform-express predates #17942 (11.x): the core's
  // `<prefix>$` marker is honoured on every major (PR-2), so `forRoutes('*')`
  // runs on the bare prefix here and not on Express 11. Not a debt: the
  // same entry is in `expressCompat/probes.ts`.
  ...(EXPRESS_HONOURS_EXACT_MARKER
    ? {}
    : known(
        D6_REVERSED,
        ["trail"],
        ["mw-prefix/'*' + prefix: bare /api (#17942)"],
      )),
};
