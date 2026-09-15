/**
 * Compile-time assertions for the types the `unknown` pass introduced on
 * `BunRouter`, `BunHttpAdapter` and `types/general.ts`: the generic
 * `group()`/`domain()` callback router, the typed `listen()`/`setTimeout()`
 * callbacks, and the narrowed option and request types.
 *
 * Checked by the tests typecheck, not `bun test`. Each `@ts-expect-error` is a
 * negative control: if the type it guards widened, the directive itself fails.
 */
import type { Server } from "bun";
import type {
  BunHttpAdapter,
  errorStatusCode,
  ResolvedBunRequestOptions,
} from "../lib/BunHttpAdapter";
import type { FETCH_STUB_SERVER, MatchedLayer } from "../lib/BunRouter";
import type { ValidatorMiddleware } from "../lib/BunValidate";
import type { WebSocketClientData } from "../lib/BunWebSocket";
import type {
  BodyParserOptions,
  BunRequestInterface,
  MultiPartFieldRecord,
  SendFileOptions,
} from "../lib/types/general";
import type { ExtractHostParams } from "../lib/types/routeParams";
import type {
  EmptyShape,
  RouterVerb,
  RouterVerbMethod,
} from "../lib/types/routeTyping";
import type { JsonValue } from "../lib/utils/native";
import { BunRouter } from "../lib/BunRouter";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- group(): the callback's router is mounted at the group path --------- */

const root = new BunRouter();

root.group("/users/:id", (router) => {
  type _groupRouter = Expect<
    Equal<typeof router, BunRouter<"/users/:id", EmptyShape>>
  >;

  router.get("/posts/:postId", (_req) => {
    type _params = Expect<
      Equal<typeof _req.params, { id: string; postId: string }>
    >;
  });

  router.get("/posts", (_req) => {
    // @ts-expect-error `nope` is not a param of "/users/:id/posts"
    type _nope = typeof _req.params.nope;
  });

  // @ts-expect-error the group's router is not a router mounted elsewhere
  const _elsewhere: BunRouter<"/other"> = router;
});

/* --- group() on a mounted router: the prefixes and the shape carry ------- */

const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();

orgs.group("/teams/:team", (router) => {
  type _groupRouter = Expect<
    Equal<
      typeof router,
      BunRouter<"/orgs/:org/teams/:team", { query: { page: number } }>
    >
  >;

  router.get("/list", (_req) => {
    type _params = Expect<
      Equal<typeof _req.params, { org: string; team: string }>
    >;
    type _query = Expect<Equal<typeof _req.query, { page: number }>>;
  });
});

/* --- domain(): a host adds no path, so the router keeps this mount ------- */
/* ...and carries the host pattern, whose captures reach req.params.       */

orgs.domain(":tenant.example.test", (router) => {
  type _domainRouter = Expect<
    Equal<
      typeof router,
      BunRouter<
        "/orgs/:org",
        { query: { page: number } },
        ":tenant.example.test"
      >
    >
  >;

  router.get("/members/:id", (_req) => {
    type _params = Expect<
      Equal<typeof _req.params, { tenant: string; org: string; id: string }>
    >;
    type _query = Expect<Equal<typeof _req.query, { page: number }>>;
  });

  router.get("/members", (_req) => {
    // @ts-expect-error `region` is captured by neither the host nor the path
    type _nope = typeof _req.params.region;
  });

  // A group inside a domain keeps the host.
  router.group("/teams/:team", (group) => {
    group.get("/list", (_req) => {
      type _params = Expect<
        Equal<typeof _req.params, { tenant: string; org: string; team: string }>
      >;
    });
  });

  // A nested domain keeps the outer host, as the runtime does.
  router.domain(":region.inner.test", (inner) => {
    inner.get("/n", (_req) => {
      type _params = Expect<
        Equal<typeof _req.params, { tenant: string; org: string }>
      >;
    });
  });
});

root.domain("api.example.test", (router) => {
  type _domainRouter = Expect<
    Equal<typeof router, BunRouter<"", EmptyShape, "api.example.test">>
  >;
  // A literal host captures nothing, so params stay the path's alone.
  router.get("/users/:id", (_req) => {
    type _params = Expect<Equal<typeof _req.params, { id: string }>>;
  });
});

// A path param of the same name as a host param wins, and stays required.
root.domain(":id?.example.test", (router) => {
  router.get("/users/:id", (_req) => {
    type _params = Expect<Equal<typeof _req.params, { id: string }>>;
  });
  router.get("/users", (_req) => {
    type _params = Expect<Equal<typeof _req.params, { id?: string }>>;
  });
});

