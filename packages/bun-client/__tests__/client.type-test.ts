/**
 * The call types (plan §4, §6.1, §12's PR-C1 row) against a hand-written
 * map in §3.0's shape. Each `@ts-expect-error` is a negative control: it must
 * error, and it must be there (an unused one fails the check too). The
 * `Expect<Equal<…>>` lines pin what each call returns.
 *
 * Checked by `bun run check`, not by `bun test`; nothing here runs.
 */
import type {
  Client,
  HttpError,
  Jsonify,
  Result,
  RouteManifest,
} from "../lib/index";
import { createClient } from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface User {
  id: string;
  name: string;
  createdAt: Date;
}
interface Problem<C extends string> {
  type: string;
  title: string;
  code: C;
}

interface Routes {
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    query: { expand?: string[]; page?: number };
    body: undefined;
    responses: { 200: User; 404: Problem<"NOT_FOUND"> };
  };
  "GET /users": {
    operationId: "listUsers";
    params: Record<never, never>;
    query: Record<never, never>;
    body: undefined;
    responses: { 200: User[] };
  };
  "POST /users": {
    operationId: "createUser";
    params: Record<never, never>;
    query: Record<never, never>;
    body: { name: string; email: string };
    responses: { 201: User; 409: Problem<"CONFLICT">; 422: Problem<"INVALID"> };
  };
  "DELETE /users/:id": {
    params: { id: string };
    responses: { 204: undefined };
  };
  "GET /search": {
    query: { q: string };
    headers: { "x-version": "1" | "2"; "x-limit"?: number; "x-dry"?: boolean };
    responses: { "200": { hits: number } };
  };
}

declare const api: Client<Routes>;
declare const signal: AbortSignal;

// --- 1. Verbs take the map's paths for that method, and only those ---------
void api.get("/users/:id", { params: { id: "1" } });
void api.post("/users", { body: { name: "a", email: "b" } });
void api.delete("/users/:id", { params: { id: "1" } });
// @ts-expect-error -- unknown route: no such path
void api.get("/nope");
// @ts-expect-error -- unknown route: the path exists, but not for POST
void api.post("/users/:id", { params: { id: "1" } });
// @ts-expect-error -- unknown route key for request()
void api.request("PUT /users/:id", { params: { id: "1" } });

// --- 2. Params ---------------------------------------------------------------
// @ts-expect-error -- wrong params: missing (the route has a required param)
void api.get("/users/:id");
// @ts-expect-error -- wrong params: missing id
void api.get("/users/:id", { params: {} });
// @ts-expect-error -- wrong params: id is a string
void api.get("/users/:id", { params: { id: 1 } });
// @ts-expect-error -- wrong params: an extra key
void api.get("/users/:id", { params: { id: "1", other: "x" } });
// @ts-expect-error -- wrong params: a route with none takes none
void api.get("/users", { params: { id: "1" } });
void api.get("/users"); // no options needed when nothing is required

// --- 3. Query ------------------------------------------------------------------
void api.get("/users/:id", {
  params: { id: "1" },
  query: { expand: ["org"], page: 2 },
});
// @ts-expect-error -- wrong query type: expand is string[]
void api.get("/users/:id", { params: { id: "1" }, query: { expand: "org" } });
// @ts-expect-error -- wrong query type: page is a number
void api.get("/users/:id", { params: { id: "1" }, query: { page: "2" } });
// @ts-expect-error -- wrong query: Record<never, never> declares none
void api.get("/users", { query: { page: 1 } });
// @ts-expect-error -- a required query key makes the options required
void api.get("/search");
void api.get("/search", { query: { q: "x" } });

// --- 4. Body -------------------------------------------------------------------
// @ts-expect-error -- missing body
void api.post("/users");
// @ts-expect-error -- wrong body: email missing
void api.post("/users", { body: { name: "a" } });
// @ts-expect-error -- a route declaring `body: undefined` takes none
void api.get("/users/:id", { params: { id: "1" }, body: { x: 1 } });

