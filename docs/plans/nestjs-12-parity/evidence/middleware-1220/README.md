# Middleware under a global prefix, and `exclude()`, on 11.2.7, 12.1.3 and 12.2.0

Measured on 2026-10-21, develop at `1a40550e`, Bun 1.4.4-canary.1
(`6bb5dc195`), to check two claims made for the 12.2.0 lock move (#446) and
the bun-nest README's NestJS 12 section (#467). Each case is a whole Nest app
(`NestFactory.create`, `setGlobalPrefix("api")`, `listen(0)`, real `fetch`)
booted once on `@nestjs/platform-express` and once on `BunHttpAdapter`, with
a middleware that counts its runs. A cell is `runs (status)`.

[`measure.ts`](measure.ts) is the script, and `out-<version>.md` its output
on each Nest:

| File | `@nestjs/core` | Express |
|---|---|---|
| [`out-11.2.7.md`](out-11.2.7.md) | 11.2.7 | 5.2.1 |
| [`out-12.1.3.md`](out-12.1.3.md) | 12.1.3 | 5.2.1 |
| [`out-12.2.0.md`](out-12.2.0.md) | 12.2.0 (develop's lock) | 5.3.0 |

## What it shows

Both adapters gave the same count in every cell but one (11.2.7, bare
`/api`: Express 0, ours 1, a listed known difference).

- **`forRoutes("*")` under the prefix runs once on `/api/` on all three.**
  What 12.2.0 changes is the core's exact entry `/api$` registered alone
  (case 2): it serves `/api/` on 12.2.0 only (0 → 1, both adapters). In an
  app the wildcard entry `/api/{*path}` also matches `/api/`; before 12.2.0
  the exact entry skips a trailing `/` (platform-express 12.1.3 and
  bun-nest's `useExactMiddleware`), and on 12.2.0 the core's per-request
  guard keeps it to one run.
- **`exclude("users/login")` skips `/api/users/LOGIN` and `/api/users/login/`
  on all three**, through the core's own matching before 12.2.0
  (path-to-regexp's defaults: case-insensitive, optional trailing slash).
  What 12.2.0 changes, through `getRouteMatchingOptions()`:
  - `/api/invoices/` under `exclude("invoices/{*path}")`: skipped (0) on
    11.2.7 and 12.1.3, runs (1) on 12.2.0;
  - with a case-sensitive router (`router: { caseSensitive: true }`;
    Express `case sensitive routing`), `/api/users/LOGIN`: skipped on 11.2.7
    and 12.1.3, runs on 12.2.0.
- Case 5 (`setGlobalPrefix("api", { exclude: ["/"] })`): once everywhere; it
  found no app in which a middleware ran twice before 12.2.0.

## Re-run

```bash
# copies pinned to the other two Nest versions (outside any dot directory)
bun scripts/nest-matrix.ts --prepare 11.2.7 12.1.3 --dir ~/bun-node-nest-matrix-claims --fresh

# from each tree's packages/bun-nest, so its tsconfig and node_modules apply
E=docs/plans/nestjs-12-parity/evidence/middleware-1220
for v in 11.2.7 12.1.3; do
  (cd ~/bun-node-nest-matrix-claims/$v/packages/bun-nest &&
    bun "$OLDPWD/$E/measure.ts" ~/bun-node-nest-matrix-claims/$v)
done
(cd packages/bun-nest && bun "../../$E/measure.ts" "$PWD/../..")   # 12.2.0
```

Run the loop from the repo root. The script resolves every `@nestjs/*`
package and bun-nest's `lib/` from the tree it is given, applies the
decorators by hand (no tsconfig needed) and takes about two seconds per
version.
