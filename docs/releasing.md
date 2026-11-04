# Releasing

The eight packages under `packages/` are released together, at one version
(lerna's fixed mode: `lerna.json`'s `version` is the version of all of
them). Every internal `@kingsleyweb/*` range — dependencies, peers, optional
peers and devDependencies — is `^<version>`. A stale range is the one
mistake that does not show in the repo: Bun links the workspace whatever the
range says, while npm installs a dependent's out-of-range dependency from the
registry (a stale `^2.2.0` would pull bun-common 2.2.0 under a 3.x bun-jobs).

## Preparing a version (a PR)

1. Set `version` in every `packages/*/package.json` and in `lerna.json`.
   By hand, not with `lerna version`: lerna 10 leaves `peerDependencies`
   ranges at the old version, skips the template and `JOBS_VERSION`, and
   rewrites `bun.lock` wholesale (tried on 3.0.0-rc.0 → 3.0.0).
2. Set every internal range to `^<version>`. The compute-provider template
   (`templates/compute-provider/package.json`) is the exception: its peer on
   bun-jobs is one minor wide while the provider API is `0.x`
   (`>=<version> <major.minor+1.0>`, dev `~<version>`); its `overrides` keep
   their `file:` paths.
3. Set `JOBS_VERSION` in `packages/bun-jobs/lib/shared/constants.ts` (a test
   pins it to the manifest), and any install line or version a README states.
4. `bun install` at the root: it rewrites only `bun.lock`'s workspace
   section. Then `bun install --frozen-lockfile` at the root and in
   `templates/compute-provider` must pass. The lock change is its own commit.
5. Gate as for any change (`CLAUDE.md`), plus `bun scripts/consumer-check.ts
   packages/<pkg>` for all eight, `bun scripts/check-types.ts` (the template),
   and `bun pm pack` of each package to read the file list: `dts/` (and
   `dist/` for the two UI packages) present, no tests, no `.env*`.

## Publishing (the maintainer)

From a clean, up-to-date `develop` after the PR merged, logged in with
`npm login`. `npm publish` runs each package's `prepack`, which builds the
declarations (and the UI bundles) with Bun, so `bun` must be on the `PATH`.

Publish in dependency order, each after what it depends on:

```text
bun-contract  bun-common  bun-api-docs-ui  bun-cache  bun-jobs  bun-client  bun-nest  bun-jobs-ui
```

```bash
cd packages/<pkg> && npm publish --tag next     # a prerelease (npm requires --tag)
cd packages/<pkg> && npm publish                # a final version, to latest
```

Add `--otp=<code>` with two-factor authentication. A published version can
never be published again, so after a failure carry on from the package that
failed. Then verify (`npm view @kingsleyweb/<pkg>@next version`, or
`dist-tags`), install the packages in a fresh project outside the repo, and
tag the commit: `git tag -s v<version> && git push origin v<version>`.
`prepack` leaves the gitignored `dts/` and `dist/` behind; remove them
(`git clean -fdX packages/*/dts packages/*/dist`), since a stale `dist/` is
served by `jobsUi()` in the repo.

## Prereleases and promotion

A release candidate (`3.0.0-rc.0`) goes to the `next` tag. A package's first
publish also becomes its `latest`, which npm requires to exist. To promote,
prepare and publish the final version (`3.0.0`, ranges `^3.0.0`) as above
without `--tag`, then `npm dist-tag add @kingsleyweb/<pkg>@3.0.0 next` so
`next` does not lag behind. Pointing `latest` at the candidate itself
(`npm dist-tag add @kingsleyweb/<pkg>@3.0.0-rc.0 latest`) also works, but
leaves a prerelease as `latest`.
