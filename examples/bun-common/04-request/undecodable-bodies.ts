/**
 * Undecodable bodies on the adapter: which route decides whether a body that
 * failed to decode is routed or refused before routing.
 *
 * ```bash
 * bun 04-request/undecodable-bodies.ts
 * ```
 *
 * `BunHttpAdapter` refuses a body it could not decode (JSON that does not
 * parse, a corrupt stream, an unsupported `Content-Encoding`) before routing,
 * as Express's global `json()` parser does. A router built with
 * `acceptUndecodableBody: true`, or a route carrying the
 * `acceptUndecodableBody()` marker, is routed it instead, with `req.body`
 * unset and the refusal on `req.bodyDecodingError`. `body-parsing.ts` shows
 * each kind of refusal routed, served and through `adapter.fetch()`, and the
 * 413 that stays before routing; this file is about precedence, so it sends
 * one body (`{`, declared JSON) through `adapter.fetch()`, which runs the very
 * handler `Bun.serve` calls.
 *
 * Worth knowing before reading it:
 *
 * - Middleware ahead of an opted-in route still runs, with `req.body` unset,
 *   so a route can authorize the caller before saying anything about the
 *   body — bun-jobs' management API answers `403` or its own
 *   `400 INVALID_JSON` this way.
 * - Nested mounts: the innermost router that sets the option wins. A router
 *   that leaves it unset takes its mount's setting, and `false` refuses even
 *   inside an opted-in router.
 * - A route's own `acceptUndecodableBody()` marker wins over its router's
 *   setting, `false` included.
 * - The first route handler the request matches decides, in pipeline order.
 *   With none, the middleware of the most deeply mounted router it reaches
 *   decides (a mounted router's own not-found middleware, say); with nothing
 *   matched, the adapter's own setting.
 * - The option is read when routes are registered: set it in the
 *   constructor.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import {
  acceptUndecodableBody,
  BunHttpAdapter,
  BunRouter,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Undecodable bodies: which route decides");

/** A JSON POST whose body (`{`) does not parse; `allow` sets `x-allow: 1`. */
function badJson(allow = true): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(allow ? { "x-allow": "1" } : {}),
    },
    body: "{",
  };
}

/** A route answering `200 { tag, refused }`, the refusal's status or `null`. */
function report(tag: string) {
  return (req: BunRequest, res: BunResponse) => {
    res.json({ tag, refused: req.bodyDecodingError?.status ?? null });
  };
}

/** A middleware answering `404 { tag }`: a mounted router's own not-found. */
function notFound(tag: string) {
  return (_req: BunRequest, res: BunResponse) => {
    res.status(404).json({ tag });
  };
}

/** An adapter with a silent logger. */
function adapter(): BunHttpAdapter {
  return new BunHttpAdapter(0, { logger: noopLogger });
}

/**
 * Sends the bad JSON to `path`: `"refused"` for the adapter's early HTML
 * 400, else `"<status> <tag>"` (`refused` appended when the route saw it on
 * `req.bodyDecodingError`), or `"<status> <code>"`.
 */
async function outcome(
  app: BunHttpAdapter,
  path: string,
  init: RequestInit = badJson(),
): Promise<string> {
  const res = await app.fetch(path, init);
  if (res.headers.get("Content-Type")?.startsWith("text/html")) {
    return /<pre>Bad Request<\/pre>/.test(await res.text())
      ? "refused"
      : `${res.status} html`;
  }
  const body = (await res.json()) as {
    tag?: string;
    code?: string;
    refused?: number | null;
  };
  const seen = body.refused === 400 ? " refused" : "";
  return `${res.status} ${body.tag ?? body.code}${seen}`;
}

/* ------------------------------------------------------------------ */
step("Middleware ahead of an opted-in route runs: authorize first");

/** Calls of `authorize` on each router. */
const authorized = { opted: 0, plain: 0 };

/** bun-jobs' order: authorize (403 without `x-allow`), then judge the body. */
function apiRouter(
  name: keyof typeof authorized,
  options?: { acceptUndecodableBody?: boolean },
): BunRouter {
  const router = new BunRouter(options);
  router.use((req, res, next) => {
    authorized[name]++;
    if (req.getHeader("x-allow") !== "1") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    next();
  });
  router.post("/q/pause", (req, res) => {
    if (req.bodyDecodingError) {
      res.status(400).json({ code: "INVALID_JSON" });
      return;
    }
    res.json({ code: "PAUSED" });
  });
  return router;
}