// A validator's params replace req.params wholesale, host captures included.
declare const idParams: ValidatorMiddleware<{ params: { id: number } }>;
root.domain(":tenant.example.test", (router) => {
  router.get("/users/:id", idParams, (_req) => {
    type _params = Expect<Equal<typeof _req.params, { id: number }>>;
  });
});

/* --- ExtractHostParams: the forms routejs's host tokenizer accepts ------- */

type _hostPlain = Expect<
  Equal<ExtractHostParams<":tenant.example.com">, { tenant: string }>
>;
type _hostTwo = Expect<
  Equal<
    ExtractHostParams<":tenant-:region.example.com">,
    { tenant: string; region: string }
  >
>;
type _hostOptional = Expect<
  Equal<ExtractHostParams<":tenant?.example.com">, { tenant?: string }>
>;
type _hostRegex = Expect<
  Equal<
    ExtractHostParams<":tenant([a-z]+(?:\\.[a-z]+)?).example.com">,
    { tenant: string }
  >
>;
type _hostRegexOptional = Expect<
  Equal<ExtractHostParams<"api.:v(\\d+)?.example.com">, { v?: string }>
>;
type _hostWildcards = Expect<
  Equal<
    ExtractHostParams<"*.(eu|us).example.com">,
    { "0": string; "1": string }
  >
>;
type _hostEscaped = Expect<
  Equal<ExtractHostParams<"a\\:b.example.com">, EmptyShape>
>;
type _hostLiteral = Expect<Equal<ExtractHostParams<"example.com">, EmptyShape>>;
type _hostDynamic = Expect<
  Equal<ExtractHostParams<string>, Record<string, string>>
>;
type _hostNegative = Expect<
  // @ts-expect-error negative control: the capture is required, not optional
  Equal<ExtractHostParams<":tenant.example.com">, { tenant?: string }>
>;

/* --- a callback declared ahead with a plain router still fits ------------ */

function fill(router: BunRouter): void {
  router.get("/x", (_req, res) => res.send("x"));
}
root.group("/v1/:version", fill);
root.domain("api.example.test", fill);

// The callback's result is ignored, so returning something is fine.
root.group("/v2", (router) => router.get("/y", (_req, res) => res.send("y")));

/* --- listen() and setTimeout(): the callback gets the adapter's server --- */

type ChatServer = Server<WebSocketClientData<{ userId: string }>>;
declare const chat: BunHttpAdapter<{ userId: string }>;

export async function listenTypes(): Promise<void> {
  const _server = await chat.listen(0, (_listening) => {
    type _callback = Expect<Equal<typeof _listening, ChatServer>>;
  });
  type _resolved = Expect<Equal<typeof _server, ChatServer>>;

  const _named = await chat.listen(0, "localhost", async (_listening) => {
    type _callback = Expect<Equal<typeof _listening, ChatServer>>;
  });
  type _resolvedNamed = Expect<Equal<typeof _named, ChatServer>>;

  // @ts-expect-error the callback receives the server, not a string
  await chat.listen(0, (listening: string) => listening);

  const _port = await chat.setTimeout(10, (_listening) => {
    type _callback = Expect<Equal<typeof _listening, ChatServer>>;
    return 42;
  });
  type _resolvedPort = Expect<Equal<typeof _port, number>>;

  const _done = await chat.setTimeout(10, async () => "done");
  type _resolvedDone = Expect<Equal<typeof _done, string>>;

  // A callback that takes `unknown` (as older code wrote it) still fits.
  await chat.setTimeout(10, (listening: unknown) => listening);
}

/* --- eventEmitter: the adapter's lifecycle events are typed -------------- */

chat.eventEmitter.on("listening", (_listening) => {
  type _listeningServer = Expect<Equal<typeof _listening, ChatServer>>;
});
chat.eventEmitter.once("close", (..._args) => {
  type _closeArgs = Expect<Equal<typeof _args, []>>;
});
// A listener that names the server type, as existing code does, still fits.
chat.eventEmitter.on("listening", (server: ChatServer) => server.port);
// @ts-expect-error `listening` hands over the server, not a string.
chat.eventEmitter.on("listening", (server: string) => server);
// @ts-expect-error `close` carries no arguments.
chat.eventEmitter.emit("close", "unexpected");

/* --- narrowed option, request and pipeline types ------------------------- */

