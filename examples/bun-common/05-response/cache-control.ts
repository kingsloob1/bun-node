/**
 * `Cache-Control` from a typed object — `cacheControl()`, `formatCacheControl()`
 * and `parseCacheControl()` — and `res.addResponseTransform(t, { first: true })`,
 * the hook a response cache captures with.
 *
 * ```bash
 * bun 05-response/cache-control.ts
 * ```
 *
 * Worth knowing before reading it:
 *
 * - Every lifetime is in **seconds**, as the header is, not milliseconds
 *   (`maxAge: 60` is a minute). Anything that is not a non-negative safe
 *   integer is a `RangeError`.
 * - `public` with `private`, and `noStore` with any lifetime, are compile
 *   errors (the `@ts-expect-error` lines below fail the type check if the
 *   types loosen) and `TypeError`s at run time for a value the types did not
 *   see. `noStore` with `mustUnderstand` is allowed.
 * - `cacheControl()` formats once, so a bad directive throws when the route is
 *   built. It replaces an earlier `Cache-Control`, calls `next()`, and leaves
 *   a sent response alone; the handler can still change the header.
 * - `private` and `noCache` take a list of field names for the qualified
 *   forms, always written quoted.
 * - `parseCacheControl()` never throws. A duplicate keeps its first
 *   occurrence (`duplicates`), a malformed argument reads the most
 *   restrictive way (`invalid`), unknown directives go to `extensions`.
 * - Transforms run in registration order; `{ first: true }` puts one ahead
 *   of those registered so far, so it sees the `Response` as the route
 *   produced it, before `compression()`.
 */