const api = adapter();
api.use("/api", apiRouter("opted", { acceptUndecodableBody: true }));
api.use("/plain-api", apiRouter("plain"));
checkEqual(
  "opted in: a denied caller gets the router's 403, an allowed one its own 400 INVALID_JSON",
  [
    await outcome(api, "/api/q/pause", badJson(false)),
    await outcome(api, "/api/q/pause", badJson(true)),
    authorized.opted,
  ],
  ["403 FORBIDDEN", "400 INVALID_JSON", 2],
);
checkEqual(
  "the same router without the option: refused before routing, authorize never called",
  [
    await outcome(api, "/plain-api/q/pause", badJson(false)),
    await outcome(api, "/plain-api/q/pause", badJson(true)),
    authorized.plain,
  ],
  ["refused", "refused", 0],
);

/* ------------------------------------------------------------------ */
step("Nested mounts: the innermost router that sets it wins");

const inner = new BunRouter({ acceptUndecodableBody: true });
inner.post("/r", report("inner"));
for (const outerOption of [undefined, false]) {
  const outer = new BunRouter({ acceptUndecodableBody: outerOption });
  outer.post("/own", report("outer"));
  outer.use("/in", inner);
  const app = adapter();
  app.use("/v1", outer);
  checkEqual(
    `an opted-in router mounted in ${outerOption === undefined ? "one that left it unset" : "one set to false"}: its route gets the body, the outer route is refused`,
    [await outcome(app, "/v1/in/r"), await outcome(app, "/v1/own")],
    ["200 inner refused", "refused"],
  );
}

const unset = new BunRouter();
unset.post("/r", report("unset"));
const off = new BunRouter({ acceptUndecodableBody: false });
off.post("/r", report("off"));
const optedOuter = new BunRouter({ acceptUndecodableBody: true });
optedOuter.use("/unset", unset);
optedOuter.use("/off", off);
const nested = adapter();
nested.use("/v1", optedOuter);
checkEqual(
  "inside an opted-in router: one left unset takes its setting, one set to false is refused",
  [await outcome(nested, "/v1/unset/r"), await outcome(nested, "/v1/off/r")],
  ["200 unset refused", "refused"],
);

/* ------------------------------------------------------------------ */
step("A route's marker wins over its router's false");

const strict = new BunRouter({ acceptUndecodableBody: false });
strict.post("/marked", acceptUndecodableBody(), report("marked"));
strict.post("/sibling", report("sibling"));
const marked = adapter();
marked.use(strict);
checkEqual(
  "acceptUndecodableBody() on one route: it gets the body, its sibling is refused",
  [await outcome(marked, "/marked"), await outcome(marked, "/sibling")],
  ["200 marked refused", "refused"],
);

/* ------------------------------------------------------------------ */
step("The first route handler the request matches decides");

const opted = new BunRouter({ acceptUndecodableBody: true });
opted.post("/r", report("opted"));

const plainFirst = adapter();
// A route handler of the adapter's own, not opted in, that only passes on.
plainFirst.post("/r", (_req, _res, next) => next());
plainFirst.use(opted);
const optedFirst = adapter();
optedFirst.use(opted);
optedFirst.post("/r", report("plain"));
checkEqual(
  "a plain handler matched first: refused, though an opted-in one follows; mounted first, the opted-in one gets it",
  [await outcome(plainFirst, "/r"), await outcome(optedFirst, "/r")],
  ["refused", "200 opted refused"],
);

/* ------------------------------------------------------------------ */
step("No route handler: the most deeply mounted middleware decides");

const offInside = new BunRouter({ acceptUndecodableBody: false });
offInside.use(notFound("off"));
const optedWithNotFound = new BunRouter({ acceptUndecodableBody: true });
optedWithNotFound.use("/off", offInside);
optedWithNotFound.use(notFound("outer"));
const deep = adapter();
deep.use("/v1", optedWithNotFound);
// A trailing middleware of the adapter's own does not outvote the mount.
deep.use(notFound("app"));
checkEqual(
  "the opted-in router's own not-found answers; inside it, a false router's is refused; outside both, the adapter's own setting refuses",
  [
    await outcome(deep, "/v1/missing"),
    await outcome(deep, "/v1/off/missing"),
    await outcome(deep, "/elsewhere"),
  ],
  ["404 outer", "refused", "refused"],
);

summary();
