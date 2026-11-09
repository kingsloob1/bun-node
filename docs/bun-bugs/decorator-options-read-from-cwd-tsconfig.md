# `experimentalDecorators` and `emitDecoratorMetadata` are read from the working directory's tsconfig, not the file's

| | |
|---|---|
| **Bun** | 1.4.3-canary.1+bbdc5a519 and 1.4.4-canary.1+11c367163, Linux x64 |
| **Status** | Same root cause as [oven-sh/bun#28605](https://github.com/oven-sh/bun/issues/28605) (`jsxImportSource` from a nested tsconfig), added there as [a comment](https://github.com/oven-sh/bun/issues/28605#issuecomment-6091707278) rather than a duplicate issue. Still open on 2026-11-08. A fix PR, #28606, mentioned decorator settings and was closed unmerged |
| **Reproduction** | [`decorator-options-read-from-cwd-tsconfig.ts`](./decorator-options-read-from-cwd-tsconfig.ts) (exits 1 while present) |
| **Worked around in** | Every bun-nest class that takes injection applies `Module`, `Injectable` and `Inject` by call, with explicit tokens (`lib/throttler/guard.ts`, `lib/cache/BunCacheModule.ts`, `lib/cache/registry.ts`, `lib/devTypesModule.ts`, `lib/validation.ts`, `lib/jobs/registry.ts`, among others). `packages/bun-nest/lib/jobs/bootCheck.ts` turns the symptom in an application's own classes into a `ConfigError`, guarded by `__tests__/jobsModule.nest.test.ts` ("decorator metadata that is off (R3)"). Evidence on Nest: `docs/plans/nest-jobs-decorators/evidence/decorator-config.ts` |

## What happens

One project: a file with a parameter decorator, and a `tsconfig.json` beside it
that enables both options. Run from that directory, the decorator applies and
`design:paramtypes` is emitted. Run the same file by its path from the directory
above, which has no tsconfig, and the parameter decorator silently does nothing
and no metadata is emitted. Nothing is reported.

```
run from the file's own project: { parameterDecorator: true, metadata: true, ... }
run from the directory above:    { parameterDecorator: false, metadata: false, ... }
```

The working directory's tsconfig also decides for a file under `node_modules`
(measured: a package's own tsconfig is ignored either way), so a package shipped
as `.ts` gets whatever its consumer's working directory says.

## Why it is a bug

A tsconfig's options apply to the files it covers, which is how `tsc` reads them
(`bun check` agrees: it uses the nearest tsconfig). Whether a file's decorators
run should not depend on where the process was started. Under NestJS the effect
is `undefined` injected into a provider, with no error at the point of the
mistake.

## What to remove once it is fixed

Wait for a stable Bun release with the fix. Then the by-call style can go where
it has no other reason to stay (it also behaves the same under either decorator
semantics, which `lib/validation.ts` relies on), and so can
`decoratorConfigProblem` and its probe in `lib/jobs/bootCheck.ts`, its fixture
`__tests__/fixtures/jobs-decorators/`, the README's paragraph under "The checks
at boot", and risk R3 in `docs/plans/nest-jobs-decorators/README.md`.
