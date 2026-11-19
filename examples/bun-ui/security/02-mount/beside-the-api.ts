/**
 * The security UI beside its control plane on one adapter, over HTTP: the
 * shell and its Content-Security-Policy, the hashed bundle with its SRI, and
 * the API the page reaches through the configuration the shell carries.
 *
 * ```bash
 * bun 02-mount/beside-the-api.ts
 * ```
 *
 * - **Two routers, two paths.** `createSecurityApi` answers at its
 *   `basePath`, `securityUi({ api })` at its own (it may not sit under the
 *   API's); `app.use()` each.
 * - **The shell** is one HTML page for every client route, never cached,
 *   under a strict nonce CSP: no inline script but the page's own module,
 *   no inline style, nothing from another origin.
 * - **The configuration** travels as a `<script type="application/json">`
 *   (`SECURITY_UI_CONFIG_ELEMENT_ID`): `apiBase`, the CSRF header, the API's
 *   documents and its live stream, all read from the API.
 * - **The bundle** is hashed (`/assets/<name>-<hash>.js`), cached for a
 *   year, and each file the shell links carries its SRI digest.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { ASSET_CACHE_CONTROL } from "@kingsleyweb/bun-ui";
import {
  SECURITY_UI_CONFIG_ELEMENT_ID,
  securityUi,
} from "@kingsleyweb/bun-ui/security";
import type { SecurityUiConfig } from "@kingsleyweb/bun-ui/security";
import { check, checkEqual, summary } from "../../jobs/shared/check";
import { show, step, title } from "../../jobs/shared/console";
import { cspDirectives } from "../../jobs/shared/shell";

title("securityUi() beside createSecurityApi(), over HTTP");

const api = createSecurityApi({
  store: memoryStore(),
  basePath: "/admin/security-api",
  // The host's sign-in: here an operator id in a header.
  authenticate: (req) => {
    const id = req.request.headers.get("x-op");
    return id === null ? null : { id, name: id };
  },
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

/* ------------------------------------------------------------------ */
step("the shell, for any client route under basePath");

const page = await fetch(`${origin}/admin/security/bans?scope=global`);
const html = await page.text();
checkEqual(
  "200, HTML",
  [page.status, page.headers.get("content-type")],
  [200, "text/html; charset=utf-8"],
);
checkEqual("never cached", page.headers.get("cache-control"), "no-store");
checkEqual(
  "no sniffing, no referrer",
  [
    page.headers.get("x-content-type-options"),
    page.headers.get("referrer-policy"),
  ],
  ["nosniff", "no-referrer"],
);

const raw = new RegExp(
  `<script type="application/json" id="${SECURITY_UI_CONFIG_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</script>`,
).exec(html)?.[1];
const config = JSON.parse(raw ?? "null") as SecurityUiConfig;
show("the configuration", config);
checkEqual(
  "the page carries exactly ui.config",
  config,
  JSON.parse(JSON.stringify(ui.config)),
);
checkEqual(
  "read from the API",
  [config.apiBase, config.docs.openapi, config.live.path],
  [
    "/admin/security-api",
    "/admin/security-api/openapi.json",
    "/admin/security-api/live",
  ],
);

/* ------------------------------------------------------------------ */
step("its Content-Security-Policy");

const csp = cspDirectives(page.headers.get("content-security-policy"));
show("directives", csp);
const nonce = /<script type="module"[^>]*nonce="([^"]+)"/.exec(html)?.[1];
checkEqual("default-src", csp["default-src"], ["'self'"]);
checkEqual("script-src: this origin and this page's nonce", csp["script-src"], [
  "'self'",
  `'nonce-${nonce}'`,
]);
checkEqual("style-src: files only", csp["style-src"], ["'self'"]);
check(
  "connect-src: this origin",
  csp["connect-src"]?.[0] === "'self'",
  csp["connect-src"],
);
checkEqual("frame-ancestors", csp["frame-ancestors"], ["'none'"]);
const second = await fetch(`${origin}/admin/security`);
const secondNonce = /'nonce-([^']+)'/.exec(
  second.headers.get("content-security-policy") ?? "",
)?.[1];
await second.body?.cancel();
check(
  "a fresh nonce per page",
  secondNonce !== undefined && secondNonce !== nonce,
);

/* ------------------------------------------------------------------ */
step("the bundle: hashed, cached for a year, SRI on each file");

const linked = [
  ...html.matchAll(/<(?:script type="module"|link rel="stylesheet")[^>]*>/g),
].map(([tag]) => ({
  href: /(?:src|href)="([^"]+)"/.exec(tag)![1],
  integrity: /integrity="([^"]+)"/.exec(tag)?.[1],
}));
show("linked", linked);
check("a module and a stylesheet at least", linked.length >= 2, linked);
for (const file of linked) {
  const response = await fetch(`${origin}${file.href}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  checkEqual(
    `${file.href.split("/").pop()}: 200, cached for a year, its digest the page's`,
    [response.status, response.headers.get("cache-control"), file.integrity],
    [200, ASSET_CACHE_CONTROL, digest],
  );
}

/* ------------------------------------------------------------------ */
step("the API, through what the configuration says");

const meta = await fetch(`${origin}${config.apiBase}/meta`, {
  headers: { "x-op": "alice" },
});
checkEqual("GET <apiBase>/meta as an operator", meta.status, 200);
show("meta", await meta.json());
checkEqual(
  "signed out: 401",
  (await fetch(`${origin}${config.apiBase}/meta`)).status,
  401,
);
const openapi = await fetch(`${origin}${config.docs.openapi}`, {
  headers: { "x-op": "alice" },
});
const reference = (await openapi.json()) as { openapi?: string };
checkEqual(
  "the API reference's document: OpenAPI 3.1",
  [openapi.status, reference.openapi?.startsWith("3.1.")],
  [200, true],
);
const controller = new AbortController();
const live = await fetch(`${origin}${config.live.path}`, {
  headers: { "x-op": "alice" },
  signal: controller.signal,
});
checkEqual(
  "the live stream: server-sent events",
  [live.status, live.headers.get("content-type")?.split(";")[0]],
  [200, "text/event-stream"],
);
controller.abort();
await live.body?.cancel().catch(() => {});

api.close();
await app.close();
summary();