// --- 5. Declared headers are typed; others pass --------------------------------
void api.get("/search", {
  query: { q: "x" },
  headers: { "x-version": "2", "x-trace": "t" },
});
// @ts-expect-error -- wrong header value
void api.get("/search", { query: { q: "x" }, headers: { "x-version": "3" } });
// A header declared a number or a boolean takes that type (sent as its
// string); undeclared ones take any scalar.
void api.get("/search", {
  query: { q: "x" },
  headers: { "x-version": "1", "x-limit": 10, "x-dry": true, "x-n": 2 },
});
// @ts-expect-error -- a number header is a number, not its string
void api.get("/search", { query: { q: "x" }, headers: { "x-limit": "10" } });
// @ts-expect-error -- a boolean header is not a number
void api.get("/search", { query: { q: "x" }, headers: { "x-dry": 1 } });
// @ts-expect-error -- not a bigint (the client writes an object's headers through JSON)
void api.get("/search", { query: { q: "x" }, headers: { "x-n": 1n } });
// @ts-expect-error -- an undeclared header is a scalar, not an object
void api.get("/search", { query: { q: "x" }, headers: { "x-o": {} } });

// --- 6. The result, discriminated by status (§4.4) -----------------------------
async function results() {
  const r = await api.get("/users/:id", { params: { id: "1" } });
  type _r = Expect<Equal<typeof r, Result<Routes["GET /users/:id"]>>>;
  if (r.ok) {
    type _status = Expect<Equal<typeof r.status, 200>>;
    // Jsonify: the Date crossed the wire as a string.
    type _data = Expect<Equal<typeof r.data, Jsonify<User>>>;
    type _date = Expect<Equal<typeof r.data.createdAt, string>>;
    // @ts-expect-error -- no error on a success member
    void r.error.code;
  } else {
    type _status = Expect<Equal<typeof r.status, 404>>;
    type _code = Expect<Equal<typeof r.error.code, "NOT_FOUND">>;
  }

  const c = await api.post("/users", { body: { name: "a", email: "b" } });
  if (!c.ok) {
    type _statuses = Expect<Equal<typeof c.status, 409 | 422>>;
    if (c.status === 409) {
      type _code = Expect<Equal<typeof c.error.code, "CONFLICT">>;
    }
    // @ts-expect-error -- undeclared-status narrowing: 500 is not a declared status
    if (c.status === 500) void c;
  }

  // A string status key ("200") reads as the number.
  const _s = await api.get("/search", { query: { q: "x" } });
  type _sIs = Expect<Equal<typeof _s.status, 200>>;

  // An undeclared `responses` reads as { 200: unknown }.
  const _d = await api.delete("/users/:id", { params: { id: "1" } });
  type _dIs = Expect<Equal<typeof _d.status, 204>>;
}

// --- 7. undeclaredStatus: "result" adds the catch-all; status stops narrowing --
async function undeclared() {
  const r = await api.get("/users/:id", {
    params: { id: "1" },
    undeclaredStatus: "result",
  });
  type _r = Expect<Equal<typeof r, Result<Routes["GET /users/:id"], "result">>>;
  if (!r.ok) {
    type _status = Expect<Equal<typeof r.status, number>>;
    if (r.status === 404) {
      // The catch-all member still matches 404: `error` is no longer the problem.
      // @ts-expect-error -- undeclared-status narrowing: `code` is not on `unknown`
      void r.error.code;
    }
  }
  const lenient = createClient<Routes, { undeclaredStatus: "result" }>({
    undeclaredStatus: "result",
  });
  const _l = await lenient.get("/users", {});
  type _lIs = Expect<Equal<typeof _l, Result<Routes["GET /users"], "result">>>;
}

// --- 8. throwOnError, per call and per client ------------------------------------
async function throwing() {
  const _user = await api.get("/users/:id", {
    params: { id: "1" },
    throwOnError: true,
  });
  type _userIs = Expect<Equal<typeof _user, Jsonify<User>>>;
  const _both = await api.post("/users", {
    body: { name: "a", email: "b" },
    throwOnError: true,
  });
  type _bothIs = Expect<Equal<typeof _both, Jsonify<User>>>;

  const strict = createClient<Routes, { throwOnError: true }>({
    throwOnError: true,
  });
  const _list = await strict.get("/users");
  type _listIs = Expect<Equal<typeof _list, Jsonify<User>[]>>;
  const _back = await strict.get("/users", { throwOnError: false });
  type _backIs = Expect<Equal<typeof _back, Result<Routes["GET /users"]>>>;

  // @ts-expect-error -- the configuration must match the type argument: true needs `{ throwOnError: true }`
  createClient<Routes>({ throwOnError: true });
  // @ts-expect-error -- and the type argument needs the configuration to say so
  createClient<Routes, { throwOnError: true }>({});
  // @ts-expect-error -- the same for undeclaredStatus
  createClient<Routes>({ undeclaredStatus: "result" });

  const _error = null as unknown as HttpError<Routes["POST /users"]>;
  type _errStatus = Expect<Equal<typeof _error.status, 409 | 422>>;
  type _errCode = Expect<
    Equal<typeof _error.error.code, "CONFLICT" | "INVALID">
  >;
  const _anyError = null as unknown as HttpError;
  type _anyStatus = Expect<Equal<typeof _anyError.status, number>>;
}

