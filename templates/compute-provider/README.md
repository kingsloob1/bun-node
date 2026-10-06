# bun-jobs-provider-example

A starter template for a bun-jobs (`@kingsleyweb/bun-jobs`) compute provider:
a package that teaches bun-jobs' summon controller to start workers on a
platform. It is written for **Acme Compute**, a fictional platform, so it can
never go stale against a real API, and it passes the conformance kit as it
stands.

```text
src/index.ts             the provider: identity, capabilities, summon, status, cancel, validate
src/config.ts            the config schema (toStandardSchema, no library)
src/errors.ts            Acme's errors → ProviderError, one table
test/fake-platform.ts    a fake of Acme's API, for the kit
test/conformance.test.ts runProviderConformance + assertConformance, green
scripts/build.ts         dist/: the bundle and the declarations
scripts/check-types.ts   packs, installs outside, type-checks as a user would
bun-timings.json         per-file test durations: bun run test's schedule
```

The summon facet only: bun-jobs has no execute facet yet.

## Quick start, as a checklist

1. **Copy this directory** and rename the package `bun-jobs-provider-<platform>`
   (or `@<scope>/bun-jobs-provider-<platform>`). Keep the keywords
   `bun-jobs-provider` and `bun-jobs-provider-summon`: they make it findable.
2. **Remove `private`** from `package.json`, and **`overrides`** once
   `@kingsleyweb/bun-jobs` is on the registry: `overrides` points the install
   at the bun-node repo's own packages, and works only inside that repo.
   Until the packages are published, `@kingsleyweb/bun-jobs@2.2.x` cannot be
   installed from a registry, so pack both from a checkout of bun-node and
   point `overrides` at the tarballs:

   ```bash
   cd /path/to/bun-node && bun install
   (cd packages/bun-common && bun pm pack --destination /path/to/tarballs)
   (cd packages/bun-jobs && bun pm pack --destination /path/to/tarballs)
   ```

   ```json
   {
     "overrides": {
       "@kingsleyweb/bun-jobs": "file:/path/to/tarballs/kingsleyweb-bun-jobs-2.2.0.tgz",
       "@kingsleyweb/bun-common": "file:/path/to/tarballs/kingsleyweb-bun-common-2.2.0.tgz"
     }
   }
   ```

   Not the checkout's directories: installed that way from outside the repo,
   bun-common arrives without its own dependencies
   ([oven-sh/bun#44299](https://github.com/oven-sh/bun/issues/44299)).
3. **Identity**: `name` and `version` equal to `package.json`'s; a `kind` of
   1-24 lowercase letters, digits and dashes; `apiVersion` written as a
   literal, and repeated in `package.json`'s `"bun-jobs"` field. A test holds
   the two equal.
4. **Config**: any Standard Schema. Validate synchronously where you can, so a
   bad config throws at once. List every secret's path in `secrets`: it is
   redacted from every log. `describe()` returns facts, never a secret.
5. **Capabilities**: declare what the platform does, not what you hope it
   does. The controller reads them instead of knowing your platform: `style`,
   `dedupe` with the platform's real token limits, `passes: "argv"` when the
   platform takes command-line arguments (never the environment), the boot
   budget, the shutdown signal and grace, the lifetime cap.
6. **`summon()`**: send `request.dedupeKey` as the platform's token, and
   `request.argv` as the unit's arguments. Under a strict token, send nothing
   that is not a function of the request's id: never `demand` or `reason`.
   Call through `ctx.fetch` with `ctx.signal`, never the global `fetch`.
7. **Errors**: a `SummonResult` when the platform answered normally
   (`unavailable` for "no capacity" on a 200), a `ProviderError` when it did
   not. One table from the platform's codes to the six kinds.
8. **Optional hooks**: `status()` and `cancel()` explain and clean up a lost
   attempt; `validate()` is a preflight that starts nothing.
9. **The fake**: the platform's routes and its error bodies, faithfully.
   `fakePlatform()` does the bookkeeping.
10. **Run the gate**:

    ```bash
    bun install
    bun run test                # the conformance kit, green
    bun scripts/check-types.ts  # the shipped declarations, as a user sees them
    ```

    `bun run test` runs the test files in parallel, slowest first by
    `bun-timings.json`: scheduling hints only, safe to delete or leave stale
    (a test file it does not list still runs). `bun run test:timings`
    re-measures it; run it after adding or renaming a test file. `bun run test:serial` is a plain
    `bun test`, in one process, for debugging.

11. **Publish**: the peer range is one bun-jobs minor while the plugin API is
    `0.x`. Publishing the kit's report (`report.toMarkdown()`) tells users
    what was tested, and that it was tested against a fake.
