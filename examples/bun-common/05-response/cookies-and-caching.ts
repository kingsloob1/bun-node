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
 * - ETags are opt-in: `new BunHttpAdapter(timeout, { etag })`, or per
 *   response with `res.setEtag(option)` / `res.etag = option`, which
 *   overrules the adapter's for that response only. The option is `false`,
 *   `true` (strong), `"weak"`, `"strong"`, or a function of the body
 *   returning the tag (or `undefined` for none), as Express's `etag`
 *   setting; anything else is a `TypeError`. A hand-set `ETag` always wins,
 *   and `sendFile()` keeps its weak size+mtime tag whenever ETags are on.
 * - `send()` and `json()` set the automatic `ETag` first, then answer 304
 *   when the request is fresh against the response headers — so a client
 *   revalidating with the tag it was given gets a 304, as in Express.
 */
import type { EtagOption } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter, etag } from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
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
step("ETag modes: true, weak, strong, a function — and per response");

/** An adapter with the given `etag` and the same routes on each. */
function etagApp(option: EtagOption): BunHttpAdapter {
  const app = new BunHttpAdapter(0, { etag: option });
  app.get("/doc", (_req, res) => res.send("a document"));
  app.get("/untagged", (_req, res) => {
    res.setEtag(false); // this route only
    res.send("a document");
  });
  app.get("/weak", (_req, res) => {
    res.etag = "weak"; // the setter does the same as setEtag("weak")
    res.send("a document");
  });
  app.get("/hand-set", (_req, res) => {
    res.set("ETag", '"v42"').send("a document");
  });
  app.get("/file", async (_req, res) => {
    await res.sendFile(import.meta.path);
  });
  return app;
}

/** The ETag `path` gets on `app`. */
async function tagOf(app: BunHttpAdapter, path: string) {
  return (await app.fetch(path)).headers.get("ETag");
}

/** The strong tag `etag()` computes for the body every route sends. */
const strongTag = etag("a document");
const byLength = (body: string | Uint8Array) => `"len-${body.length}"`;
for (const [label, option, expected] of [
  ["true", true, strongTag],
  ['"strong"', "strong", strongTag],
  ['"weak"', "weak", `W/${strongTag}`],
  ["a function", byLength, '"len-10"'],
  ["false", false, null],
] as const) {
  const app = etagApp(option);
  checkEqual(`etag: ${label}`, await tagOf(app, "/doc"), expected);
  checkEqual(
    `etag: ${label} — setEtag(false) on one route: none`,
    await tagOf(app, "/untagged"),
    null,
  );
  checkEqual(
    `etag: ${label} — res.etag = "weak" on one route: weak`,
    await tagOf(app, "/weak"),
    `W/${strongTag}`,
  );
  checkEqual(
    `etag: ${label} — a hand-set ETag wins`,
    await tagOf(app, "/hand-set"),
    '"v42"',
  );
  const fileTag = await tagOf(app, "/file");
  check(
    `etag: ${label} — sendFile(): ${option === false ? "none" : "its weak size+mtime tag"}`,
    option === false ? fileTag === null : fileTag?.startsWith("W/") === true,
    fileTag,
  );
}

// 304 round-trips: the tag a client was given revalidates, weak or strong
// (If-None-Match compares weakly, as RFC 9110 says).
for (const option of ["strong", "weak", byLength] as const) {
  const app = etagApp(option);
  const given = (await tagOf(app, "/doc"))!;
  const label = typeof option === "function" ? "a function" : option;
  checkEqual(
    `${label}: If-None-Match with the tag it gave is a 304`,
    (await app.fetch("/doc", { headers: { "If-None-Match": given } })).status,
    304,
  );
}
const strongApp = etagApp("strong");
checkEqual(
  "a strong tag sent back as W/… still matches: 304",
  (
    await strongApp.fetch("/doc", {
      headers: { "If-None-Match": `W/${strongTag}` },
    })
  ).status,
  304,
);
checkEqual(
  "a different tag: 200 with the body",
  (await strongApp.fetch("/doc", { headers: { "If-None-Match": '"other"' } }))
    .status,
  200,
);

let constructorError: unknown;
try {
  // eslint-disable-next-line no-new
  new BunHttpAdapter(0, { etag: "medium" as unknown as EtagOption });
} catch (error) {
  constructorError = error;
}
check(
  "an invalid etag option is a TypeError at construction",
  constructorError instanceof TypeError,
  constructorError,
);
const setterApp = new BunHttpAdapter(0);
setterApp.get("/bad", (_req, res) => {
  try {
    res.etag = 1 as unknown as EtagOption;
    res.send("accepted");
  } catch (error) {
    res.send((error as Error).name);
  }
});
checkEqual(
  "…and from the res.etag setter",
  await (await setterApp.fetch("/bad")).text(),
  "TypeError",
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

summary();
