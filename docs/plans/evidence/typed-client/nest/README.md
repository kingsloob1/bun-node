# Nest controllers → the same route model, at runtime

```bash
cd docs/plans/evidence/typed-client/nest && bun explore.ts && ../../../../../node_modules/.bin/tsc -p .
```

**Run it from this directory**: Bun reads `experimentalDecorators` and
`emitDecoratorMetadata` from the working directory's `tsconfig.json`
(oven-sh/bun#28605). Backs `../../../nest-typed-routes.md`. Bun 1.4.3,
@nestjs/core 11.1.27, 2026-10-10.

`explore.ts` builds a Nest app on bun-nest's `BunHttpAdapter` with a global
prefix, a `@TypedRoute({ params, query, body, responses })` decorator (stores
the schemas with `SetMetadata` and constrains the method's return type), a
controller documented only with `@nestjs/swagger`-shaped metadata
(`swagger/apiResponse`, set by hand: installing `@nestjs/swagger` here would
duplicate the root's `@nestjs/core`), and a dev-only `DevTypesModule` whose
`forRoot` refuses production and whose controller sits behind a guard. A
`TypedRoutesExplorer` walks `DiscoveryService.getControllers()` with
`MetadataScanner`, reads `PATH_METADATA`/`METHOD_METADATA`, joins
`ApplicationConfig.getGlobalPrefix()`, converts the schemas with the same
helpers as `../codegen/describe.ts`, and emits `nest-routes.gen.ts` with the
same emitter.

## Results (`results.txt`)

```
explored 6 routes in 8.72 ms, hash 1b1503131d867aa0
  GET /api/__bun/types               devtypes.model     no @TypedRoute or swagger metadata: untyped
  GET /api/health                    health.ok          from @nestjs/swagger metadata: responses only
  GET /api/users                     users.list
  GET /api/users/:id                 users.one
  GET /api/users/untyped/legacy      users.legacy       no @TypedRoute or swagger metadata: untyped
  POST /api/users                    users.create
registered on the adapter: 6; explored keys missing from it: none
dev endpoint: no token 403, token 200 (etag "1b1503131d867aa0"), if-none-match 304
production: REFUSED: DevTypesModule: refused under NODE_ENV=production
tsc clean
```

- Every explored key matches a route the adapter actually registered
  (`adapter.getInstance().routes()`), global prefix included.
- `client-check.ts` drives the same flat client from the Nest-generated map;
  `explore-types.ts` is the return-type negative control.
- The guard answers **403** (a guard's denial is Nest's `ForbiddenException`);
  the plan's guard throws `NotFoundException` instead, so the endpoint's
  existence is not confirmed. The dev endpoint should also hide itself from
  the model (it lists itself here).
- Not covered: versioning (`enableVersioning`), `RouterModule` prefixes,
  `@Version`, host-scoped controllers. The plan computes those with Nest's
  own path factory [I].
