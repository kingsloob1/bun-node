/**
 * Mounting the security UI in a page of your own, from its router, checked
 * over HTTP with no browser: what `securityUiMountTags()` gives the page,
 * the hashed module and stylesheet it names, and the router's unhashed
 * `/mount.js` and `/mount.css`.
 *
 * ```bash
 * bun 02-mount/mount-tags.ts
 * ```
 *
 * - **`securityUiMountTags(ui)`** waits for the bundle and answers the
 *   mount stylesheets and the mount module by their hashed URLs under
 *   `<basePath>/assets/`, each with its SRI digest, and the `<link>`s for
 *   the page's `<head>` (the stylesheets and a `modulepreload`). The page's
 *   script then imports `mountSecurityUi` from `tags.module.href`.
 * - **The hashed files** are cached for a year, like the rest of the bundle;
 *   the mount stylesheet is scoped to the UI's root (`[data-bun-ui=
 *   "security"]`, after a guard rule), so it styles nothing of the page's.
 * - **`<basePath>/mount.js` and `/mount.css`** are unhashed aliases,
 *   revalidated on every load (an ETag), for a page that cannot know the
 *   hash: `/mount.js` re-exports the hashed module.
 * - The UI's own page never links the mount files.
 * - A bundling host imports `@kingsleyweb/bun-ui/security/mount` and its
 *   `mount.css` instead, from the package.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { ASSET_CACHE_CONTROL } from "@kingsleyweb/bun-ui";
import { securityUi, securityUiMountTags } from "@kingsleyweb/bun-ui/security";
import { check, checkEqual, summary } from "../../jobs/shared/check";
import { show, step, title } from "../../jobs/shared/console";

title("securityUiMountTags() and the mount module, over HTTP");

const api = createSecurityApi({
  store: memoryStore(),
  authenticate: () => ({ id: "alice", name: "Alice" }),
  owners: ["alice"],
  allowWithoutStepUp: true,
  signing: {
    keyId: "sk_example",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  },
  audit: {
    signing: {
      keyId: "ak_example",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    allowNoExternalCheckpoints: true,
  },
  bans: { secret: "fleet-keying-secret-for-the-example-0123456789" },
  logger: () => {},
});
const ui = securityUi({ api, basePath: "/admin/security", logger: () => {} });
const app = new BunHttpAdapter(0, { logger: () => {} });
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
const server = await app.listen(0, "127.0.0.1");
const origin = `http://127.0.0.1:${server.port}`;

/** The SRI digest of `bytes`, as the tags carry it. */
const sri = (bytes: Uint8Array) =>
  `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/* ------------------------------------------------------------------ */
step("what the page includes");

const tags = await securityUiMountTags(ui, { nonce: "a-host-nonce" });
show("tags.html", tags.html);
check(
  "the module, under basePath's assets",
  /^\/admin\/security\/assets\/mount-[a-z0-9]+\.js$/.test(tags.module.href),
  tags.module,
);
checkEqual("one stylesheet (no custom theme)", tags.stylesheets.length, 1);
check(
  "a stylesheet link and a modulepreload, each with SRI and the nonce",
  tags.html.includes(
    `<link rel="stylesheet" href="${tags.stylesheets[0].href}" integrity="${tags.stylesheets[0].integrity}"`,
  ) &&
    tags.html.includes(
      `<link rel="modulepreload" href="${tags.module.href}" integrity="${tags.module.integrity}"`,
    ) &&
    tags.html.split('nonce="a-host-nonce"').length === 3,
  tags.html,
);

/* ------------------------------------------------------------------ */
step("the files it names, served by the UI's router");

const module = await fetch(`${origin}${tags.module.href}`);
const moduleBytes = new Uint8Array(await module.arrayBuffer());
checkEqual(
  "the module: JavaScript, cached for a year, its digest the tag's",
  [
    module.status,
    module.headers.get("content-type"),
    module.headers.get("cache-control"),
    sri(moduleBytes),
  ],
  [
    200,
    "text/javascript; charset=utf-8",
    ASSET_CACHE_CONTROL,
    tags.module.integrity,
  ],
);
check(
  "it exports mountSecurityUi",
  new TextDecoder().decode(moduleBytes).includes("mountSecurityUi"),
);
const sheet = await fetch(`${origin}${tags.stylesheets[0].href}`);
const css = await sheet.text();
checkEqual(
  "the stylesheet: its digest the tag's",
  sri(new TextEncoder().encode(css)),
  tags.stylesheets[0].integrity,
);
check(
  "scoped to the UI's root, after the guard",
  css.startsWith('[data-bun-ui="security"]{all:initial;display:block}'),
  css.slice(0, 120),
);
check(
  "nothing in it for the page's own <html> or <body>",
  !/(?:^|[},])\s*(?:html|body|:root)\s*[{,]/.test(css),
);

/* ------------------------------------------------------------------ */
step("the unhashed aliases, for a page that cannot know the hash");

const alias = await fetch(`${origin}/admin/security/mount.js`);
const aliasText = await alias.text();
show("/mount.js", aliasText);
checkEqual(
  "it re-exports the hashed module, revalidated every time",
  [aliasText, alias.headers.get("cache-control")],
  [
    `export * from "./assets/${tags.module.href.split("/").pop()}";\n`,
    "no-cache",
  ],
);
const etag = alias.headers.get("etag")!;
checkEqual(
  "unchanged: 304",
  (
    await fetch(`${origin}/admin/security/mount.js`, {
      headers: { "if-none-match": etag },
    })
  ).status,
  304,
);
checkEqual(
  "/mount.css is the scoped stylesheet",
  await (await fetch(`${origin}/admin/security/mount.css`)).text(),
  css,
);

/* ------------------------------------------------------------------ */
step("the UI's own page links none of it");

const page = await (await fetch(`${origin}/admin/security`)).text();
check("no mount file in the shell", !page.includes("mount-"), page);

api.close();
await app.close();
summary();