// --- 9. Named operations (other-transports.md §2) --------------------------------
async function operations() {
  const _r = await api.op.getUser({ params: { id: "1" } });
  type _rIs = Expect<Equal<typeof _r, Result<Routes["GET /users/:id"]>>>;
  const _created = await api.op.createUser({
    body: { name: "a", email: "b" },
    throwOnError: true,
  });
  type _createdIs = Expect<Equal<typeof _created, Jsonify<User>>>;
  void api.op.listUsers();
  // @ts-expect-error -- named operations: wrong params, as for the path call
  void api.op.getUser({ params: { id: 1 } });
  // @ts-expect-error -- named operations: a missing body
  void api.op.createUser();
  // @ts-expect-error -- named operations: no such operation
  void api.op.getUsers();
  // @ts-expect-error -- named operations: a route with no operationId has no name
  void api.op.deleteUser;
  type _names = Expect<
    Equal<keyof typeof api.op, "getUser" | "listUsers" | "createUser">
  >;
}

// --- 10. request(), url(), and the per-call config --------------------------------
async function others() {
  const _r = await api.request("POST /users", {
    body: { name: "a", email: "b" },
    signal,
    timeout: 1_000,
    retry: false,
  });
  type _rIs = Expect<Equal<typeof _r, Result<Routes["POST /users"]>>>;
  const url: string = api.url("/users/:id", {
    params: { id: "1" },
    query: { page: 1 },
  });
  void url;
  // @ts-expect-error -- url(): wrong params
  api.url("/users/:id", { params: { id: 1 } });
  // @ts-expect-error -- url(): unknown path
  api.url("/nope");
  // @ts-expect-error -- per-call config: timeout is a number or false
  void api.get("/users", { timeout: "5s" });
}

// --- 11. The manifest is checked against the map --------------------------------
export const manifest = {
  "GET /users/:id": { operationId: "getUser", statuses: [200, 404] },
} as const satisfies RouteManifest<Routes>;
export const wrongName = {
  // @ts-expect-error -- a wrong operationId for the route
  "GET /users/:id": { operationId: "getUsers" },
} as const satisfies RouteManifest<Routes>;
export const wrongStatus = {
  // @ts-expect-error -- a status the route does not declare
  "GET /users/:id": { statuses: [200, 500] },
} as const satisfies RouteManifest<Routes>;
export const wrongRoute = {
  // @ts-expect-error -- a route not in the map
  "GET /nope": {},
} as const satisfies RouteManifest<Routes>;

// --- 12. Config: route keys are the map's ------------------------------------------
createClient<Routes>({ routes: { "GET /users": { timeout: 5 } }, manifest });
// @ts-expect-error -- per-route config for a route not in the map
createClient<Routes>({ routes: { "GET /nope": { timeout: 5 } } });

void results;
void undeclared;
void throwing;
void operations;
void others;

// --- 11. url() on a path several methods share ------------------------------
// `url` builds a URL without a method, so it takes the union of the methods'
// queries (this was `never` when two methods declared different ones).
interface SharedRoutes {
  "GET /items": {
    query: { page?: number };
    responses: { 200: string[] };
  };
  "DELETE /items": {
    query: { force: boolean };
    responses: { 204: undefined };
  };
  "GET /things/:id": {
    params: { id: string };
    query: { q: string };
    responses: { 200: string };
  };
}
declare const shared: Client<SharedRoutes>;

function sharedUrls() {
  // each method's query is accepted
  void shared.url("/items", { query: { page: 1 } });
  void shared.url("/items", { query: { force: true } });
  // the GET's query is optional, so the options may be left out
  void shared.url("/items");
  // @ts-expect-error -- url(): a query no method declares
  void shared.url("/items", { query: { page: "x" } });
  // @ts-expect-error -- url(): a key no method declares
  void shared.url("/items", { query: { nope: 1 } });
  // single-method path: unchanged
  void shared.url("/things/:id", { params: { id: "1" }, query: { q: "a" } });
  // @ts-expect-error -- url(): a single-method path still requires its params
  void shared.url("/things/:id");
  // @ts-expect-error -- url(): a single-method path still checks its query
  void shared.url("/things/:id", { params: { id: "1" }, query: { q: 1 } });
}
void sharedUrls;
