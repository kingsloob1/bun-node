# Bundle and tarball sizes, 2026-11-08

Bytes, not speed. `develop` at `d0d53ee1`, Bun 1.4.4-canary.1+11c367163.

## The two builds today

Built with each package's own `scripts/build.ts` into a scratch directory
(`--out`), so the packages' `dist/` stayed absent. Sizes are apparent bytes
(`du -sb`); the file system compresses, so `du -sh` reads smaller.

| Build | JS + CSS (no maps) | gzipped | Source maps | All of `dist/` |
|---|---:|---:|---:|---:|
| bun-jobs-ui (`app/main.tsx`) | 907.1 KiB | 288.8 KiB | 3,901,505 B (3.72 MiB) | 4,847,825 B (4.62 MiB) |
| bun-api-docs-ui (`app/main.tsx`) | 371.6 KiB | 112.4 KiB | 1,598,190 B (1.52 MiB) | 1,979,412 B (1.89 MiB) |
| **both** | **1,278.7 KiB** | **401.2 KiB** | **5.24 MiB** | **6.51 MiB** |

Per file: [`build-bun-jobs-ui.txt`](build-bun-jobs-ui.txt),
[`build-bun-api-docs-ui.txt`](build-bun-api-docs-ui.txt).

```bash
cd packages/bun-jobs-ui && bun scripts/build.ts --out <scratch>/bun-jobs-ui
cd packages/bun-api-docs-ui && bun scripts/build.ts --out <scratch>/bun-api-docs-ui
du -sb <scratch>/*; find <scratch>/<pkg> -name '*.map' -printf '%s\n' | awk '{s+=$1} END {print s}'
```

Against today's budgets (`__tests__/server/budget.test.ts` in each package):

| Budget | Limit | Today |
|---|---|---|
| jobs entry | 348 KiB / 112 KiB gzipped | 330.2 / 106.5 |
| jobs any other chunk | 101 KiB / 33 KiB gzipped | largest 93.5 / 30.4 (`index-jrv9srfv.js`) |
| docs entry | 365 KiB / 114 KiB gzipped | 339.4 / 106.1 |
| docs any split chunk | 120 KiB / 40 KiB gzipped | none |

## The published 3.0.0-rc.0 tarballs

Downloaded from the registry (`npm view <pkg>@3.0.0-rc.0 dist.tarball`) and
listed with `tar tvzf`; bytes per top-level directory, source maps apart.

| | bun-jobs-ui | bun-api-docs-ui |
|---|---:|---:|
| tarball (gzip) | 1,132,147 | 582,103 |
| `npm view … dist.unpackedSize` | 4,338,681 | 2,422,195 |
| files (`dist.fileCount`) | 106 | 97 |
| `dist/` without maps | 891,112 | 378,934 |
| `dist/` maps | 3,245,082 | 1,580,738 |
| `app/` (the `./embed` source) | — | 378,351 |
| `dts/` with its maps | 29,822 | 28,240 |
| `lib/` | 52,461 | 47,128 |
| README.md | 116,022 | 3,748 |

Both are on npm as `3.0.0-rc.0` only (plus a `0.0.0-stage` from the first
publish), and `latest` and `next` both point at `3.0.0-rc.0`
(`npm view <pkg> dist-tags`, 2026-11-08).

## One bun-ui tarball

The sum of the two, with nothing deduplicated: about **6.8 MB unpacked,
1.7 MB as a tarball**, of which the source maps are **4.8 MB** (71%). For
scale, bun-jobs' own rc.0 tarball unpacks to 9,227,742 bytes. The bundles
themselves do not shrink by moving: each UI keeps its own build, and the docs
screens are in both the jobs bundle (its docs section) and the docs bundle, as
they are today.
