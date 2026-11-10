# Releasing

Every package under `packages/` that is not `private` is released, together
and at one version: lerna's fixed mode, where `lerna.json`'s `version` is
the version of all of them. `scripts/publish.ts` publishes them, finding
them from the root `package.json`'s `workspaces.packages`, so a new
package needs no list to be edited ([A new package](#a-new-package)).

The workspace's packages name each other `workspace:^`: dependencies, peers,
optional peers and devDependencies. External devDependencies used by two
or more packages at one range come from the root's catalog
(`workspaces.catalog`, named `catalog:` in a package). Both are spellings
only a Bun workspace resolves. `bun pm pack` (and `bun publish`) rewrite
them in the tarball: `workspace:^` becomes `^<version>`, and `catalog:`
becomes the catalog's range. **`npm pack` and `npm publish` run from a
package directory ship them verbatim**, and a consumer's install then
fails. So never run `npm publish` in a package directory: the script packs
with Bun, reads every tarball back (`scripts/pack-guard.ts`), and uploads
the tarball with npm.

## The flow

1. **The version-bump PR** (below): the versions, the template, the
   `CHANGELOG.md` entry, the lock.
2. **Merge it**, then update a clean `develop` checkout.
3. **`npm login`**, once. The script never logs in.
4. **`bun scripts/publish.ts --dry-run`**: everything but the uploads, the
   tag and the release. When it refuses, it gives every reason at once.
5. **`bun scripts/publish.ts`** (or `bun run release`): asks once for the
   npm one-time code, then publishes, verifies, tags and releases.
6. **Deprecate what the release retired**, if anything
   ([Retiring a package](#retiring-a-package)). 3.0.0-rc.1 retired
   `@kingsleyweb/bun-jobs-ui` and `@kingsleyweb/bun-api-docs-ui`; 3.0.0-rc.2
   and 3.0.0 retire nothing.
7. **Move the tags** ([Prereleases and promotion](#prereleases-and-promotion)).
   A final version such as 3.0.0 is published to `latest` for every package;
   then point `next` at it too, so `@next` does not install an older
   candidate. For a candidate, move `latest` where it supersedes one.

## The version-bump PR

1. Set `version` in every `packages/*/package.json` and in `lerna.json`.
   Do it by hand, not with `lerna version`: lerna 10 skips the template and
   `JOBS_VERSION`, and rewrites `bun.lock` wholesale (tried on 3.0.0-rc.0 →
   3.0.0). The internal ranges need no edit: they are `workspace:^`.
2. The compute-provider template (`templates/compute-provider/package.json`)
   is not a workspace member, so its ranges are plain. Its peer on bun-jobs
   is one minor wide while the provider API is `0.x`
   (`>=<version> <major.minor+1.0>`), and its dev range is `~<version>`.
   Its `overrides` keep their `file:` paths.
3. Set `JOBS_VERSION` in `packages/bun-jobs/lib/shared/constants.ts` (a test
   pins it to the manifest), and any install line or version a README states.
   Then run `bun run gen:client` in `packages/bun-ui`: the jobs API's document
   carries the version, so `app/jobs/api/routes.gen.ts`'s recorded hash goes
   stale with it, and `bun run check:client` fails until it is rewritten. The
   3.0.0-rc.2 bump missed this (#744).
4. **The `CHANGELOG.md` entry.** `bun scripts/changelog.ts <version>` writes
   one from the commit subjects since the previous tag (`--print` to see it
   first; `--from <tag>` for another start). It never commits; review it and
   commit it in this PR.
   - Commits are grouped by type: Breaking (a `!:` or a `BREAKING CHANGE:`
     footer), Features, Fixes, Performance, Docs, Other. Inside each type
     they are grouped by scope (`feat(bun-client): …` goes under
     bun-client).
   - Merge commits are left out, but each line links the PR that merged it.
   - A long release can have a hand-written entry instead (3.0.0-rc.0 has
     one, since 1,786 commits made a list nobody reads). Mark it with
     `<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->`
     under its heading.
   - The script refuses a version that already has an entry. `--force`
     replaces only an entry it generated.
   - `publish.ts` refuses a version with no entry, and uses the entry as
     the GitHub release's notes.
5. `bun install` at the root: it rewrites only `bun.lock`'s workspace
   section. Then `bun install --frozen-lockfile` must pass at the root and
   in `templates/compute-provider`. The lock change is its own commit.
6. Gate as for any change (`CLAUDE.md`), plus:
   - `bun scripts/consumer-check.ts packages/<pkg>` for every package;
   - `bun scripts/check-types.ts` in the template;
   - `bun scripts/publish.ts --dry-run --allow-dirty --skip-whoami` on the
     branch. It packs and guards every tarball (`dts/`, and `dist/` for
     the UI packages, are built by `prepack`), and prints the order and
     the release it would make.

## Publishing

From a clean, up-to-date `develop` after the PR merged, logged in to npm
(`npm login`) and to GitHub (`gh auth status`):

```bash
bun scripts/publish.ts --dry-run   # rehearse: pack, guard, npm publish --dry-run
bun scripts/publish.ts             # asks once for the one-time code
```

In order, it:

1. **Finds the packages** from `workspaces.packages`. Globs are expanded as
   Bun does, and a `!` pattern excludes. Every member that is not
   `private: true` is published.
2. **Refuses** anything that would leave a release half made:
   - a member that lacks what publishing needs (below);
   - a dirty tree;
   - `--tag latest` for a prerelease. The default tag is `next` for a
     prerelease and `latest` otherwise.
   - no `npm whoami`;
   - no `CHANGELOG.md` entry for the version;
   - `gh` not logged in, or an active account that cannot push to the
     repository;
   - a `v<version>` tag, locally or on origin, at another commit.
3. **Orders the packages from the dependency graph** and prints the order.
   Dependencies and required peers come first. Optional peers do not order
   packages, which is how bun-common and bun-ui can name each
   other. Ties are broken by name.
4. **Skips every `name@version` the registry already has**
   (`npm view <name>@<version> version`). A re-run after a failure
   therefore carries on where it stopped.
5. **Packs everything** with `bun pm pack` into one temp directory
   (`--work <dir>` to choose it) and guards each tarball. A tarball fails
   if it still contains `workspace:` or `catalog:`, if its version is not
   the release's, or if an internal range is not `^<version>`. All of this
   happens before any code is asked for. Build outputs that `prepack`
   created (`dts/`, `dist/`) are removed after packing, since `jobsUi()`
   in the repo serves a stale `dist/`.
6. **Asks once for the one-time code**, without echoing it. Then it runs
   `npm publish <tarball> --tag <tag> --access public` for each package in
   order, with the code in npm's environment (`npm_config_otp`), where it
   is neither printed nor visible in `ps`.
   - `--otp <code>` gives the code on the command line instead (it then
     shows in your shell history).
   - `--no-otp` is for an account without two-factor authentication.
   - If the code is rejected or has expired (`EOTP`), the script asks for a
     new one and retries that package.
   - Any other failure stops the run and prints what was published and
     what was not.
7. **Verifies** each package with `npm view <name>@<tag> version`.
8. **Tags and releases**, once every package is on the registry:
   - It makes a signed, annotated `v<version>` tag on HEAD (`git tag -s`;
     the repo signs with SSH).
   - It pushes the tag to origin, retrying, since GitHub's SSH can be
     flaky. If the push still fails, it prints the commands to finish by
     hand.
   - It runs `gh release create v<version> --verify-tag`. The notes are
     the `CHANGELOG.md` entry plus an npm link for each package, and
     `--prerelease` is added for a prerelease.
   - Each of these steps is skipped if it is already done, so a re-run
     makes them exactly once.
   - `--no-release` skips this whole step.

`gh` uses its active account. If that account cannot push here (the script
says which account it is), choose another for this one command:

```bash
GH_TOKEN=$(gh auth token --user kingsloob1) bun scripts/publish.ts
```

A published version can never be published again, and the script never
tries to.

### Why not `lerna publish from-package`

lerna 10 rewrites `workspace:^` only in the first dependency field that
names the package, checking dependencies, then optionalDependencies, then
devDependencies, then peerDependencies (`updateLocalDependency`). A
package that names another workspace package as both a peer and a
devDependency would ship its peer as `workspace:^`. Four packages here do
that: bun-common, bun-client, bun-ui, and bun-nest (twice). lerna
also has no support for `catalog:` at all. It packs the manifest as it is,
with npm-packlist and tar, so every `catalog:` devDependency would ship
verbatim.

## Prereleases and promotion

A release candidate such as `3.0.0-rc.0` goes to the `next` tag. A
package's first publish also becomes its `latest`, because npm requires
`latest` to exist. A later candidate on `next` does not move it: after
3.0.0-rc.1, the packages first published at 3.0.0-rc.0 (bun-contract,
bun-cache, bun-jobs, bun-client) still have `latest` at 3.0.0-rc.0, and
bun-ui, first published at 3.0.0-rc.1, has it there.

To promote the candidate to 3.0.0:

1. Make a version-bump PR as above: `3.0.0` by hand, and a `CHANGELOG.md`
   entry.
2. After it merges, run `bun scripts/publish.ts` (`latest` is the default
   tag for a final version).
3. Run `npm dist-tag add @kingsleyweb/<pkg>@3.0.0 next` for each package,
   so `next` does not lag behind.

You can also point `latest` at the candidate itself
(`npm dist-tag add @kingsleyweb/<pkg>@3.0.0-rc.1 latest`), but that leaves
a prerelease as `latest`.

**Until 3.0.0, that was done for each candidate** (the maintainer's
decision, 2026-11-08, for 3.0.0-rc.1): the last candidate was superseded, and
with `latest` left at it a plain `bun add` of these installed it. For
3.0.0-rc.2 it was, after `publish.ts` had finished, with `--otp=<code>` if
npm asks:

```bash
npm dist-tag add @kingsleyweb/bun-contract@3.0.0-rc.2 latest
npm dist-tag add @kingsleyweb/bun-cache@3.0.0-rc.2 latest
npm dist-tag add @kingsleyweb/bun-jobs@3.0.0-rc.2 latest
npm dist-tag add @kingsleyweb/bun-client@3.0.0-rc.2 latest
npm dist-tag add @kingsleyweb/bun-ui@3.0.0-rc.2 latest
```

bun-common and bun-nest kept `latest` at 2.2.0 (their last final release)
until 3.0.0.

**For 3.0.0**, `publish.ts` moves `latest` to 3.0.0 for all seven packages,
bun-common and bun-nest included. Then, with `--otp=<code>` if npm asks:

```bash
npm dist-tag add @kingsleyweb/bun-contract@3.0.0 next
npm dist-tag add @kingsleyweb/bun-common@3.0.0 next
npm dist-tag add @kingsleyweb/bun-client@3.0.0 next
npm dist-tag add @kingsleyweb/bun-cache@3.0.0 next
npm dist-tag add @kingsleyweb/bun-jobs@3.0.0 next
npm dist-tag add @kingsleyweb/bun-nest@3.0.0 next
npm dist-tag add @kingsleyweb/bun-ui@3.0.0 next
```

Check with `npm view @kingsleyweb/<pkg> dist-tags`: `latest` and `next`
both print `3.0.0`.

## Retiring a package

A package that leaves the workspace is not unpublished: npm allows that
only in the first 72 hours, and an install of a published version should
keep working. It is **deprecated**, once the package that replaces it is on
the registry, so every install of it prints where to go instead. The
maintainer runs this, logged in to npm (`publish.ts` never deprecates).

**After 3.0.0-rc.1 is published** (`npm view @kingsleyweb/bun-ui@next
version` prints `3.0.0-rc.1`), deprecate the two packages `@kingsleyweb/bun-ui`
replaced:

```bash
npm deprecate @kingsleyweb/bun-jobs-ui "moved into @kingsleyweb/bun-ui: import from @kingsleyweb/bun-ui/jobs"
npm deprecate @kingsleyweb/bun-api-docs-ui "moved into @kingsleyweb/bun-ui: import from @kingsleyweb/bun-ui/docs"
```

With two-factor authentication, add `--otp=<code>` to each, a fresh code
for each command. A name without a version deprecates every version it
has (`3.0.0-rc.0` and the `0.0.0-stage` placeholder). Check it took:

```bash
npm view @kingsleyweb/bun-jobs-ui deprecated
npm view @kingsleyweb/bun-api-docs-ui deprecated
```

Each prints its message. To undo one, deprecate it again with an empty
message (`npm deprecate @kingsleyweb/bun-jobs-ui ""`). The packages and
their imports are listed under 3.0.0-rc.1 in `CHANGELOG.md`.

## A new package

A new workspace member is published by the script as soon as it meets the
script's checks, with no list to edit anywhere. The script refuses a
publishable member that lacks any of these, naming each one:

- **`version`** equal to `lerna.json`'s.
- **`publishConfig.access: "public"`** if the name is scoped.
- **`files`**: what the tarball ships, usually `["dts", "lib"]`.
- **`sideEffects`**: `false`, or the list of modules with an effect at load
  (`["**/*.css"]` and the like), never `true` or absent, and proved by the
  package's `__tests__/treeShaking.test.ts` (`CLAUDE.md`, "Packaging
  types").
- **A `prepack` that builds its declarations**:
  `bun scripts/build-declarations.ts`, with `scripts/build-declarations.ts`
  and `tsconfig.build.json` copied unchanged from another package. Those
  copies are one file (`CLAUDE.md`, "Packaging types").
- **A `LICENSE`**: copy the root's.
- **A `consumer-check.json`** with `entries`, so
  `scripts/consumer-check.ts` checks the package as a consumer sees it.
- **Internal dependencies on `workspace:^`.** A package it requires
  (a dependency or a required peer) must not be `private`.

Mark a member `"private": true` to keep it out of the release.
