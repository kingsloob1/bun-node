/**
 * CORS — every `CorsOptions` field, preflight versus simple requests, and
 * per-request options with a `CorsOptionsDelegate`.
 *
 * ```bash
 * bun 07-cors-and-static/cors.ts
 * ```
 *
 * `cors(options)` is a native, dependency-free port of the `cors` package, with
 * the same option names and defaults:
 *
 * | option                 | default                              |
 * |------------------------|--------------------------------------|
 * | `origin`               | `"*"`                                |
 * | `methods`              | `"GET,HEAD,PUT,PATCH,POST,DELETE"`   |
 * | `allowedHeaders`       | reflect `Access-Control-Request-Headers` |
 * | `exposedHeaders`       | none                                 |
 * | `credentials`          | `false`                              |
 * | `maxAge`               | none                                 |
 * | `preflightContinue`    | `false` — answer the preflight itself |
 * | `optionsSuccessStatus` | `204`                                |
 *
 * A few things worth knowing before reading it:
 *
 * - Any `OPTIONS` request is treated as a preflight. Only a preflight gets
 *   `Allow-Methods`, `Allow-Headers` and `Max-Age`; every request gets
 *   `Allow-Origin`, `Allow-Credentials` and `Expose-Headers`.
 * - An origin that is not allowed is not an error: the request still runs, the
 *   `Access-Control-Allow-Origin` header is simply absent, and the browser
 *   refuses to hand the response to the page.
 * - `origin` as a plain **string** is sent as it is, whatever the request's
 *   origin; to allow one origin *conditionally*, use an array, a RegExp or a
 *   function.
 */
import type {
  BunRequest,
  CorsOptions,
  CorsOptionsDelegate,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter, cors } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("CORS");

const APP = "https://app.example.test";
const EVIL = "https://evil.example.test";

