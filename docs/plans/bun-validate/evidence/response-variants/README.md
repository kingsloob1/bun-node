# response-variants: one status, several whole responses

A spike, not product code. It backs the plan's §4.4.6 (V3c,
[`../../README.md`](../../README.md#446-response-variants-v3c)): within one
status, the response may differ by who asked (an admin recognised by a request
header, a session cookie) or by what the response says about itself (a mode
header, a set cookie). The user decided the need on 2026-10-21; the spike tests
the design for it.

A union per part, which V3a already allows, fails three ways: it cannot tie
the parts together (`x-admin: 1` with a user body passes), it cannot tie a
response to the request (a non-admin answered with the admin body passes),
and it types `res` as the union in every branch. The spike shows each fixed,
and where the fix stops.

**Updated the same day with the user's answers** (Q-H15–Q-H22): `when` may
be asynchronous, with a fast path (Q-H17), and `res.variant(name)` **adjusts
the response** (Q-H18): it fills what the variant's schemas allow exactly one
value for and the handler did not set (the discriminant, literal headers and
cookies, the status, `Content-Type`, literal body fields) and strips body
fields the variant does not declare. VT9 and VT18–VT21 and RV10b–e and
RV18–RV28 are that round's.

Recorded 2026-10-21 on branch `docs/bun-validate-v3c-plan` (base `a471c18d`,
V0–V3b merged), Bun 1.4.4-canary.1 (`6bb5dc195`), linux/x64, 16 cores, zod
4.6.1 and yup 1.7.1 from the repo's root `node_modules`.

## Files and how to run them

Run everything from this folder.

| File | What it is | Run | Pass condition |
|---|---|---|---|
| `variants.ts` | the prototype: `variants()` and its types, composed with the **real** V3a types (`InferResponses`, `ResponseSpecObject`, `InferValidatedShape`, `ValidatorMiddleware`); `validateV()`, a types-only `validate()` carrying them; and the runtime matcher (`compile`, `match`) on the core's real runner (`runSchema`, which scrubs received values) | imported by the rest | — |
| `types.probe.ts` | type cases against the real `BunRouter`, its generated overloads, the real `BunResponse` and bun-nest's `BunHttpAdapter`; `.variant()` is added to the real `BunResponse` by **module augmentation**, so no lib file changes; 21 negative controls (VT1–VT21) and three boundaries (B1–B3) | `bash check-types.sh` | the clean check exits 0, and the mutant fails on exactly the 21 control lines and nowhere else |
| `check-types.sh` | `bun --check` here, then the mutant (every `// @ts-expect-error` line removed, the relative `packages/` imports rewritten to absolute paths) in a scratch directory (default `~/.cache/bun-node-11/validate-g1/v3c/scratch/mutant`; it writes and deletes only there) | `bash check-types.sh [dir]` | prints `PASS: every control fires, and nothing else fails` |
| `run.ts` | the runtime cases RV1–RV28 | `bun run.ts` | every line `PASS`; exit 0 |
| `bench.ts`, `bench.sh` | the matcher's cost per variant count (1, 2, 4, 8), with and without issues built while matching, and `.variant()`'s adjust; each scenario in its own process, pinned, three runs | `HEAVY_TICKET=<you>-v3c-bench /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 900 bash bench.sh` | a benchmark: read the minimums and the load each line prints |
| `results.txt` | the recorded output of `check-types.sh`, `run.ts` and `bench.sh` | — | — |
| `tsconfig.json` | extends `../tsconfig.json` with `include: ["./*.ts"]` (the parent's covers only `../*.ts`) | — | — |

Every `bun --check` runs as `env -u AGENT -u CLAUDECODE -u REPL_ID bun --check`
(the repo's `CLAUDE.md`, "Bun's checker, not tsc"). Lint:
`CI=1 bunx eslint --config ../../../../../templates/eslint.legacy.config.mjs --no-warn-ignored *.ts`
gives 0 errors. `run.ts` and `bench.ts` turn off `no-console`,
`antfu/no-top-level-await` and `n/prefer-global/process` (CLI entry points,
as the repo's `scripts/` config does); `types.probe.ts` turns off
`prettier/prettier`, because its controls are tied to lines.

## What the type probe shows

Against the real types, with nothing in `packages/` changed:

| Case | Shows |
|---|---|
| §1 positive | `when`'s parameter **is** the validator's parsed parts (`Equal<typeof valid, { headers: { "x-admin"?: "1" }; cookies: { sid?: string } }>`), inferred from `validate()`'s first argument through the nested `variants()` call, with nothing restated; `req.valid` is the same type |
| §1 positive | without `.variant()`, `res.status(200).json()` takes either variant's body, and `set("x-admin", "1")` a header only one variant declares: the union, exactly V3a's per-part typing |
| §1 positive | `res.status(200).variant("admin").set("x-admin", "1").json(adminBody)`: the real `status()` return (`NarrowResponses`) carries `.variant()`, which narrows headers, cookies and body together |
| VT1 | an undeclared variant name |
| VT2, VT3 | one variant's body under the other |
| VT4 | a variant's header outside its declared literal |
| VT5 | `.variant()` on a status that declares no variants (404) |
| VT6 | a body that is neither variant's, on the union |
| VT7 | `when` reading a part no validator parsed (`valid.cookies` with no cookies schema) |
| VT8 | `when` comparing the parsed header with a number (its type is the schema's output) |
| VT9, VT18 | a `when` answering a non-boolean, sync or async (an `async` `when` resolving a boolean is allowed, beside them) |
| VT10 | an unknown key in a variant (a `const` generic skips excess-property checks, so `StrictTable` exists) |
| VT11, VT12 | a discriminant header (`by: { header: "x-mode" }`): under `.variant("summary")` it takes `"summary"` only; on the union, one of the variant names |
| VT13 | the full body under the summary variant |
| VT14 | `by.values` naming a variant that is not declared (`StrictBy`, for the same reason as VT10) |
| VT15 | a `refine` issue naming a part responses do not have |
| VT16, VT17 | `.variant()` with no responses declared, and with V3a responses that declare no variants: its parameter is `never` |
| VT19–VT21 | after `.variant()`, `json({ id, meta: { at } })` compiles with `kind` and `meta.v` (single literals) left out, for zod; on the union nothing is optional (VT19); a non-literal field stays required (VT20); valibot's literal stays required, since its schema type carries no `~standard.jsonSchema` (VT21) |
| §6 | the same narrowing through **bun-nest's** `BunHttpAdapter` overloads |
| §7 | `HeaderArgV3c`: the one change V3c makes to a V3a type for B1 (a header declared absent takes no value), checked with `Equal` |

Boundaries (compile, by design or until V3c's change):

- **B1**: `res.status(200).variant("user").set("x-admin", "1")` compiles,
  because V3a's `HeaderArg` reads an undeclared name (and `never`) as "any
  value". The gate refuses it at runtime when the user variant forbids the
  header or the discriminant maps its absence to the user variant (RV2, RV6c).
  V3c adds a declared-absent marker to `HeaderArg` (§7) so a discriminant's
  `null` becomes a type error too.
- **B2**: a structural superset passes `json()`'s generic constraint (no
  excess-property check on a type parameter, as in V3a), so the admin body
  with `role: "user"` types as a user body. At runtime RV17a shows the same
  limit.
- **B3**: a mount's `when` is typed by its own validator; at runtime
  `req.valid` holds every layer's parts. Not probed.

## What the runtime cases show

`run.ts` drives `match()`, the decision V3c's commit gate would make, over a
response view `{ status, headers, cookies, mediaType, body, variant }` and a
request view `{ valid, raw }`. Every verdict is searched for three planted
values (a body field, a discriminant header, a value a `refine` message
quotes); none appears (RV16).

| Case | Shows | Recorded |
|---|---|---|
| RV1 | an admin request, `x-admin: 1` and the admin body: sent as `admin` | `{"ok":true,"variant":"admin"}` |
| RV2 | an admin request, `x-admin: 1` with a **user** body: refused; each acceptable variant's own issues, tagged `variant` (admin: the body; user: `headers.x-admin` must be absent). Parts are never taken from two variants | a summary issue plus one per failing path |
| RV3 | a non-admin request answered with a valid admin response (**the leak**): refused; the failure path also names the excluded variant the response matches in full | `The response matches variant "admin", which does not apply to this request` |
| RV4 | a non-admin request, the user body: sent as `user` | |
| RV5 | a request no variant's `when` holds for: refused | `No variant of this status applies to this request (2 excluded by when)` |
| RV6a–d | a header discriminant with `values: { admin: "1", user: null }`: `"1"` selects admin, absence user; `x-admin: 1` with a user body checks **only** admin; the discriminant selecting admin for a non-admin request is refused before any body check | |
| RV6e–g | `by: { header: "x-mode" }` (values default to the names): summary sent; an unknown value and a missing header are refused on `headers.x-mode`, the issue listing the declared values, **never** the received one | `Does not select a variant (expected full, summary)` |
| RV7a–b | a `Set-Cookie` discriminant: `true` (present, any value) selects one variant, `null` (absent) the other | |
| RV8a–c | `res.variant()` named by the handler: only that variant is checked, its `when` still enforced; named on a status with no variants, refused | |
| RV9a–b | `refine`, a whole-response check across parts (`x-total` equals the item count); its message quoted a body value, which the core's scrub withholds (it is scrubbed against **every** part, since a refine sees all of them) | `"message":"Invalid value"` |
| RV10a | a `when` that throws: a failed check, one value-free issue, the error kept for the log | `The response could not be checked` |
| RV10b–e | an async `when` resolving `true` is awaited (the verdict is a Promise) and sent; a sync `when` keeps the verdict sync (no Promise made); an async one resolving `"yes"`, or rejecting, is a failed check | |
| RV11 | no validator ran (`valid` is `{}`): a `when` reading `valid.headers` sees `undefined`, does not throw, and the unconditional variant applies | |
| RV12 | `when` calls: 8 variants with a `when` → 8 calls; a status with no variants → 0 | |
| RV13a–b | yup (an async vendor): the verdict is a Promise, with the same outcomes | |
| RV14 | declaration mistakes are `TypeError`s: `when` on a plain status, two variants on one discriminant value, `values` naming no variant, an empty `variants({})` | |
| RV15 | a status with no variants: V3a's issue shape, no `variant` field | |
| RV17a | **the limit**: a user view that is a loose structural subset of the admin view (no discriminating literal, not strict) **accepts** the admin body; a check-only gate cannot catch this leak | `{"ok":true,"variant":"user"}` |
| RV17b | the same table with `z.strictObject` for the user view: refused, the admin variant named | |
| RV18 | `.variant("admin")` with only `x-request-id` and an incomplete body set: fills the discriminant `x-view`, the literal header `x-tier`, `Content-Type` (the one declared `application/vnd.admin+json`, replacing `json()`'s implicit type), `kind`, `meta.v` and each `items[].k`; strips one undeclared field at each of three depths; sent | the changes as paths and counts, never key names |
| RV19 | the handler's own object is unchanged afterwards (copy-on-write) | |
| RV20 | `.variant("created")` with no status set: the one status declaring it, 201, is filled | `status: filled (201)` |
| RV21 | a required field with no single value (`salary`) missing: left to the check, refused on `body.salary` | |
| RV22 | a literal header the handler set wrongly (`x-tier: silver`) is never overwritten: refused | |
| RV23 | `.variant("admin")` for a non-admin request: `when` is decided first; nothing adjusted; refused | |
| RV24 | the handler set the discriminant to another variant's value: kept, refused as a disagreement | |
| RV25 | **the leak fixed**: RV17a's loose table, `.variant("user")` on the admin body: `salary` stripped, sent as user | `body: stripped 1 undeclared field` |
| RV26 | valibot (no `~standard.jsonSchema`): not adjustable; `kind` left to the check, refused | |
| RV27 | limits: a union member's extra key and a record's keys stay; the top level is stripped | |
| RV28, RV28b | a cookie whose `value` and required attributes each admit one value is filled with them; one with any value (`sid`) is not: the handler's own is kept, and its absence refused | |

What the spike found that changed the design:

- **`variants()`'s discriminant type parameter must not infer from the
  return type.** The call sits where `validate()`'s constraint gives it a
  contextual type, `Discriminant | undefined`, and without `NoInfer` that
  became `B`, so every header of every variant typed as the variant name
  (`set("x-admin", "1")` was refused with `"user"` expected).
- **The variance of the request view.** Matching a declaration as
  `ResponseVariants<T, B, unknown>` failed for a typed `when` (its parameter is
  contravariant), and the whole status fell back to the plain spec; it is
  matched with `infer` instead.
- **zod 4's `z.undefined()` makes an object key required** (`expected
  nonoptional` for an absent header), so "this header must be absent" is
  `z.never().optional()`. That is vendor-specific and easy to get wrong,
  which is why the discriminant's `null` (absent) exists.
- **A `refine` message must be scrubbed against every part**, not the part
  it names: RV9b's message named `headers.x-total` and quoted a body value,
  which passed the scrub until it compared against the whole response.
- **Outside a validator** (`commonResponses`), `when` takes `UntypedValid`
  (every part optional and `unknown`), the default of `variants()`'s `V`.
- **Building issues while matching is the expensive part**: about 2.7 µs per
  failing variant with zod (the vendor's failure path and the core's scrub),
  against about 0.56 µs for the vendor's bare answer. So the matcher asks only
  "does it pass" while matching and builds issues on the refusal path alone
  (`matching.flatten`, `FLATTEN=1` in `bench.sh`, restores the first version).
- **"One value" is read from `~standard.jsonSchema.input()`**: zod 4.6 writes
  `const` for `z.literal()` and `enum: [x]` for a one-member `z.enum()`;
  arktype 2.2 writes `const`; valibot 1.5 carries no `jsonSchema`. zod
  **throws** converting a `z.date()` (unrepresentable) unless passed
  `libraryOptions: { unrepresentable: "any" }`, which the plan builder passes
  (zod then writes `{}`). zod's input JSON Schema has no
  `additionalProperties` for a plain `z.object`, so the strip rule is "keys
  not in `properties`", not JSON Schema's own default.
- **The type side can tell which vendors are fillable**: zod's schema type
  declares `~standard.jsonSchema`, valibot's does not, so `LiteralOptional`
  applies to zod variants only (VT19–VT21).

## Cost

`bench.sh`, each scenario in its own process, pinned to one CPU, three
runs: see `results.txt` (`bench5`, then `bench6` with the adjust rows, at a
higher load) and the plan's §4.4.6. The matcher is a prototype, so read the differences between
rows, not the absolute figures: a V3a status's own check is the gate's, not
this file's `plain` row.
