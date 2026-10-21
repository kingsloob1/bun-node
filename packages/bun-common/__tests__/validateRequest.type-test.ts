/**
 * Compile-time assertions for the request parts `validate()` types (plan
 * `docs/plans/bun-validate/` §4.3, V2): `cookies` and `signedCookies`
 * narrow `req.cookies` / `req.signedCookies`; every parsed part, headers
 * included, is typed on `req.valid`; headers stay raw on `req.headers`.
 * Runtime behaviour is in `bunValidate.request.test.ts`.
 *
 * Every `@ts-expect-error` sits on the line before the one that errors, so
 * a script stripping the directives can check each fires on its own line.
 */
import type { TypedRouteHandler } from "../lib/types/general";
import type { ResolvedHandler } from "../lib/types/routeTyping";
import type { JsonValue } from "../lib/utils/native";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunValidate, validate } from "../lib/BunValidate";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const HeaderSchema = z.object({
  "x-n": z.coerce.number(),
  authorization: z.string(),
});
const CookieSchema = z.object({
  n: z.coerce.number(),
  theme: z.enum(["dark", "light"]).optional(),
});
const SignedSchema = z.object({ sid: z.string() });
const PageSchema = z.object({ page: z.coerce.number() });

type Headers = z.output<typeof HeaderSchema>;
type Cookies = z.output<typeof CookieSchema>;
type Signed = z.output<typeof SignedSchema>;
type Page = z.output<typeof PageSchema>;

/** The untyped cookie view a request has with no cookie validator. */
type RawCookies = Record<string, JsonValue> | undefined;

const router = new BunRouter();

/* --- the new targets narrow req.cookies and req.signedCookies ---------- */

router.get(
  "/u/:id",
  validate({
    headers: HeaderSchema,
    cookies: CookieSchema,
    signedCookies: SignedSchema,
    query: PageSchema,
  }),
  (_req) => {
    type _c = Expect<Equal<typeof _req.cookies, Cookies>>;
    type _s = Expect<Equal<typeof _req.signedCookies, Signed>>;
    type _q = Expect<Equal<typeof _req.query, Page>>;
    // Every parsed part on req.valid; headers only there.
    type _v = Expect<
      Equal<
        typeof _req.valid,
        {
          headers: Headers;
          cookies: Cookies;
          signedCookies: Signed;
          query: Page;
        }
      >
    >;
    type _vh = Expect<Equal<(typeof _req.valid.headers)["x-n"], number>>;
    // req.headers stays the raw view.
    type _rh = Expect<
      Equal<typeof _req.headers, Record<string, string | string[]>>
    >;
    // The path still types the params nobody validated.
    type _p = Expect<Equal<typeof _req.params, { id: string }>>;

    // @ts-expect-error N1 an undeclared cookie
    void _req.cookies.nope;
    // @ts-expect-error N2 a declared cookie read as the wrong type
    const _n: string = _req.cookies.n;
    // @ts-expect-error N3 a typed header read as the wrong type
    const _xn: string = _req.valid.headers["x-n"];
    // @ts-expect-error N4 a header the schema does not declare, on the typed view
    void _req.valid.headers["x-other"];
    // @ts-expect-error N5 an undeclared signed cookie
    void _req.signedCookies.other;
    // @ts-expect-error N6 a part no validator parsed is not on req.valid
    void _req.valid.body;
  },
);

/* --- without a validator: the raw types, and an empty req.valid -------- */

router.get("/plain", (_req) => {
  type _c = Expect<Equal<typeof _req.cookies, RawCookies>>;
  type _s = Expect<Equal<typeof _req.signedCookies, RawCookies>>;
  type _v = Expect<Equal<typeof _req.valid, Record<never, never>>>;
  // @ts-expect-error N7 req.valid.headers with no validator
  void _req.valid.headers;
  // @ts-expect-error N8 the raw cookies may be undefined (parseCookies: false)
  void _req.cookies.theme;
});

/* --- a header validator alone types only req.valid --------------------- */

router.get("/h", validate({ headers: HeaderSchema }), (_req) => {
  type _v = Expect<Equal<typeof _req.valid, { headers: Headers }>>;
  type _c = Expect<Equal<typeof _req.cookies, RawCookies>>;
});

/* --- hooks: a cookie transform decides req.cookies and req.valid ------- */

