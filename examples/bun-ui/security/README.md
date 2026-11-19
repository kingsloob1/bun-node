# `@kingsleyweb/bun-ui/security` examples

Runnable examples for the security UI of
[`@kingsleyweb/bun-ui`](../../../packages/bun-ui/guides/security.md): the
management UI and analytics page for
[`@kingsleyweb/bun-security`](../../../packages/bun-security)'s control plane.

Each file is a script that checks what it shows with
[`../jobs/shared/check.ts`](../jobs/shared/check.ts), so a wrong answer fails
it.

```bash
cd examples/bun-ui/security
bun 01-screens/permissions.ts   # what each element needs, checked
bun 02-mount/beside-the-api.ts  # securityUi() beside createSecurityApi(), over HTTP
bun 02-mount/mount-tags.ts      # securityUiMountTags() and the mount module, over HTTP
bun run-all.ts                  # every example; prints ok / FAIL
```

No install step: the packages resolve from the repo's root `node_modules`,
and the memory store keeps everything in the process.

| Example | What it shows |
|---|---|
| [`01-screens/permissions.ts`](./01-screens/permissions.ts) | The guide's table "What each element needs", parsed and checked: every row has a gate, every permission it names is one the API checks, the nav gates as it says, and each element that makes one call is refused by the API without its permission (and taken with it), with negative controls for each kind of drift |
| [`02-mount/beside-the-api.ts`](./02-mount/beside-the-api.ts) | `securityUi()` beside `createSecurityApi()` on one adapter, over a real socket: the shell for a client route (never cached, `nosniff`, no referrer), its nonce CSP (`default-src 'self'`, the page's nonce on `script-src`, files-only `style-src`, `frame-ancestors 'none'`, a fresh nonce per page), the configuration it carries (`apiBase`, the documents and the live stream, read from the API), the hashed module and stylesheet with their SRI digests and a year's caching, and the API reached through the configuration (`/meta` as an operator and `401` signed out, the OpenAPI document, the live stream's server-sent events) |
| [`02-mount/mount-tags.ts`](./02-mount/mount-tags.ts) | Mounting the UI in a page of your own, from its router, with no browser: `securityUiMountTags()` (the hashed module and stylesheet with SRI, the `<link>`s with a nonce), the module and the scoped stylesheet served with their digests, the unhashed `/mount.js` (re-exporting the hashed module, an ETag and a `304`) and `/mount.css`, and the UI's own page linking none of it |
