/**
 * Option tour: every `CorsOptions` field and `CorsOptionsDelegate`, each
 * asserted — on simple requests and on preflights.
 *
 * ```bash
 * bun 12-options/cors-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Any `OPTIONS` request is a preflight, with or without an `Origin` header.
 * - `Allow-Origin`, `Allow-Credentials` and `Expose-Headers` go on every
 *   response; `Allow-Methods`, `Allow-Headers` and `Max-Age` only on a
 *   preflight.
 * - A string `origin` is sent as it is; `true`, a RegExp or an array reflect
 *   the request's own origin when it is allowed. A function answers with any
 *   of those, applied the same way.
 * - `cors(delegate)` chooses the options per request; an error it reports goes
 *   to `next(err)`, as in the `cors` package.
 * - Each check builds a small router: `cors(options)`, a `GET /items` and an
 *   `OPTIONS /items` that mark the response `X-Route: ran`, and an error
 *   handler answering 500.
 */
import type {
  BunRequest,
  CorsOptions,
  CorsOptionsDelegate,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import type { CorsStaticOrigin } from "@kingsleyweb/bun-common/lib/cors";
import { BunHttpAdapter, BunRouter, cors } from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Option tour: CorsOptions");

const APP = "https://app.example.test";
const OTHER = "https://other.example.test";

/** A router with `cors(options)` in front of `GET` and `OPTIONS /items`. */
function api(
  options?: CorsOptions | CorsOptionsDelegate<BunRequest>,
): BunRouter {
  const router = new BunRouter();
  router.use(cors(options));
  router.get("/items", (_req, res) => {
    res.setHeader("X-Route", "ran");
    res.json({ ok: true });
  });
  router.options("/items", (_req, res) => {
    res.setHeader("X-Route", "ran");
    res.status(200).send("route");
  });
  router.use(((error, _req, res, _next) => {
    res.status(500).json({ error: (error as Error).message });
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/** A simple `GET /items`, from `origin` when given. */
async function get(
  options: CorsOptions | CorsOptionsDelegate<BunRequest> | undefined,
  origin?: string,
): Promise<Response> {
  return api(options).fetch("/items", {
    headers: origin ? { Origin: origin } : {},
  });
}

/** A preflight for `/items`, with optional request headers. */
async function preflight(
  options: CorsOptions | undefined,
  headers: Record<string, string> = {
    Origin: APP,
    "Access-Control-Request-Method": "PUT",
  },
): Promise<Response> {
  return api(options).fetch("/items", { method: "OPTIONS", headers });
}

/** A response header, or null. */
function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

/* ------------------------------------------------------------------ */
step("Defaults on a simple request");

const plain = await get(undefined, APP);
checkEqual(
  "Allow-Origin is *",
  header(plain, "access-control-allow-origin"),
  "*",
);
check(
  "Vary includes Origin",
  (header(plain, "vary") ?? "").includes("Origin"),
  header(plain, "vary"),
);
checkEqual(
  "no Allow-Credentials",
  header(plain, "access-control-allow-credentials"),
  null,
);
checkEqual(
  "no Expose-Headers",
  header(plain, "access-control-expose-headers"),
  null,
);
checkEqual(
  "no preflight headers",
  [
    header(plain, "access-control-allow-methods"),
    header(plain, "access-control-allow-headers"),
    header(plain, "access-control-max-age"),
  ],
  [null, null, null],
);
checkEqual(
  "the route ran",
  [plain.status, header(plain, "x-route")],
  [200, "ran"],
);

/* ------------------------------------------------------------------ */
step("Defaults on a preflight");

const flight = await preflight(undefined, {
  Origin: APP,
  "Access-Control-Request-Method": "PUT",
  "Access-Control-Request-Headers": "content-type,x-request-id",
});
checkEqual("optionsSuccessStatus defaults to 204", flight.status, 204);
checkEqual(
  "methods default",
  header(flight, "access-control-allow-methods"),
  "GET,HEAD,PUT,PATCH,POST,DELETE",
);
checkEqual(
  "allowedHeaders unset: the requested headers are reflected",
  header(flight, "access-control-allow-headers"),
  "content-type,x-request-id",
);
check(
  "…and Vary includes Access-Control-Request-Headers",
  (header(flight, "vary") ?? "").includes("Access-Control-Request-Headers"),
  header(flight, "vary"),
);
checkEqual("no Max-Age", header(flight, "access-control-max-age"), null);
checkEqual("the route did not run", header(flight, "x-route"), null);
checkEqual("an empty body", await flight.text(), "");

const bare = await preflight(undefined, { Origin: APP });
checkEqual(
  "nothing requested, nothing reflected",
  header(bare, "access-control-allow-headers"),
  null,
);
const originless = await preflight(undefined, {});
checkEqual(
  "an OPTIONS without Origin is still a preflight",
  [originless.status, header(originless, "access-control-allow-methods")],
  [204, "GET,HEAD,PUT,PATCH,POST,DELETE"],
);

/* ------------------------------------------------------------------ */
step("origin");

checkEqual(
  "string: sent for its own origin",
  header(await get({ origin: APP }, APP), "access-control-allow-origin"),
  APP,
);
checkEqual(
  "string: sent as it is for any other origin too",
  header(await get({ origin: APP }, OTHER), "access-control-allow-origin"),
  APP,
);
checkEqual(
  "'*' as a string",
  header(await get({ origin: "*" }, OTHER), "access-control-allow-origin"),
  "*",
);
checkEqual(
  "true: reflects the origin",
  header(await get({ origin: true }, OTHER), "access-control-allow-origin"),
  OTHER,
);
checkEqual(
  "true without an Origin: *",
  header(await get({ origin: true }), "access-control-allow-origin"),
  "*",
);
const disabled = await get({ origin: false }, APP);
checkEqual(
  "false: no Allow-Origin, but the route still runs",
  [
    header(disabled, "access-control-allow-origin"),
    header(disabled, "x-route"),
  ],
  [null, "ran"],
);
checkEqual(
  "RegExp: a match is reflected",
  header(
    await get({ origin: /\.example\.test$/ }, OTHER),
    "access-control-allow-origin",
  ),
  OTHER,
);
checkEqual(
  "RegExp: no match, no header",
  header(
    await get({ origin: /\.example\.test$/ }, "https://example.org"),
    "access-control-allow-origin",
  ),
  null,
);
checkEqual(
  "RegExp: no Origin, no header",
  header(await get({ origin: /./ }), "access-control-allow-origin"),
  null,
);
const mixed: CorsOptions = { origin: [APP, /^http:\/\/localhost:\d+$/] };
checkEqual(
  "array: a listed string",
  header(await get(mixed, APP), "access-control-allow-origin"),
  APP,
);
checkEqual(
  "array: a listed RegExp",
  header(
    await get(mixed, "http://localhost:5173"),
    "access-control-allow-origin",
  ),
  "http://localhost:5173",
);
checkEqual(
  "array: anything else",
  header(await get(mixed, OTHER), "access-control-allow-origin"),
  null,
);
checkEqual(
  "array containing '*': anything",
  header(await get({ origin: ["*"] }, OTHER), "access-control-allow-origin"),
  OTHER,
);

const seenOrigins: (string | undefined)[] = [];
const decide: CorsOptions = {
  origin: (origin, callback) => {
    seenOrigins.push(origin);
    if (origin === "https://broken.example.test") {
      callback(new Error("lookup failed"));
      return;
    }
    setTimeout(() => {
      callback(null, origin === APP);
    }, 1);
  },
};
checkEqual(
  "function: allowed is reflected",
  header(await get(decide, APP), "access-control-allow-origin"),
  APP,
);
checkEqual(
  "function: refused has no header",
  header(await get(decide, OTHER), "access-control-allow-origin"),
  null,
);
await get(decide);
checkEqual("function: receives the origin, or undefined", seenOrigins, [
  APP,
  OTHER,
  undefined,
]);
const broken = await get(decide, "https://broken.example.test");
checkEqual(
  "function: an error goes to next(err)",
  [broken.status, await broken.json()],
  [500, { error: "lookup failed" }],
);
/** A function origin that answers `answer` after a tick. */
function answering(answer: CorsStaticOrigin): CorsOptions {
  return {
    origin: (_origin, callback) => {
      setTimeout(callback, 1, null, answer);
    },
  };
}
checkEqual(
  "function answering a string: sent as it is",
  header(await get(answering(APP), OTHER), "access-control-allow-origin"),
  APP,
);
checkEqual(
  "function answering a RegExp: a match is reflected",
  header(
    await get(answering(/\.example\.test$/), OTHER),
    "access-control-allow-origin",
  ),
  OTHER,
);
checkEqual(
  "function answering an array: applied like a static list",
  [
    header(
      await get(answering([APP, /^http:\/\/localhost:\d+$/]), APP),
      "access-control-allow-origin",
    ),
    header(
      await get(answering([APP, /^http:\/\/localhost:\d+$/]), OTHER),
      "access-control-allow-origin",
    ),
  ],
  [APP, null],
);
checkEqual(
  "function answering false: no header, the route still runs",
  await (async () => {
    const response = await get(answering(false), APP);
    return [
      header(response, "access-control-allow-origin"),
      header(response, "x-route"),
    ];
  })(),
  [null, "ran"],
);
checkEqual(
  "function allowing a request with no Origin: *",
  header(
    await get({ origin: (_origin, callback) => callback(null, true) }),
    "access-control-allow-origin",
  ),
  "*",
);

/* ------------------------------------------------------------------ */
step("methods");

checkEqual(
  "a string, as it is",
  header(
    await preflight({ methods: "GET,POST" }),
    "access-control-allow-methods",
  ),
  "GET,POST",
);
checkEqual(
  "an array, joined with commas",
  header(
    await preflight({ methods: ["GET", "PUT", "DELETE"] }),
    "access-control-allow-methods",
  ),
  "GET,PUT,DELETE",
);
checkEqual(
  "never on a simple request",
  header(await get({ methods: ["GET"] }, APP), "access-control-allow-methods"),
  null,
);

/* ------------------------------------------------------------------ */
step("allowedHeaders");

const requesting = {
  Origin: APP,
  "Access-Control-Request-Method": "PUT",
  "Access-Control-Request-Headers": "x-anything",
};
const listedHeaders = await preflight(
  { allowedHeaders: ["Content-Type", "Authorization"] },
  requesting,
);
checkEqual(
  "an array, joined — not the requested headers",
  header(listedHeaders, "access-control-allow-headers"),
  "Content-Type,Authorization",
);
check(
  "…and no Vary on Access-Control-Request-Headers",
  !(header(listedHeaders, "vary") ?? "").includes(
    "Access-Control-Request-Headers",
  ),
  header(listedHeaders, "vary"),
);
checkEqual(
  "a string, as it is",
  header(
    await preflight({ allowedHeaders: "Content-Type" }, requesting),
    "access-control-allow-headers",
  ),
  "Content-Type",
);
checkEqual(
  "an empty array falls back to reflecting",
  header(
    await preflight({ allowedHeaders: [] }, requesting),
    "access-control-allow-headers",
  ),
  "x-anything",
);

/* ------------------------------------------------------------------ */
step("exposedHeaders");

checkEqual(
  "an array, joined, on a simple request",
  header(
    await get({ exposedHeaders: ["X-Total", "ETag"] }, APP),
    "access-control-expose-headers",
  ),
  "X-Total,ETag",
);
checkEqual(
  "a string, on a preflight too",
  header(
    await preflight({ exposedHeaders: "X-Total" }),
    "access-control-expose-headers",
  ),
  "X-Total",
);
checkEqual(
  "an empty array sends nothing",
  header(
    await get({ exposedHeaders: [] }, APP),
    "access-control-expose-headers",
  ),
  null,
);

/* ------------------------------------------------------------------ */
step("credentials");

checkEqual(
  "true: on a simple request",
  header(
    await get({ credentials: true, origin: APP }, APP),
    "access-control-allow-credentials",
  ),
  "true",
);
checkEqual(
  "true: on a preflight",
  header(
    await preflight({ credentials: true, origin: APP }),
    "access-control-allow-credentials",
  ),
  "true",
);
checkEqual(
  "false: absent",
  header(
    await get({ credentials: false }, APP),
    "access-control-allow-credentials",
  ),
  null,
);

/* ------------------------------------------------------------------ */
step("maxAge");

checkEqual(
  "seconds, as a string",
  header(await preflight({ maxAge: 600 }), "access-control-max-age"),
  "600",
);
checkEqual(
  "0 is sent — it disables caching",
  header(await preflight({ maxAge: 0 }), "access-control-max-age"),
  "0",
);
checkEqual(
  "never on a simple request",
  header(await get({ maxAge: 600 }, APP), "access-control-max-age"),
  null,
);

/* ------------------------------------------------------------------ */
step("preflightContinue and optionsSuccessStatus");

const continued = await preflight({ preflightContinue: true, maxAge: 60 });
checkEqual(
  "preflightContinue: the OPTIONS route answers",
  [continued.status, header(continued, "x-route"), await continued.text()],
  [200, "ran", "route"],
);
checkEqual(
  "…with the preflight headers already set",
  [
    header(continued, "access-control-allow-methods"),
    header(continued, "access-control-max-age"),
  ],
  ["GET,HEAD,PUT,PATCH,POST,DELETE", "60"],
);
checkEqual(
  "optionsSuccessStatus: 200",
  (await preflight({ optionsSuccessStatus: 200 })).status,
  200,
);
checkEqual(
  "optionsSuccessStatus has no effect with preflightContinue",
  (await preflight({ optionsSuccessStatus: 299, preflightContinue: true }))
    .status,
  200,
);

/* ------------------------------------------------------------------ */
step("CorsOptionsDelegate via cors(delegate)");

const routerDelegate: CorsOptionsDelegate<BunRequest> = (req, callback) => {
  if (req.getHeader("Origin") === "https://banned.example.test") {
    callback(new Error("origin banned"));
    return;
  }
  setTimeout(callback, 1, null, { origin: [APP], credentials: true });
};
const chosen = await get(routerDelegate, APP);
checkEqual(
  "the options it answers are applied",
  [
    header(chosen, "access-control-allow-origin"),
    header(chosen, "access-control-allow-credentials"),
  ],
  [APP, "true"],
);
const delegateError = await get(routerDelegate, "https://banned.example.test");
checkEqual(
  "an error it reports goes to next(err)",
  [delegateError.status, await delegateError.json()],
  [500, { error: "origin banned" }],
);
const throwing = await get(() => {
  throw new Error("delegate threw");
}, APP);
checkEqual(
  "…as does a throw",
  [throwing.status, await throwing.json()],
  [500, { error: "delegate threw" }],
);

/* ------------------------------------------------------------------ */
step("CorsOptionsDelegate via BunHttpAdapter.enableCors");

const delegateSaw: string[] = [];
const delegate: CorsOptionsDelegate<BunRequest> = (req, callback) => {
  delegateSaw.push(req.path);
  if (req.path === "/banned") {
    callback(new Error("no"));
    return;
  }
  callback(
    null,
    req.path.startsWith("/public")
      ? { origin: "*" }
      : { origin: [APP], credentials: true },
  );
};

const adapter = new BunHttpAdapter();
adapter.enableCors(delegate);
adapter.get("/public/x", (_req, res) => {
  res.send("public");
});
adapter.get("/private", (_req, res) => {
  res.send("private");
});
adapter.get("/banned", (_req, res) => {
  res.send("unreachable");
});

const publicAnswer = await adapter.fetch("/public/x", {
  headers: { Origin: OTHER },
});
checkEqual(
  "options chosen per request: public",
  [
    header(publicAnswer, "access-control-allow-origin"),
    header(publicAnswer, "access-control-allow-credentials"),
  ],
  ["*", null],
);
const privateAnswer = await adapter.fetch("/private", {
  headers: { Origin: APP },
});
checkEqual(
  "options chosen per request: private",
  [
    header(privateAnswer, "access-control-allow-origin"),
    header(privateAnswer, "access-control-allow-credentials"),
  ],
  [APP, "true"],
);
checkEqual(
  "…refusing another origin",
  header(
    await adapter.fetch("/private", { headers: { Origin: OTHER } }),
    "access-control-allow-origin",
  ),
  null,
);
const adapterPreflight = await adapter.fetch("/private", {
  method: "OPTIONS",
  headers: { Origin: APP, "Access-Control-Request-Method": "DELETE" },
});
checkEqual(
  "enableCors answers preflights on every path",
  [
    adapterPreflight.status,
    header(adapterPreflight, "access-control-allow-origin"),
  ],
  [204, APP],
);
// enableCors wraps the delegate itself (BunHttpAdapter.ts), so how it reports a
// delegate error is the adapter's: asserted only as "the route did not run".
const bannedAnswer = await adapter.fetch("/banned", {
  headers: { Origin: APP },
});
check(
  "a delegate error stops the request",
  bannedAnswer.status >= 400 && (await bannedAnswer.text()) !== "unreachable",
  bannedAnswer.status,
);
check(
  "the delegate saw each request's path",
  delegateSaw.includes("/public/x") && delegateSaw.includes("/private"),
  delegateSaw,
);

const scoped = new BunHttpAdapter();
scoped.enableCors({ origin: APP }, "/api");
scoped.get("/api/items", (_req, res) => {
  res.send("api");
});
scoped.get("/home", (_req, res) => {
  res.send("home");
});
checkEqual(
  "enableCors(options, prefix): inside the prefix",
  header(
    await scoped.fetch("/api/items", { headers: { Origin: APP } }),
    "access-control-allow-origin",
  ),
  APP,
);
checkEqual(
  "…and not outside it",
  header(
    await scoped.fetch("/home", { headers: { Origin: APP } }),
    "access-control-allow-origin",
  ),
  null,
);

summary();
