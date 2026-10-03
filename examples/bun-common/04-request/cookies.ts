/**
 * Request cookies — plain, JSON and signed, with one secret or a rotation.
 *
 * ```bash
 * bun 04-request/cookies.ts
 * ```
 *
 * The cookies here are the ones a `BunResponse` actually sets: each section
 * sets cookies on one response and sends them back as the next request's
 * `Cookie` header, the way a browser would.
 *
 * Worth knowing before reading it:
 *
 * - Cookies are parsed on first touch — `req.cookies`, `req.signedCookies`
 *   or `req.parseCookies()` — with the options the request was built with,
 *   so a route that never reads them never parses them. Assigning either
 *   property replaces that half of the result. The adapter's
 *   `request: { parseCookies: { secret } }` option
 *   (`cookieSecret`, deprecated, still works) makes that parse
 *   verify signed cookies — `cookieParser(secret)` on every request — and
 *   sets `req.secret`, which `res.cookie(..., { signed: true })` signs with.
 * - Without it there is no secret at that point, and a signed cookie is
 *   still in `req.cookies` as its raw `s:…` string. Set `req.secret` in a
 *   middleware and call `req.parseCookies({ forceUpdateRequest: true })` to
 *   verify them.
 * - Without `forceUpdateRequest: true`, `parseCookies()` writes its result to
 *   `req.cookies` / `req.signedCookies` only when they were not parsed yet.
 * - A `j:`-prefixed value is JSON (what `res.cookie(name, object)` writes) and
 *   is expanded in both `cookies` and `signedCookies`.
 * - Once a secret is known, a signed cookie whose signature does not verify
 *   appears in `signedCookies` as `false` and is removed from `cookies`, as
 *   cookie-parser does.
 */
import {
  BunHttpAdapter,
  BunRequest,
  BunRouter,
  cookieParser,
  FETCH_STUB_SERVER,
  parseCookie,
  signCookie,
  unsignCookie,
} from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Request cookies");

/** Turns a response's Set-Cookie headers into a request Cookie header. */
function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

const router = new BunRouter();

/* ------------------------------------------------------------------ */
step("Plain and JSON cookies");

router.get("/login", (_req, res) => {
  res.cookie("theme", "dark");
  res.cookie("prefs", { lang: "en", beta: true });
  res.send("set");
});

router.get("/whoami", (req, res) => {
  res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
});

