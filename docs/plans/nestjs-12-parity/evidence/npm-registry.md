# NestJS 12 on the npm registry

Read from the npm registry on **2026-10-15** with `npm view` (primary source
for versions, dates, peer ranges, engines and module format). Every row is
**[V]**: read, not inferred.

## Status: released, stable, on its fourth patch of the second minor

`npm view @nestjs/core dist-tags` (the same tags on `@nestjs/common`,
`platform-express`, `websockets`, `platform-ws` and `testing`):

| Tag | Version |
|---|---|
| `latest` | **12.1.3** |
| `legacy` | **11.2.7** |
| `next` | 12.0.0-alpha.7 (stale: older than 12.0.0) |
| `old` | 10.4.19 |

`npm view @nestjs/core time` (UTC), the 11.1.27 → 12.1.3 window:

| Version | Published | | Version | Published |
|---|---|---|---|---|
| 11.1.27 (develop's devDeps) | 2026-06-15 | | 12.0.0-alpha.0 | 2026-03-05 |
| 11.1.28 | 2026-07-08 | | 12.0.0-alpha.7 | 2026-08-26 |
| 11.1.29 | 2026-08-10 | | **12.0.0** | **2026-08-27** |
| 11.2.0 | 2026-08-14 | | 12.0.1 | 2026-08-27 |
| 11.2.1 | 2026-08-14 | | 12.0.2 | 2026-09-14 |
| 11.2.2, 11.2.3 | 2026-08-25 | | 12.0.3 | 2026-09-15 |
| 11.2.4 | 2026-09-14 | | 12.0.4 | 2026-09-21 |
| 11.2.5 | 2026-09-15 | | 12.1.0 | 2026-09-23 |
| 11.2.6 | 2026-09-23 | | 12.1.1 | 2026-09-28 |
| 11.2.7 | 2026-09-30 | | 12.1.2 | 2026-09-30 |
| | | | **12.1.3** | **2026-10-12** |

The 11 line is still maintained in parallel (11.2.4–11.2.7 shipped after
12.0.0, the last two as security backports: multer 2.4.0, CVE-2026-88932).
`@nestjs/cli` latest is 12.0.8.

## What the 12.1.3 manifests declare

| Package | `type` | `exports` | `engines` | Peer dependencies | Notable dependencies |
|---|---|---|---|---|---|
| `@nestjs/core` | `module` | `.`, `./*`, `./*.js`, `./internal` | `node >= 20` | `@nestjs/common ^12.0.0`, `rxjs ^7.1.0`, `reflect-metadata ^0.1.12 \|\| ^0.2.0`; optional `@nestjs/websockets`, `@nestjs/microservices`, `@nestjs/platform-express` `^12.0.0` | `path-to-regexp 8.4.2` (same as 11.1.27), `uid`, `iterare`, `fast-safe-stringify`, `tslib` |
| `@nestjs/common` | `module` | `.`, `./*`, `./*.js`, `./internal` | — | `rxjs ^7.1.0`, `reflect-metadata ^0.1.12 \|\| ^0.2.0`; optional `class-validator >=0.13.2`, `class-transformer >=0.4.1` | **new:** `@standard-schema/spec 1.1.0`; `file-type 22.1.1` (21.3.4 in 11.1.27), `load-esm 1.0.3` |
| `@nestjs/platform-express` | `module` | `.`, `./*`, `./*.js` | — | `@nestjs/common`, `@nestjs/core` `^12.0.0` | `express 5.2.1` (same), `multer 2.4.0` (2.1.1 in 11.1.27), `cors 2.8.6`, `path-to-regexp 8.4.2` |
| `@nestjs/websockets` | `module` | `.`, `./*`, `./*.js`, `./internal` | — | `@nestjs/common`, `@nestjs/core` `^12.0.0`, `rxjs`, `reflect-metadata`; optional `@nestjs/platform-socket.io` | `object-hash 3.0.0`, `iterare` |
| `@nestjs/platform-ws` | `module` | | — | `@nestjs/common`, `@nestjs/websockets` `^12.0.0`, `rxjs` | `ws 8.22.0` |
| `@nestjs/testing` | `module` | | — | `@nestjs/common`, `@nestjs/core` `^12.0.0`; optional `platform-express`, `microservices` | |
| `@nestjs/platform-fastify` | `module` | | — | … `@fastify/static ^10.1.2`, `@fastify/multipart ^10.1.0` (optional) | `fastify 5.12.5`, `find-my-way 9.9.0`, `path-to-regexp 8.4.2` |

For comparison, 11.1.27 and 11.2.7: no `type` field (CommonJS), **no
`exports` map**, the same `engines` (`node >= 20`), the same `rxjs` and
`reflect-metadata` ranges, peers `^11.0.0`.

So the module format and the `exports` map are the structural change. The
runtime floor written in `engines` did not move; the migration guide's
Node 20.19+ / 22.12+ floor exists because CommonJS consumers need
`require(esm)` (docs.nestjs.com `content/migration.md`, "Node.js
requirements"), which does not concern Bun.

## The deep imports bun-nest uses, under the new `exports` map

bun-nest imports three deep paths (CLAUDE.md, "Packaging types"):
`@nestjs/core/adapters/http-adapter.js`,
`@nestjs/common/interfaces/external/cors-options.interface.js` and
`@nestjs/common/interfaces/index.js`. The `./*.js` key maps each to the same
file, and all three exist in 12.1.3 with their `.d.ts` beside them
(**[M]**: `ls` in the 12.1.3 install; `await import("@nestjs/core/adapters/http-adapter.js")`
under Bun returns `{ AbstractHttpAdapter }`). An extensionless deep import
(`@nestjs/common/interfaces`) would now resolve to `./interfaces.js`, which
does not exist: the `.js` spellings bun-nest already uses are the ones that
keep working.

Commands:

```bash
npm view @nestjs/core dist-tags --json
npm view @nestjs/core time --json
npm view @nestjs/<pkg>@12.1.3 engines peerDependencies dependencies peerDependenciesMeta type exports --json
npm view @nestjs/<pkg>@11.1.27 engines dependencies type --json   # and @11.2.7
```
