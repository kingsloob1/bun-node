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
```

The summon facet only: bun-jobs has no execute facet yet.

## Quick start, as a checklist

1. **Copy this directory** and rename the package `bun-jobs-provider-<platform>`
   (or `@<scope>/bun-jobs-provider-<platform>`). Keep the keywords
   `bun-jobs-provider` and `bun-jobs-provider-summon`: they make it findable.
2. **Remove `overrides` and `private`** from `package.json`. They point the
   install at the bun-node repo's own packages; yours come from the registry.
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
    bun test                    # the conformance kit, green
    bun scripts/check-types.ts  # the shipped declarations, as a user sees them
    ```

11. **Publish**: the peer range is one bun-jobs minor while the plugin API is
    `0.x`. Publishing the kit's report (`report.toMarkdown()`) tells users
    what was tested, and that it was tested against a fake.