import { gunzipSync } from "node:zlib";
import type { CacheControlDirectives } from "@kingsleyweb/bun-common";
import {
  BunRouter,
  cacheControl,
  compression,
  formatCacheControl,
  parseCacheControl,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Cache-Control");

/** A body over the 1 KiB `compression()` threshold. */
const text = "cache me if you can. ".repeat(100);

/** Asks for gzip. */
const gzip = { headers: { "accept-encoding": "gzip" } };

/* ------------------------------------------------------------------ */
step("The middleware: three routes, three policies (seconds, not ms)");

const router = new BunRouter();
router.get(
  "/assets/app.js",
  cacheControl({ public: true, maxAge: 31_536_000, immutable: true }),
  (_req, res) => {
    res.type("js").send("console.log(1)");
  },
);
router.get(
  "/feed",
  cacheControl({ sMaxAge: 60, staleWhileRevalidate: 30, staleIfError: 600 }),
  (_req, res) => {
    res.json({ items: [] });
  },
);
router.get(
  "/me",
  cacheControl({ private: true, noStore: true }),
  (_req, res) => {
    res.json({ name: "Ada" });
  },
);

for (const [path, expected] of [
  ["/assets/app.js", "public, max-age=31536000, immutable"],
  ["/feed", "s-maxage=60, stale-while-revalidate=30, stale-if-error=600"],
  ["/me", "private, no-store"],
] as const) {
  const response = await router.fetch(path);
  show(path, response.headers.get("cache-control"));
  checkEqual(
    `${path} Cache-Control`,
    response.headers.get("cache-control"),
    expected,
  );
}

/* ------------------------------------------------------------------ */
step("formatCacheControl: the qualified forms, always quoted");

checkEqual(
  "private with a field list",
  formatCacheControl({
    private: ["Set-Cookie"],
    maxAge: 0,
    mustRevalidate: true,
  }),
  'private="Set-Cookie", max-age=0, must-revalidate',
);
checkEqual(
  "no-cache with two fields",
  formatCacheControl({ noCache: ["Set-Cookie", "Authorization"] }),
  'no-cache="Set-Cookie, Authorization"',
);
checkEqual(
  "noStore with mustUnderstand is allowed",
  formatCacheControl({ noStore: true, mustUnderstand: true }),
  "no-store, must-understand",
);
checkEqual(
  "a false or undefined directive is left out",
  formatCacheControl({ public: false, maxAge: 5, noCache: undefined }),
  "max-age=5",
);

/* ------------------------------------------------------------------ */
step("Contradictions: compile errors, and run-time throws for what slips by");

// Both of these fail the type check if the line stops being an error.
// @ts-expect-error public and private contradict
const publicAndPrivate: CacheControlDirectives = {
  public: true,
  private: true,
};
// @ts-expect-error a response nothing may store has no lifetime
const storeAndAge: CacheControlDirectives = {
  noStore: true,
  maxAge: 60,
} as const;

// The values exist anyway (a cast, JSON, a `boolean` variable the types could
// not narrow); the formatter still refuses them.
await checkRejects(
  "public with private",
  () => formatCacheControl(publicAndPrivate),
  {
    name: "TypeError",
    message: /both public and private/,
  },
);
await checkRejects(
  "noStore with maxAge",
  () => formatCacheControl(storeAndAge),
  {
    name: "TypeError",
    message: /noStore/,
  },
);
await checkRejects(
  "a negative lifetime",
  () => formatCacheControl({ maxAge: -1 }),
  {
    name: "RangeError",
  },
);
await checkRejects(
  "a fractional lifetime",
  () => formatCacheControl({ maxAge: 1.5 }),
  {
    name: "RangeError",
  },
);
await checkRejects(
  "an unknown key",
  () => formatCacheControl({ max_age: 60 } as never),
  { name: "TypeError", message: /max_age/ },
);
await checkRejects(
  "an empty field list",
  () => formatCacheControl({ private: [] }),
  { name: "TypeError" },
);
await checkRejects(
  "a bad route is refused when it is built, not per request",
  () => cacheControl({ maxAge: -1 }),
  { name: "RangeError" },
);
await checkRejects("no directives at all", () => cacheControl({}), {
  name: "TypeError",
  message: /at least one directive/,
});

/* ------------------------------------------------------------------ */
step("surrogateControl: the CDN's header beside the browser's");

const cdn = new BunRouter();
cdn.get(
  "/page",
  cacheControl(
    { public: true, maxAge: 60 },
    { surrogateControl: { maxAge: 3600, staleWhileRevalidate: 60 } },
  ),
  (_req, res) => {
    res.send("page");
  },
);
const page = await cdn.fetch("/page");
show("both headers", {
  "cache-control": page.headers.get("cache-control"),
  "surrogate-control": page.headers.get("surrogate-control"),
});
checkEqual(
  "Cache-Control",
  page.headers.get("cache-control"),
  "public, max-age=60",
);
checkEqual(
  "Surrogate-Control",
  page.headers.get("surrogate-control"),
  "max-age=3600, stale-while-revalidate=60",
);

/* ------------------------------------------------------------------ */
step("The handler has the last word");

const override = new BunRouter();
override.get("/x", cacheControl({ public: true, maxAge: 60 }), (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send("x");
});
checkEqual(
  "the handler's header replaced the middleware's",
  (await override.fetch("/x")).headers.get("cache-control"),
  "no-store",
);

/* ------------------------------------------------------------------ */
step("noTransform keeps compression() off the body");

const shop = new BunRouter();
shop.use(compression());
shop.get("/plain", (_req, res) => {
  res.type("text").send(text);
});
shop.get("/pinned", cacheControl({ noTransform: true }), (_req, res) => {
  res.type("text").send(text);
});
const plain = await shop.fetch("/plain", gzip);
const pinned = await shop.fetch("/pinned", gzip);
show("without noTransform", plain.headers.get("content-encoding"));
show("with noTransform", pinned.headers.get("content-encoding"));
checkEqual("sibling is gzip", plain.headers.get("content-encoding"), "gzip");
checkEqual(
  "noTransform is identity",
  pinned.headers.get("content-encoding"),
  null,
);
checkEqual("…and the text is whole", await pinned.text(), text);

/* ------------------------------------------------------------------ */
step("addResponseTransform(t, { first: true }): see the response as produced");

/** What a capturing transform saw. */
interface Seen {
  /** `Content-Encoding` of the `Response` it was handed. */
  encoding: string | null;
  /** The buffered body it was handed, or `undefined`. */
  body: string | undefined;
}

/** A router with `compression()` first, then a capture, `first` or not. */
function captureRouter(first: boolean): { router: BunRouter; seen: Seen[] } {
  const seen: Seen[] = [];
  const captured = new BunRouter();
  captured.use(compression());
  captured.use((_req, res, next) => {
    res.addResponseTransform(
      {
        transform(response, context) {
          seen.push({
            encoding: response.headers.get("content-encoding"),
            body: typeof context.body === "string" ? context.body : undefined,
          });
          return response;
        },
      },
      { first },
    );
    next();
  });
  captured.get("/", (_req, res) => {
    res.type("text").send(text);
  });
  return { router: captured, seen };
}

const early = captureRouter(true);
const earlyResponse = await early.router.fetch("/", gzip);
checkEqual("first: the capture saw the text", early.seen, [
  { encoding: null, body: text },
]);
checkEqual(
  "first: the client still gets gzip",
  earlyResponse.headers.get("content-encoding"),
  "gzip",
);
checkEqual(
  "first: …that decodes to the same text",
  gunzipSync(await earlyResponse.bytes()).toString(),
  text,
);

const late = captureRouter(false);
await late.router.fetch("/", gzip);
checkEqual("control, no first: the capture saw gzip and no body", late.seen, [
  { encoding: "gzip", body: undefined },
]);

/* ------------------------------------------------------------------ */
step("parseCacheControl: read a header back");

checkEqual(
  "a response header (names are case-insensitive, quoted arguments read)",
  parseCacheControl('public, Max-Age="60", stale-while-revalidate=30'),
  { public: true, maxAge: 60, staleWhileRevalidate: 30 },
);
checkEqual("a request header", parseCacheControl("only-if-cached, max-stale"), {
  onlyIfCached: true,
  maxStale: true,
});
const directives = {
  private: ["Set-Cookie"],
  maxAge: 0,
  mustRevalidate: true,
} as const;
checkEqual(
  "parse(format(d)) is d",
  parseCacheControl(formatCacheControl(directives)),
  { private: ["Set-Cookie"], maxAge: 0, mustRevalidate: true },
);
checkEqual(
  "a lifetime past 2^31 is capped (RFC 9111 §1.2.2)",
  parseCacheControl("max-age=99999999999").maxAge,
  2_147_483_648,
);

const duplicated = parseCacheControl("max-age=60, max-age=10");
checkEqual("a duplicate keeps the first", duplicated, {
  maxAge: 60,
  duplicates: ["max-age"],
});

const invalid = parseCacheControl("max-age=soon");
checkEqual("a malformed lifetime reads 0 (stale)", invalid, {
  maxAge: 0,
  invalid: ["max-age"],
});

const extended = parseCacheControl('max-age=5, community="UCI"');
checkEqual(
  "an unknown directive goes to extensions",
  extended.extensions?.community,
  "UCI",
);
check(
  "…which has no prototype",
  Object.getPrototypeOf(extended.extensions) === null,
);
checkEqual("null reads as no directives", parseCacheControl(null), {});
checkEqual("so does the empty string", parseCacheControl(""), {});
show('parseCacheControl("max-age=60, max-age=10")', duplicated);

summary();
