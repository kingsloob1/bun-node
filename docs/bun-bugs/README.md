# Bun bugs bun-node works around

Each entry is Bun behaviour that differs from a standard or from what
bun-node needs, with a minimal reproduction that uses no bun-node code. A
reproduction exits **1 while the behaviour is present and 0 once it is
fixed**, so re-running them after a Bun upgrade (`bun docs/bun-bugs/<file>.ts`)
says which workaround can go. Each report names the code that works around
it and the test that guards it.

| Report | Bun | Upstream | Worked around in |
|---|---|---|---|
| [`bun --hot` misses an atomic save of an entry file outside the working directory](./hot-misses-rename-outside-cwd.md) | 1.4.4-canary.1 | [#47787](https://github.com/oven-sh/bun/issues/47787) | bun-common's `hotChild.ts` test helper and README |
| [A served HEAD response loses the implicit `Content-Type` its GET gets](./head-response-loses-implicit-content-type.md) | 1.4.2 | [#46337](https://github.com/oven-sh/bun/issues/46337) | `BunResponse` `#respondToHead` |
| [`new Response(string).headers` has no `Content-Type`](./response-headers-miss-body-content-type.md) | 1.4.2 | not filed | `toFetchResponse` (socket-free `fetch()`) |
| [`console.log` / `Bun.inspect` print an object's non-enumerable properties](./inspect-shows-non-enumerable-properties.md) | 1.4.2 | not filed | `defineHidden` (`err.req`), partially: Errors only |
| [`JSON.stringify` on a deeply nested array takes 0.8–1.5 s past ~30,000 levels](./json-stringify-deep-nesting-slow.md) | 1.4.3, 1.4.4-canary.1 | [#45791](https://github.com/oven-sh/bun/issues/45791) | bun-nest's WebSocket serialisation tests' deadlines |
| [`idleTimeout` from 1 to 4 cuts an actively streaming response at 4 s](./idle-timeout-cuts-active-stream.md) | 1.4.2, 1.4.3, 1.4.4-canary.1 | [#46211](https://github.com/oven-sh/bun/issues/46211) | documented only: bun-common's README and `server` option JSDoc |
| [`Bun.gunzipSync` decodes only a gzip payload's first member, and ignores what follows](./gunzip-sync-reads-first-member-only.md) | 1.4.2, 1.4.3, 1.4.4-canary.1 | [#47341](https://github.com/oven-sh/bun/issues/47341) | bun-cache's `decodeNative` (`lib/core/decompress.ts`) |
| [`Bun.zstdDecompressSync` ignores a declared `Frame_Content_Size` above 16 MiB, and allocates the whole content before failing](./zstd-declared-size-over-16mib.md) | 1.4.2, 1.4.3, 1.4.4-canary.1 | [#48215](https://github.com/oven-sh/bun/issues/48215) (no-size case: [#28162](https://github.com/oven-sh/bun/issues/28162)) | bun-cache's `nativeBound` and `NATIVE_LIMIT` (`lib/core/decompress.ts`) |
| [A `Blob` appended to `FormData` without a name is sent as `filename=""`](./formdata-blob-empty-filename.md) | 1.4.4-canary.1 | [#35439](https://github.com/oven-sh/bun/issues/35439) (not ours) | bun-client's `asFile` (`lib/bodies.ts`) |
| [A `node:net` write after the peer closed emits no `'error'`, so the `mongodb` driver can hang](./node-net-write-after-peer-close-no-error.md) | 1.4.4-canary.1 | [#47834](https://github.com/oven-sh/bun/issues/47834) | documented only: bun-jobs' README, "High availability" (MongoDB's `timeoutMS`) |
| [`Bun.semver.satisfies` answers `true` for a string that is not a range](./semver-satisfies-non-range.md) | 1.4.4-canary.1 | [#47908](https://github.com/oven-sh/bun/issues/47908) | `scripts/publish.ts`'s tag and version checks |
| [`bun install` resolves a `file:` dependency's devDependencies, so `catalog:` and `workspace:` there fail outside the workspace](./file-dependency-resolves-dev-dependencies.md) | 1.4.4-canary.1 | [#22879](https://github.com/oven-sh/bun/issues/22879) (feature request; our case [commented](https://github.com/oven-sh/bun/issues/22879#issuecomment-6712639232)) | documented only: CLAUDE.md, the compute-provider template (frozen installs) |

Found earlier, while planning native routes, and filed upstream; their
reproductions live with that plan's evidence
([`docs/plans/bun-native-routes/evidence/bun-repros/`](../plans/bun-native-routes/evidence/bun-repros/),
discussed in [§14 of the plan](../plans/bun-native-routes/README.md#14-bun-behaviour-worth-reporting-upstream)):

| Report | Bun | Upstream |
|---|---|---|
| `routes` matches the raw request target while `req.url` is normalised | 1.4.3-canary.1 | [oven-sh/bun#44176](https://github.com/oven-sh/bun/issues/44176) |
| `routes` build time is quadratic, lookup linear, in sibling count | 1.4.3-canary.1 | [oven-sh/bun#44177](https://github.com/oven-sh/bun/issues/44177) |
| `/mid/:a-:b` is accepted and reports `{ b: "1-2" }` | 1.4.3-canary.1 | [comment on oven-sh/bun#41363](https://github.com/oven-sh/bun/issues/41363#issuecomment-5880415977) |

## Adding one

1. A `<slug>.ts` reproduction: Bun only, prints `Bun.version` and
   `Bun.revision`, prints what it saw, exits 1 while the bug is present.
2. A `<slug>.md` report: the table at the top (Bun version, upstream status,
   reproduction, where it is worked around), what happens, why it is a bug
   (the standard or contract it breaks), and what to remove once it is fixed.
3. A row in the table above.