router.get(
  "/t",
  validate(
    { cookies: CookieSchema, headers: HeaderSchema },
    {
      hooks: {
        cookies: {
          normalize: (value) => {
            type _raw = Expect<Equal<typeof value, Record<string, JsonValue>>>;
            return value;
          },
          transform: (value) => ({ ...value, dark: value.theme === "dark" }),
        },
        // Headers are never written back: their transform changes no type.
        headers: { transform: () => 42 },
      },
    },
  ),
  (_req) => {
    interface Transformed {
      n: number;
      theme?: "dark" | "light" | undefined;
      dark: boolean;
    }
    type _c = Expect<Equal<typeof _req.cookies, Transformed>>;
    type _vc = Expect<Equal<typeof _req.valid.cookies, Transformed>>;
    type _vh = Expect<Equal<typeof _req.valid.headers, Headers>>;
  },
);

/* --- replace: false types nothing, req.valid included (Q-H8: later) ---- */

router.get(
  "/raw",
  validate({ cookies: CookieSchema }, { replace: false }),
  (_req) => {
    type _c = Expect<Equal<typeof _req.cookies, RawCookies>>;
    type _v = Expect<Equal<typeof _req.valid, Record<never, never>>>;
  },
);

/* --- the class form infers the same shape ------------------------------- */

const _viaClass = new BunValidate({
  schemas: { signedCookies: SignedSchema },
}).middleware();
type _vc = Expect<
  Equal<NonNullable<(typeof _viaClass)["__shape"]>, { signedCookies: Signed }>
>;

/* --- a mount's validated cookies reach a sub-router's handler ---------- */

const orgs = new BunRouter<"/orgs/:org", { cookies: Cookies }>();
orgs.get("/x", validate({ headers: HeaderSchema }), (_req) => {
  type _c = Expect<Equal<typeof _req.cookies, Cookies>>;
  type _v = Expect<
    Equal<typeof _req.valid, { cookies: Cookies; headers: Headers }>
  >;
  type _p = Expect<Equal<typeof _req.params, { org: string }>>;
});
router.use("/orgs/:org", validate({ cookies: CookieSchema }), orgs);

/* --- the adapter's verbs are typed the same way ------------------------- */

const adapter = new BunHttpAdapter(0);
adapter.post(
  "/a",
  (_req, _res, next) => next(),
  validate({ signedCookies: SignedSchema }),
  (_req) => {
    type _s = Expect<Equal<typeof _req.signedCookies, Signed>>;
    type _v = Expect<Equal<typeof _req.valid, { signedCookies: Signed }>>;
  },
);

/* --- a wildcard's params are a string[], and a schema must accept one -- */

router.get(
  "/files/*path",
  validate({ params: z.object({ path: z.array(z.string()) }) }),
  (_req) => {
    type _p = Expect<Equal<typeof _req.params, { path: string[] }>>;
    type _vp = Expect<Equal<typeof _req.valid.params, { path: string[] }>>;
  },
);
router.get("/files/*path", (_req) => {
  type _p = Expect<Equal<typeof _req.params, { path: string[] }>>;
});

/* --- declared handlers ---------------------------------------------------- */

// A `ResolvedHandler` names the cookies and req.valid it gets, and follows
// an inline validator (the limit lifted with TypedRouteHandler's TReq).
const sessionHandler: ResolvedHandler<
  "/s",
  { signedCookies: Signed; headers: Headers }
> = (req, res) => {
  res.send(`${req.signedCookies.sid}:${req.valid.headers["x-n"]}`);
};
router.get(
  "/s",
  validate({ signedCookies: SignedSchema, headers: HeaderSchema }),
  sessionHandler,
);

// Negative control: a declared handler wanting a cookie the validator does
// not parse is refused.
const wrongCookies: ResolvedHandler<"/s", { cookies: { sid: number } }> = () =>
  undefined;
// @ts-expect-error N9 the validator's cookies have no numeric `sid`
router.get("/s", validate({ cookies: CookieSchema }), wrongCookies);

// L1, a limit (not a control): a handler typed as a bare TypedRouteHandler
// still loses TShape after an inline validator. Pinned so lifting it is noticed.
const bareHandler: TypedRouteHandler<{ id: string }, Page> = () => undefined;
// @ts-expect-error L1 an inline generic validator loses inference to TShape
router.get("/declared/:id", validate({ query: PageSchema }), bareHandler);

export {};