const plainJar = cookieHeaderFrom(await router.fetch("/login"));
show("Cookie header the client sends back", plainJar);
show(
  "req.cookies (prefs expanded from j:)",
  await (
    await router.fetch("/whoami", { headers: { Cookie: plainJar } })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("Signed cookies: set with a secret, verified with the same one");

const SECRET = "keyboard cat";

router.get("/signed/login", (req, res) => {
  req.secret = SECRET;
  res.cookie("session", "user-42", { signed: true, httpOnly: true });
  res.cookie("cart", { items: 3 }, { signed: true });
  res.send("set");
});

router.get("/signed/before", (req, res) => {
  // Parsed at construction, with no secret: still the raw strings.
  res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
});

router.get(
  "/signed/after",
  (req, _res, next) => {
    req.secret = SECRET;
    req.parseCookies({ forceUpdateRequest: true });
    next();
  },
  (req, res) => {
    res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
  },
);

const signedJar = cookieHeaderFrom(await router.fetch("/signed/login"));
show("Cookie header", signedJar);
show(
  "before verifying",
  await (
    await router.fetch("/signed/before", { headers: { Cookie: signedJar } })
  ).json(),
);
show(
  "after req.secret + parseCookies({ forceUpdateRequest: true })",
  await (
    await router.fetch("/signed/after", { headers: { Cookie: signedJar } })
  ).json(),
);

const tampered = signedJar.replace("user-42", "user-1");
show(
  "a tampered session is not verified",
  await (
    await router.fetch("/signed/after", { headers: { Cookie: tampered } })
  ).json(),
);

/* ------------------------------------------------------------------ */
step(
  "parseCookies: { secret }: verified while the request is built, as cookieParser()",
);

const app = new BunHttpAdapter(0, {
  // Newest first: "new secret" signs; SECRET still verifies (rotation).
  request: { parseCookies: { secret: ["new secret", SECRET] } },
});
app.get("/profile", (req, res) => {
  res.cookie("visited", "yes", { signed: true });
  res.json({
    reqSecret: req.secret,
    cookies: req.cookies,
    signedCookies: req.signedCookies,
  });
});

const profile = await app.fetch("/profile", { headers: { Cookie: signedJar } });
show("no middleware needed: signed with the old secret, verified", {
  ...((await profile.json()) as object),
  setCookie: profile.headers.getSetCookie()[0],
});
show(
  "a tampered session is false here too",
  await (await app.fetch("/profile", { headers: { Cookie: tampered } })).json(),
);

/* ------------------------------------------------------------------ */
step("Rotating secrets: newest first, older ones still verify");

router.get("/rotated", (req, res) => {
  // Returns the result; forceUpdateRequest also writes it onto the request.
  const parsed = req.parseCookies({
    secret: ["new secret", SECRET],
    forceUpdateRequest: true,
  });
  res.json({ parsed, reqSecret: req.secret });
});

show(
  "cookies signed with the old secret",
  await (
    await router.fetch("/rotated", { headers: { Cookie: signedJar } })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("The helpers underneath");

const signed = signCookie("user-42", SECRET);
show("signCookie", signed);
show("unsignCookie (right secret)", unsignCookie(signed, SECRET));
show("unsignCookie (wrong secret)", unsignCookie(signed, "nope"));

const parsed = parseCookie(`a=1; s=s:${signed}; j=j:{"x":1}`);
show("parseCookie", parsed);
const verified = cookieParser.signedCookies(parsed, [SECRET]);
show("cookieParser.signedCookies (removes verified entries from its input)", {
  verified,
  remaining: parsed,
});
show("cookieParser.JSONCookies", cookieParser.JSONCookies(parsed));

/* ------------------------------------------------------------------ */
step("Parsed on first touch, with the options the request was built with");

/** Every value the custom decoder was given. */
const decoded: string[] = [];
const lazy = new BunHttpAdapter(0, {
  request: {
    parseCookies: {
      decode: (value) => {
        decoded.push(value);
        if (value === "bad") {
          throw new Error("undecodable");
        }
        return value.toUpperCase();
      },
    },
  },
});
lazy.get("/reads", (req, res) => res.json(req.cookies));
lazy.get("/ignores", (_req, res) => res.send("cookies never read"));
await lazy.listen(0);

/** GETs `path` with `cookie`, served and through fetch(), as JSON or text. */
async function bothWays(path: string, cookie: string) {
  const init = { headers: { Cookie: cookie } };
  const served = await fetch(`${lazy.url}${path}`, init);
  const offline = await lazy.fetch(path, init);
  return [await served.text(), await offline.text()];
}

checkEqual(
  "a route that reads req.cookies: decoded, served and through fetch()",
  await bothWays("/reads", "a=x"),
  ['{"a":"X"}', '{"a":"X"}'],
);
decoded.length = 0;
checkEqual("a route that never reads them", await bothWays("/ignores", "a=x"), [
  "cookies never read",
  "cookies never read",
]);
checkEqual("…never ran the decoder", decoded, []);
checkEqual(
  "a decoder that throws keeps the raw value, both ways",
  await bothWays("/reads", "a=bad"),
  ['{"a":"bad"}', '{"a":"bad"}'],
);
await lazy.close();

const SIGNING = "touch secret";
const header = `plain=1; session=${encodeURIComponent(`s:${signCookie("user-7", SIGNING)}`)}`;
/** A request carrying `header`, built with `SIGNING` as its secret. */
function built(): BunRequest {
  return BunRequest.init(
    new Request("http://localhost/", { headers: { Cookie: header } }),
    FETCH_STUB_SERVER,
    { parseBody: true, parseCookies: { secret: SIGNING } },
  ) as BunRequest;
}

const assigned = built();
assigned.cookies = { replaced: "yes" };
checkEqual(
  "assigning req.cookies replaces that half; signedCookies is still parsed",
  [assigned.cookies, assigned.signedCookies],
  [{ replaced: "yes" }, { session: "user-7" }],
);
const assignedSigned = built();
assignedSigned.signedCookies = {};
checkEqual(
  "assigning req.signedCookies replaces that half; cookies is still parsed",
  [assignedSigned.cookies, assignedSigned.signedCookies],
  [{ plain: "1" }, {}],
);
const explicit = built();
const answer = explicit.parseCookies({ secret: "another secret" });
checkEqual(
  "parseCookies({ secret: other }) answers with that secret…",
  answer.signedCookies,
  { session: false },
);
checkEqual(
  "…but leaves the request's own cookies as its options parse them",
  [explicit.cookies, explicit.signedCookies],
  [{ plain: "1" }, { session: "user-7" }],
);

summary();