/** A router with `cors(options)` in front of one small API. */
function api(options?: CorsOptions): BunRouter {
  const router = new BunRouter();
  router.use(cors(options));
  router.get("/items", (_req, res) => {
    res.setHeader("X-Total-Count", "2");
    res.json({ items: ["a", "b"] });
  });
  // Only reached by a preflight when `preflightContinue` is set.
  router.options("/items", (_req, res) => {
    res.status(200).send("the route answered the preflight");
  });
  router.use(((error, _req, res, _next) => {
    res.status(500).json({ error: (error as Error).message });
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/** The status and every CORS-related header of a response. */
function corsView(response: Response): Record<string, string> {
  const view: Record<string, string> = { status: String(response.status) };
  for (const [name, value] of response.headers) {
    if (name.startsWith("access-control-") || name === "vary") {
      view[name] = value;
    }
  }
  return view;
}

/** A plain cross-origin GET from `origin`. */
async function simple(router: BunRouter, origin?: string): Promise<Response> {
  return router.fetch("/items", {
    headers: origin ? { Origin: origin } : {},
  });
}

/** A browser preflight for a PUT with a JSON body and a custom header. */
async function preflight(router: BunRouter, origin = APP): Promise<Response> {
  return router.fetch("/items", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,x-request-id",
    },
  });
}

/* ------------------------------------------------------------------ */
step("Defaults: any origin, simple request versus preflight");

const open = api();
const openGet = await simple(open, APP);
show("simple GET", corsView(openGet));
show("…and the route still ran", await openGet.json());

const openPreflight = await preflight(open);
show("preflight OPTIONS — answered by the middleware", corsView(openPreflight));
show("…with an empty body", JSON.stringify(await openPreflight.text()));

/* ------------------------------------------------------------------ */
step("origin: string — sent as it is, whatever the request's origin");

const fixed = api({ origin: APP });
show("from the app", corsView(await simple(fixed, APP)));
show(
  "from elsewhere (the browser will block it)",
  corsView(await simple(fixed, EVIL)),
);

/* ------------------------------------------------------------------ */
step("origin: true reflects the request's origin; false disables CORS");

show("true, from the app", corsView(await simple(api({ origin: true }), APP)));
show("true, no Origin header", corsView(await simple(api({ origin: true }))));
show("false", corsView(await simple(api({ origin: false }), APP)));

/* ------------------------------------------------------------------ */
step("origin: RegExp, or an array of strings and RegExps");

const pattern = api({ origin: /\.example\.test$/ });
show("RegExp, matching", corsView(await simple(pattern, APP)));
show(
  "RegExp, not matching",
  corsView(await simple(pattern, "https://example.org")),
);

const list = api({ origin: [APP, /^http:\/\/localhost:\d+$/] });
show("array, the listed origin", corsView(await simple(list, APP)));
show(
  "array, a localhost port",
  corsView(await simple(list, "http://localhost:5173")),
);
show("array, anything else", corsView(await simple(list, EVIL)));

/* ------------------------------------------------------------------ */
step("origin: function — decide per origin, asynchronously if need be");

/** Origins a tenant table allows, as a database would answer. */
const tenants = new Set([APP, "https://partner.example.test"]);

const dynamic = api({
  origin: (origin, callback) => {
    if (origin === "https://broken.example.test") {
      // An error goes to `next(err)` — the error handler answers.
      callback(new Error("tenant lookup failed"));
      return;
    }
    setTimeout(() => {
      callback(null, origin !== undefined && tenants.has(origin));
    }, 1);
  },
});
show(
  "a known tenant",
  corsView(await simple(dynamic, "https://partner.example.test")),
);
show("an unknown origin", corsView(await simple(dynamic, EVIL)));
const failed = await simple(dynamic, "https://broken.example.test");
show("the lookup failed", { ...corsView(failed), body: await failed.json() });

/* ------------------------------------------------------------------ */
step("methods, allowedHeaders, maxAge — preflight only");

const strict = api({
  origin: APP,
  methods: ["GET", "PUT"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
});
show("preflight", corsView(await preflight(strict)));
show("…none of them on a simple request", corsView(await simple(strict, APP)));

/* ------------------------------------------------------------------ */
step("exposedHeaders and credentials — every request");

const withCookies = api({
  origin: APP,
  credentials: true,
  exposedHeaders: "X-Total-Count,ETag",
});
const exposed = await simple(withCookies, APP);
show("simple GET", corsView(exposed));
show(
  "…so page script may read X-Total-Count",
  exposed.headers.get("x-total-count"),
);

/* ------------------------------------------------------------------ */
step("preflightContinue and optionsSuccessStatus");

show(
  "preflightContinue: true — headers set, then the OPTIONS route answers",
  await (async () => {
    const response = await preflight(api({ preflightContinue: true }));
    return { ...corsView(response), body: await response.text() };
  })(),
);
// Some legacy browsers (IE11, old Android WebViews) choke on a 204 preflight.
show(
  "optionsSuccessStatus: 200",
  corsView(await preflight(api({ optionsSuccessStatus: 200 }))),
);

/* ------------------------------------------------------------------ */
step("CorsOptionsDelegate — options per request, via adapter.enableCors");

/** Public routes are open to anyone; the rest only to the app, with cookies. */
const delegate: CorsOptionsDelegate<BunRequest> = (req, callback) => {
  if (req.getHeader("Origin") === "https://banned.example.test") {
    callback(new Error("origin banned"));
    return;
  }
  callback(
    null,
    req.path.startsWith("/public")
      ? { origin: "*" }
      : { origin: [APP], credentials: true, maxAge: 60 },
  );
};

const adapter = new BunHttpAdapter();
adapter.enableCors(delegate);
adapter.get("/public/status", (_req, res) => {
  res.json({ ok: true });
});
adapter.get("/account", (_req, res) => {
  res.json({ user: "ada" });
});

show(
  "public route, any origin",
  corsView(
    await adapter.fetch("/public/status", { headers: { Origin: EVIL } }),
  ),
);
show(
  "private route, the app",
  corsView(await adapter.fetch("/account", { headers: { Origin: APP } })),
);
show(
  "private route, elsewhere",
  corsView(await adapter.fetch("/account", { headers: { Origin: EVIL } })),
);
show(
  "private route preflight — enableCors also answers OPTIONS on every path",
  corsView(
    await adapter.fetch("/account", {
      method: "OPTIONS",
      headers: { Origin: APP, "Access-Control-Request-Method": "DELETE" },
    }),
  ),
);
const banned = await adapter.fetch("/account", {
  headers: { Origin: "https://banned.example.test" },
});
show("the delegate called back with an error → not served", banned.status);
