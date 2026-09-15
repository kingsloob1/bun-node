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
 * - Cookies are parsed while the request is built, before any middleware
 *   runs. The adapter's `request: { cookieSecret }` option makes that parse
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
  BunRouter,
  cookieParser,
  parseCookie,
  signCookie,
  unsignCookie,
} from "@kingsleyweb/bun-common";
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
step("cookieSecret: verified while the request is built, as cookieParser()");

const app = new BunHttpAdapter(0, {
  // Newest first: "new secret" signs; SECRET still verifies (rotation).
  request: { cookieSecret: ["new secret", SECRET] },
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
