# `bun install` resolves a `file:` dependency's devDependencies

| | |
|---|---|
| **Bun** | 1.4.4-canary.1 (`11c367163`), Linux x64 |
| **Status** | Open upstream as a feature request: [oven-sh/bun#22879](https://github.com/oven-sh/bun/issues/22879); our failure case added as [a comment](https://github.com/oven-sh/bun/issues/22879#issuecomment-6712639232) (2026-11-07) |
| **Reproduction** | [`file-dependency-resolves-dev-dependencies.ts`](./file-dependency-resolves-dev-dependencies.ts) (exits 1 while present) |
| **Worked around in** | documented only: CLAUDE.md, "The compute-provider template" (its lock is kept, and installed `--frozen-lockfile`) |

## What happens

A `file:` folder dependency is installed with its **devDependencies**
resolved as well. When one of them says `catalog:` or `workspace:^`, which
only mean something inside the workspace the folder belongs to, the install
fails:

```
bun install v1.4.4-canary.1 (11c367163)
error: zod@catalog: failed to resolve
```

npm installs the same tree, ignoring the folder's devDependencies, as npm,
Yarn and pnpm all do for a registry package.

## Why it matters here

Since #645 the packages name each other `workspace:^` and take shared
devDependencies from the root catalog (`catalog:`). The compute-provider
template is outside the workspaces and reaches bun-common and bun-jobs
through `file:../../packages/…` overrides, so a plain `bun install` there now
fails on the packages' devDependencies (measured: `eslint-config-prettier`,
`typescript`, `valibot`, `yup`, `zod` `@catalog:` and
`@kingsleyweb/bun-contract@workspace:^`). The committed lock still installs
with `--frozen-lockfile`, which is what every gate runs, so nothing is
broken until the template's own dependencies need to change.

## What to do until it is fixed

The template's dependencies stay as locked. Changing one needs a plain
install to re-lock, which this blocks; no workaround has been tried yet, so
that change starts by finding one (an `overrides` entry per failing
devDependency is the obvious candidate, untested).

## Once it is fixed

Run `bun install` in `templates/compute-provider` and commit the lock it
writes (its own commit), then drop the note in CLAUDE.md and this entry.
