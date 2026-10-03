# `console.log` / `Bun.inspect` print an object's non-enumerable properties

| | |
|---|---|
| **Bun** | 1.4.2 (`744846f8`), Linux x64 |
| **Status** | Not filed upstream yet |
| **Reproduction** | [`inspect-shows-non-enumerable-properties.ts`](./inspect-shows-non-enumerable-properties.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-common/lib/utils/native.ts`, `defineHidden` (callers: both adapters' `carryRequest` and body-error path, `BunWebSocket`) |

## What happens

A property defined with `enumerable: false` is printed by `Bun.inspect`, and
therefore by `console.log`/`console.error`, on a plain object or a class
instance. Node's `util.inspect` and `console.log` leave it out (it shows only
with `showHidden: true`). On an `Error`, Bun leaves it out, as Node does.

```
DIFF  plain object     Bun.inspect shows it: true, util.inspect shows it: false
DIFF  class instance   Bun.inspect shows it: true, util.inspect shows it: false
same  Error (control)  Bun.inspect shows it: false, util.inspect shows it: false
```

`node:util`'s own `inspect` under Bun matches Node; only Bun's native
formatter, which `console` uses, differs.

## Why it is a bug

Bun implements Node's `console` for compatibility, and Node's
`console.log(obj)` is `util.inspect(obj)` with `showHidden: false`, which
lists enumerable own properties only. Code that hides a property from logs by
making it non-enumerable — a common Node idiom for back-references and
secrets — leaks it under Bun.

## How bun-node works around it

The adapters attach the request to an unhandled error as `err.req`, so the
error handlers can reach it. Printed in full, a `BunRequest` is hundreds of
lines, and a logger printing the error printed it all. `defineHidden()` now
attaches it non-enumerable. That suffices for every error bun-node creates
(a thrown primitive is wrapped in an `Error`), since Bun hides
non-enumerable properties of an `Error`. It does **not** hide `req` on a
plain object a handler throws (`throw { status: 400 }`): that object is passed
to the handlers as thrown, so `req` rides on it and Bun's `console` prints
it. Covered by `__tests__/bodyParseErrors.test.ts` ("does not print the
request riding on the error").

**When it is fixed** (the reproduction exits 0 on the Bun version
`engines.bun` names), nothing needs removing; drop the plain-object caveat
from `defineHidden`'s JSDoc and this report.
