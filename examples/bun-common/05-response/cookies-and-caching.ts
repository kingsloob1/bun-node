/**
 * Response cookies and caching — every `res.cookie()` option, signed and
 * JSON cookies, `clearCookie()`, `Cache-Control`, ETags and 304s.
 *
 * ```bash
 * bun 05-response/cookies-and-caching.ts
 * ```
 *
 * Worth knowing before reading it:
 *
 * - `maxAge` on `res.cookie()` is in **milliseconds** (Express's convenience);
 *   it becomes `Max-Age` in seconds plus a matching `Expires`.
 * - `Path` defaults to `/`, and Bun adds `SameSite=Lax` unless told otherwise.
 * - `signed: true` needs a secret: `opts.secret`, or `req.secret`.
 * - ETags are opt-in: `new BunHttpAdapter(timeout, { etag: true })`, or
 *   `res.setEtag()` per response.
 * - `send()` and `json()` set the automatic `ETag` first, then answer 304
 *   when the request is fresh against the response headers — so a client
 *   revalidating with the tag it was given gets a 304, as in Express.
 */
import { BunHttpAdapter, BunRouter, etag } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Response cookies and caching");

const router = new BunRouter();

/* ------------------------------------------------------------------ */
step("res.cookie(): every option");

router.get("/cookies", (req, res) => {
  req.secret = "request-level secret";
  res.cookie("plain", "value");
  res.cookie("everything", "on", {
    domain: "example.com",
    path: "/account",
    maxAge: 3_600_000,
    httpOnly: true,
    secure: true,
    partitioned: true,
    priority: "high",
    sameSite: "strict",
  });
  res.cookie("until", "a date", { expires: new Date(Date.UTC(2031, 0, 28)) });
  res.cookie("lax", "1", { sameSite: "lax" });
  res.cookie("cross-site", "1", { sameSite: "none", secure: true });
  res.cookie("strict-by-true", "1", { sameSite: true });
  res.cookie("json", { theme: "dark", fontSize: 14 });
  res.cookie("signed-with-req-secret", "user-42", { signed: true });
  res.cookie("signed-with-own-secret", "user-42", {
    signed: true,
    secret: "cookie secret",
  });
  res.clearCookie("old-session", { path: "/account" });
  // `res.get("Set-Cookie")` is an array of lines, as Node's `getHeader`:
  // joined, the comma in an `Expires` date would make them unsplittable.
  const lines = res.get("Set-Cookie") ?? [];
  res.send(`${lines.length} Set-Cookie lines, first: ${lines[0]}`);
});

const cookies = await router.fetch("/cookies");
for (const line of cookies.headers.getSetCookie()) {
  show("Set-Cookie", line);
}
show("res.get('Set-Cookie') in the handler", await cookies.text());

router.get("/unsigned-without-secret", (_req, res) => {
  try {
    res.cookie("session", "x", { signed: true });
    res.send("set");
  } catch (error) {
    res.status(500).send((error as Error).message);
  }
});
show(
  "signed: true with no secret anywhere",
  await (await router.fetch("/unsigned-without-secret")).text(),
);

/* ------------------------------------------------------------------ */
step("Cache-Control: set it like any header");

router.get("/static-asset", (_req, res) => {
  res
    .set("Cache-Control", "public, max-age=31536000, immutable")
    .send("body{}");
});
router.get("/private", (_req, res) => {
  res.set("Cache-Control", "no-store").json({ balance: 10 });
});

show(
  "asset",
  (await router.fetch("/static-asset")).headers.get("Cache-Control"),
);
show("private", (await router.fetch("/private")).headers.get("Cache-Control"));

/* ------------------------------------------------------------------ */
step("ETags: opt-in per adapter or per response");

const withEtags = new BunHttpAdapter(0, { etag: true });
withEtags.get("/doc", (_req, res) => {
  res.send("a document");
});
const withoutEtags = new BunHttpAdapter(0);
withoutEtags.get("/doc", (_req, res) => {
  res.send("a document");
});
withoutEtags.get("/doc/opted-in", (_req, res) => {
  res.setEtag().send("a document");
});

const tagged = await withEtags.fetch("/doc");
show("adapter { etag: true }", tagged.headers.get("ETag"));
show("default adapter", (await withoutEtags.fetch("/doc")).headers.get("ETag"));
show(
  "res.setEtag()",
  (await withoutEtags.fetch("/doc/opted-in")).headers.get("ETag"),
);
show("etag('a document') — the same tag", etag("a document"));

const revalidatedAuto = await withEtags.fetch("/doc", {
  headers: { "If-None-Match": tagged.headers.get("ETag") ?? "" },
});
show(
  "revalidating with only the automatic tag (304: the tag is set first)",
  revalidatedAuto.status,
);

/* ------------------------------------------------------------------ */
step(
  "304 Not Modified: ETag / If-None-Match, Last-Modified / If-Modified-Since",
);

const article = "the article body";
const articleTag = etag(article);
const publishedAt = new Date(Date.UTC(2031, 0, 1)).toUTCString();

router.get("/article", (_req, res) => {
  res
    .set("ETag", articleTag)
    .set("Last-Modified", publishedAt)
    .type("text/plain")
    .send(article);
});
router.post("/article", (_req, res) => {
  res.set("ETag", articleTag).send(article);
});

const cases: [string, RequestInit][] = [
  ["unconditional", {}],
  ["If-None-Match matches", { headers: { "If-None-Match": articleTag } }],
  [
    "If-None-Match is weak W/",
    { headers: { "If-None-Match": `W/${articleTag}` } },
  ],
  ["If-None-Match differs", { headers: { "If-None-Match": '"stale"' } }],
  [
    "If-Modified-Since later",
    {
      headers: {
        "If-Modified-Since": new Date(Date.UTC(2031, 5, 1)).toUTCString(),
      },
    },
  ],
  [
    "If-Modified-Since earlier",
    {
      headers: {
        "If-Modified-Since": new Date(Date.UTC(2030, 5, 1)).toUTCString(),
      },
    },
  ],
  [
    "Cache-Control: no-cache",
    { headers: { "If-None-Match": articleTag, "Cache-Control": "no-cache" } },
  ],
  [
    "POST is never fresh",
    { method: "POST", headers: { "If-None-Match": articleTag } },
  ],
];

for (const [label, init] of cases) {
  const response = await router.fetch("/article", init);
  show(label, {
    status: response.status,
    contentType: response.headers.get("Content-Type"),
    body: await response.text(),
  });
}

await withEtags.close();
await withoutEtags.close();