type _status = Expect<Equal<ReturnType<typeof errorStatusCode>, number>>;
type _layerBaseUrl = Expect<Equal<MatchedLayer["baseUrl"], string>>;
type _stub = Expect<Equal<typeof FETCH_STUB_SERVER, Server<unknown>>>;

type _baseUrl = Expect<Equal<BunRequestInterface["baseUrl"], string>>;
type _cookies = Expect<
  Equal<BunRequestInterface["cookies"], Record<string, JsonValue>>
>;
type _signed = Expect<
  Equal<BunRequestInterface["signedCookies"], Record<string, JsonValue>>
>;
// Unvalidated client input stays `unknown`.
type _field = Expect<Equal<MultiPartFieldRecord["value"], unknown>>;

export const sendFileOptions: SendFileOptions = {
  dotfiles: "deny",
  acceptRanges: false,
  maxAge: "2h",
  headers: { "X-One": "1", "X-Two": 2, "X-List": ["a", "b"] },
};

export const badHeader: SendFileOptions = {
  // @ts-expect-error a header value is a string, a number or a list of strings
  headers: { "X-Bad": { nested: true } },
};

export const fastPathLimit: BodyParserOptions = {
  inflate: true,
  decompressionFastPathLimit: 8 * 1024 * 1024,
};
type _fastPathLimit = Expect<
  Equal<BodyParserOptions["decompressionFastPathLimit"], number | undefined>
>;
export const badFastPathLimit: BodyParserOptions = {
  // @ts-expect-error the limit is a byte count, not a size string
  decompressionFastPathLimit: "32mb",
};

export const typePredicate: BodyParserOptions = {
  // Truthy parses, as body-parser's `type` function.
  type: (req) => req.headers["content-type"],
};

/* --- RouterVerbMethod: a verb chosen at runtime needs no cast ------------ */

// Every RouterVerb is a method on the router and on the adapter.
type _verbsOnRouter = Expect<
  Equal<Extract<RouterVerb, keyof BunRouter>, RouterVerb>
>;
type _verbsOnAdapter = Expect<
  Equal<Extract<RouterVerb, keyof BunHttpAdapter>, RouterVerb>
>;
// @ts-expect-error negative control: `use` mounts middleware, it is not a verb
export const notAVerb: RouterVerb = "use";

declare const dynamicVerb: RouterVerb;
const verbRouter = new BunRouter();

// Every verb carries the same generated overload list, so TypeScript merges
// the union's signatures and a direct call type-checks, handler typed...
verbRouter[dynamicVerb]("/doc", (_req, res) => {
  // @ts-expect-error negative control: the handler's `res` is not `any`
  res.nope();
  res.send("x");
});

// ...and the union assigns to the shared untyped signature, without a cast,
// which holds even should the overload lists ever diverge per verb.
const registerOnRouter: RouterVerbMethod<BunRouter> = verbRouter[dynamicVerb];
const _returnedRouter = registerOnRouter.call(
  verbRouter,
  "/doc",
  (_req, res) => {
    // The inline handler is contextually typed, not left on implicit `any`.
    // @ts-expect-error negative control: `res.send` exists, `res.nope` does not
    res.nope();
    res.send("x");
  },
);
type _returnsRouter = Expect<Equal<typeof _returnedRouter, BunRouter>>;
// `all` shares the signature too.
export const registerAll: RouterVerbMethod<BunRouter> = verbRouter.all;

declare const verbAdapter: BunHttpAdapter;
const registerOnAdapter: RouterVerbMethod<BunHttpAdapter> =
  verbAdapter[dynamicVerb];
const _returnedAdapter = registerOnAdapter.call(verbAdapter, "/doc", () => {});
type _returnsAdapter = Expect<Equal<typeof _returnedAdapter, BunHttpAdapter>>;

// requestOpts is always merged over the defaults, so it is never undefined:
// its fields are readable without narrowing, while the setter takes a partial.
export const readParseBody = verbAdapter.requestOpts.parseBody;
type _requestOpts = Expect<
  Equal<typeof verbAdapter.requestOpts, ResolvedBunRequestOptions>
>;
verbAdapter.requestOpts = { cookieSecret: "k" };
verbAdapter.setRequestOpts({ parseBody: false });

// @ts-expect-error negative control: detached, the method would lose its router
registerOnRouter("/doc", () => {});
// @ts-expect-error negative control: `this` must be the router it came from
registerOnAdapter.call(verbRouter, "/doc", () => {});
// @ts-expect-error negative control: a non-verb key's method is not a verb method
export const notAVerbMethod: RouterVerbMethod<BunRouter> = verbRouter.routes;
