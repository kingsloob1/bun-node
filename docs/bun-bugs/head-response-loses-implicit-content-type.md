# A served HEAD response loses the implicit `Content-Type` its GET gets

| | |
|---|---|
| **Bun** | 1.4.2 (`744846f8`), Linux x64 |
| **Status** | Not filed upstream yet |
| **Reproduction** | [`head-response-loses-implicit-content-type.ts`](./head-response-loses-implicit-content-type.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-common/lib/BunResponse.ts`, `#canSkipHeaders` |

## What happens

A `Response` built from a string with no `headers` is written by `Bun.serve`
with `Content-Type: text/plain;charset=utf-8` for `GET`. The same `Response`
returned for a `HEAD` request is written with **no** `Content-Type` at all.
`Content-Length` is correct in both. A `Content-Type` set explicitly is kept
for both methods.

```
DIFF  new Response(string)
      GET  content-type: text/plain;charset=utf-8
      HEAD content-type: (none)
DIFF  new Response(string, { status: 201 })
      GET  content-type: text/plain;charset=utf-8
      HEAD content-type: (none)
same  explicit Content-Type (control)
      GET  content-type: text/plain
      HEAD content-type: text/plain
```

## Why it is a bug

RFC 9110 §9.3.2: a server SHOULD send the same header fields in response to
`HEAD` as it would to `GET`, except that the content is not sent. A client
probing with `HEAD` (link checkers, caches, download managers) sees a
different media type from the one `GET` returns.

The cause is presumably that Bun derives the implicit type while writing the
body, which `HEAD` skips (see the companion report,
[`response-headers-miss-body-content-type.md`](./response-headers-miss-body-content-type.md):
the type is not in `response.headers` either). [I]

## How bun-node works around it

`BunResponse` sends a text body with no `Headers` object when no header was
set, which halves the cost of `res.send()`. That relies on Bun writing the
type, so a `HEAD` request is excluded from that path and carries its type
explicitly. Covered by `__tests__/responseNoHeaders.test.ts` ("answers HEAD
with the headers and no body, served and through fetch()").

**When it is fixed** (the reproduction exits 0 on the Bun version
`engines.bun` requires), the `this.req.method !== "HEAD"` condition in
`#canSkipHeaders` can go, and the test above stays as the guard.
