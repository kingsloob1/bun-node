# bun-nest's own suite on Nest 12: what fails, why, and the prototype fixes

The plan's §2.2 headline. bun-nest's test suite passes **427/427 on Nest 11**
(develop's lock: core/common/websockets 11.1.27, platform-express 11.2.7) and
fails **7 of 427 on Nest 12.1.3**, the same 7 on every run and every Bun the
plan tried. Five are Nest 12; two are an artefact of where the measurement
ran. Every claim below was measured in a copy of the repo made by
[`../nest-mirror.sh`](../nest-mirror.sh); the patches are prototypes made in a
second copy, never applied to the repo.

## The runs

| Run | Nest 11 (develop's lock) | Nest 12.1.3 |
|---|---|---|
| bun-nest `bun test --parallel`, unchanged, Bun 1.4.4-canary.1 | 427 pass, 0 fail (the worktree) | **420 pass, 7 fail** ×3 runs |
| same, Bun 1.4.2 (`744846f84`) and 1.4.3 (`c6da4a4d3`) | 425 / 2 (the two artefacts below) | 420 / 7, the same 7 |
| bun-nest with `fix-all.patch`, at a path with no dot segment | 427 / 0 ×4 | 427 / 0 ×3 (a 4th run 426/1: an `@Sse` idle-timeout test, ECONNRESET, then 5/5 alone: a load flake) |
| bun-nest with `fix-all.patch`, under `~/.cache` | 425 / 2 | 425 / 2 (re-run by the plan's author: 425 / 2) |
| bun-common suite with the patch | — | 1572 pass, 0 fail |
| `examples/bun-nest` `bun run-all.ts`, unchanged | 20 passed, 0 skipped, 0 failed | **15 passed, 0 skipped, 5 failed** |
| `examples/bun-nest` with the patch | 20 / 0 / 0 | 20 / 0 / 0 (re-run by the plan's author: 20 / 0 / 0) |
| `bun scripts/typecheck.ts` (17 projects) | clean once the three bench directories are installed | the same: no project fails on 12 that passes on 11 |
| bun-jobs-ui `__tests__/server/nest.nest.test.ts` (its only Nest test) | — | 2 pass, 0 fail, with and without the patch |

bun-jobs imports nothing from `@nestjs/*`; there is nothing of it to run.

## Per failure

### 1–3. A body that is not JSON: `{statusCode, message}` instead of Nest's 400

- Tests: `undecodableBodyOptIn.nest.test.ts:174` (×2, served and `fetch()`),
  and the expressCompat probe "POST /echo — invalid JSON".
  Examples: `02-http-adapter/undecodable-bodies` (2 checks),
  `02-http-adapter/express-parity`, `10-options/jobs-api-module-options`.
- Our side: bun-common builds a `SyntaxError` carrying `status: 400` and
  `expose: true` (`packages/bun-common/lib/BunRequest.ts:3905-3913`); the
  adapter throws it before routing into Nest's error layer
  (`packages/bun-nest/lib/BunHttpAdapter.ts:432-435`).
- Nest: **#15075, `07603b53f`, first in v12.0.0**. Nest 11's core turned a
  `SyntaxError` or `URIError` into `BadRequestException` in
  `RoutesResolver.mapExternalException`; 12 removed that and calls
  `httpAdapter.mapException(err)` instead, whose default in
  `AbstractHttpAdapter` returns the error unchanged. `ExpressAdapter`
  overrides it with the same switch. Our error then matches
  `BaseExceptionFilter.isHttpError`'s http-errors signature (12 made that
  check stricter, #14753 `1c43374d9`, #17709 `788e886ae`, but ours still
  passes it), so Nest answers `{ statusCode, message }`.
- The same change turns an undecodable route param (`/users/%E0%A4%A`) from
  400 into **500** on Nest 12 (the routing differential's D2): bun-common
  raises a `URIError` (`packages/bun-common/lib/BunRouter.ts:144-148`).
- Fix (`fix-1-3-mapException.patch`): `BunHttpAdapter.mapException`, the same
  switch as Express's. No `override` keyword, so it compiles against Nest 11's
  base class, which lacks the method; Nest 11 never calls it. About 1 h with a
  unit test and the now-stale comment at `BunRequest.ts:3905`.

### 4–5. `res.sendFile(abs)` and `res.download`: the measurement's location, not Nest 12

They fail on **Nest 11 too** whenever the repo copy lives under `~/.cache`:
Express's `send` 1.2.1 refuses any path with a dot segment
(`node_modules/send/index.js:458-469`, `:807-810`, `dotfiles: "ignore"`) and
answers 404. In a copy outside dot directories they pass on Nest 12 (the
expressCompat file: 126 pass, 2 fail, and the 2 were failures 3 and 6).

A separate, older gap shows through: when a send is refused, ours answers 404
with an **empty body and no `Content-Type`**
(`packages/bun-common/lib/BunResponse.ts:2889-2896`, `#respondWithStatus` at
`:2813`), where Express passes the error to `next(err)` and Nest's JSON 404
answers. Not a Nest 12 change; listed in the plan's parity debt.

### 6. A miss outside the global prefix: Express 12 answers its own HTML 404

- Test: expressCompat group "prefix", "GET /hello — unprefixed route"
  (`__tests__/expressCompat/probes.ts:393-405`).
- Our side: not-found handlers are global, the prefix ignored
  (`BunHttpAdapter.ts:1302-1307`, run at `:517-528`).
- Nest: #16372 (`33f37d627`, v12.0.0) mounts `ExpressAdapter`'s not-found
  handler under the prefix only, with a `registeredPrefixes` skip for several
  apps on one adapter, and the error handler under the prefix too;
  `e25575536` also mounts the error handler at the root and matches prefixes
  on whole segments; #17648 (`ab64da77f`, v12.0.2) normalises prefixes;
  #17923 (`529152191`, v12.1.3) adds `setNotFoundHandler`'s `excludedRoutes`,
  mounted with `instance.all(path)` per excluded path; #18072 (`b33a98890`)
  URI-versioned exclusions. Nest 11's core already passed the prefix;
  platform-express 11 ignored it.
- Fix (`fix-6-notfound-prefix.patch`, on top of the first): each handler is
  kept with its normalised prefix; on a miss a prefixed handler runs only at
  or under its prefix, an unprefixed one unless the path is under another
  app's prefix; when none applies, finalhandler's `Cannot <M> <path>` page
  (bun-common's `finalErrorResponse` gains an optional `message`); excluded
  paths get `instance.all(path, handler)`. Probed against Express 12 and 11
  with `notfound-probe.ts` on `/hello`, `/apiary`, `/hello?x=1`, `/api`,
  `/api/nope`, `/api/health`, `POST /health` and an escaped path: identical
  on both majors.
- **Version gate needed**, because Nest 11's core also passes the prefix and
  Express 11 ignored it. Detect 12 with
  `typeof AbstractHttpAdapter.prototype.mapException === "function"` (added
  in 12.0.0 with the scoping). Not `excludedRoutes !== undefined`: core passes
  it only from 12.1.3.
- 3–4 h with tests still owed (several apps on one adapter, trailing-slash
  prefix, wildcard and parameterised exclusions, versioned exclusions, HEAD).

### 7. A thrown `WsException` never reaches our `exception` event

- Test: `websocketGatewayBinding.nest.test.ts:132-154`. Examples:
  `10-options/websocket-adapter-options`, `04-websockets/message-formats`.
- Our side: the adapter gives each client an `emit` that writes our wire
  format (`BunWebSocketAdapter.ts:117-121`, `installEmit` at `:632-648`).
- Nest: #16366 (`efe435191`, `bc6b0880f`, v12.0.0). `BaseWsExceptionFilter`
  now calls `emitMessage`, which, for any client with a numeric `readyState`
  and a `send`, writes `client.send(JSON.stringify({ event, data }))`:
  platform-ws's wire shape. Bun's `ServerWebSocket` qualifies, so our `emit`
  is bypassed and the client receives a frame our protocol does not parse.
- Fix (`fix-7-ws-exception.patch`): patch
  `BaseWsExceptionFilter.prototype.emitMessage` once, on the first
  `installEmit`, so a client whose `emit` carries our marker symbol goes
  through our `emit` and every other client through Nest's original. A guarded
  synchronous `require` reaches the optional peer (Bun loads the ESM build
  synchronously). It is a global, marker-scoped monkey-patch, and it covers
  only the `@nestjs/websockets` copy bun-nest resolves. Alternatives are the
  plan's open question Q4. Nest 11 has no `emitMessage`: the patch does
  nothing there. 2–3 h with the decision.

## Files

| File | What |
|---|---|
| `fix-1-3-mapException.patch` | `mapException` on `BunHttpAdapter` |
| `fix-6-notfound-prefix.patch` | prefix- and exclusion-scoped not-found (applies on top of the first) |
| `fix-7-ws-exception.patch` | WsException through our `emit` on Nest 12 |
| `fix-all.patch` | the three together |
| `notfound-probe.ts` | one expressCompat group, one request, both adapters: `cd <repo>/packages/bun-nest && bun notfound-probe.ts <repo> prefix /hello` |

The patches are `diff -ru` between two copies (`repo12/` unchanged,
`repo12f/` patched); `patch -p1 < fix-all.patch` from a copy's root applies
them (`-p1` drops the `repo12/` component).
