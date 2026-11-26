# CommonJS packages imported from an ES module are evaluated out of order

| | |
|---|---|
| **Bun** | 1.4.5-canary.1 (`862278db7`) and 1.4.3 (`c6da4a4d3`), Linux x64 |
| **Status** | Filed: [oven-sh/bun#49614](https://github.com/oven-sh/bun/issues/49614) (2026-11-26) |
| **Reproduction** | [`cjs-imports-evaluated-out-of-order.ts`](./cjs-imports-evaluated-out-of-order.ts) (exits 1 while present) |
| **Worked around in** | `examples/bun-nest/07-validation/standard-validation.ts`, and bun-nest's `__tests__/validationGateway.nest.test.ts` and `validationGatewayPipes.nest.test.ts` |

## What happens

An ES module imports two CommonJS packages, `import "big"; import "small";`.
The first package is large (about 5 MB here), and both `require()` a third.
Bun evaluates `small` first, then `shared`, then `big`, in every run. With a
smaller first package (3,000 lines instead of 60,000) the order varies from
run to run: 19 of 20 runs were wrong. Without the shared dependency the order
is kept.

## Why it is a bug

ES module imports are evaluated in source order (ECMA-262, module
evaluation, `InnerModuleEvaluation` over `[[RequestedModules]]` in order).
Node keeps it for CommonJS packages imported this way: `big then shared then
small`. A package whose evaluation order matters, such as one that enters a
`require` cycle from one end only, breaks under Bun at random.

## How bun-node met it, and works around it

On Nest 11.2.10 and later, `@nestjs/websockets/socket-module` requires
`./adapters/ws-adapter`, which requires `@nestjs/core`, whose
`nest-application` requires `socket-module` back.
- Evaluated from `@nestjs/core`'s end, the cycle is harmless.
- Evaluated from `socket-module`'s end, either imported directly or through
  `@nestjs/microservices`' `nest-microservice`, `nest-application` reads
  `SocketModule` off the partially evaluated module as `undefined`. The
  application then registers no WebSocket gateway, and an upgrade answers 404.

`examples/bun-nest/07-validation/standard-validation.ts` imported
`@nestjs/core`, `@nestjs/microservices` and `socket-module` statically. It
failed on Nest 11.2.12 in 7 of 15 runs (0 of 15 on 12.4.2, which has no such
cycle). bun-nest's two gateway validation tests, which import `socket-module`
statically, failed 5 of 8 and 2 of 8 runs.

The example now loads `socket-module` and `@nestjs/microservices` with
`await import()`, and the two tests load `socket-module` with
`createRequire()` in the module's body. Both run only once every static
import, `@nestjs/core` among them, has been evaluated. Measured on 11.2.12:
0 of 20 runs failed for the example, and 0 of 10 for each test.

An application that statically imports `@nestjs/microservices` or
`@nestjs/websockets/socket-module` beside `@nestjs/core` on Nest 11.2.10 and
later can meet the same thing under Bun.

## Once it is fixed

The workarounds can go back to static imports: re-run the example and the
two tests in the Nest 11.2.12 column (`scripts/nest-matrix.ts`) several times.
