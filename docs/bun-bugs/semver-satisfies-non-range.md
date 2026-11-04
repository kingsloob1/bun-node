# `Bun.semver.satisfies` answers `true` for a string that is not a range

| | |
|---|---|
| **Bun** | 1.4.4-canary.1 (`11c367163`), Linux x64 |
| **Status** | Filed: [oven-sh/bun#47908](https://github.com/oven-sh/bun/issues/47908) (2026-11-04) |
| **Reproduction** | [`semver-satisfies-non-range.ts`](./semver-satisfies-non-range.ts) (exits 1 while present) |
| **Worked around in** | `scripts/publish.ts`, `tagProblems` and `EXACT_VERSION` |

## What happens

`Bun.semver.satisfies("1.2.3", "foo")`, `("1.2.3", "latest")` and
`("0.0.0", "next")` are all `true`: any string that does not parse as a
range behaves like `*`. A real range (`^1.0.0`, `^2.0.0`) answers correctly.

## Why it is a bug

Bun documents `Bun.semver` as compatible with node-semver, whose
`satisfies(version, range)` is `false` when the range is invalid
(`semver.validRange("foo") === null`). Code asking "is this string a range?"
or "is this an exact version?" through `satisfies` gets yes for every string.

## How bun-node works around it

`scripts/publish.ts` refuses an npm dist-tag that reads as a version by its
shape (`/^v?\d/`), not with `Bun.semver.satisfies("0.0.0", tag)`, which
refused `next` and `latest` (measured: every runPublish test refused), and
checks `lerna.json`'s version with a regular expression (`EXACT_VERSION`).
Covered by `scripts/__tests__/publish.test.ts` ("defaults the tag from the
version and refuses latest for a prerelease").

## Once it is fixed

Nothing has to go: the shape checks are correct on their own. A
`Bun.semver.validRange` (#7698) would be the cleaner check.
