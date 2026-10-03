# `new Response(string).headers` has no `Content-Type`

| | |
|---|---|
| **Bun** | 1.4.2 (`744846f8`), Linux x64 |
| **Status** | Not filed upstream yet |
| **Reproduction** | [`response-headers-miss-body-content-type.ts`](./response-headers-miss-body-content-type.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-common/lib/BunResponse.ts`, `toFetchResponse` (used by every socket-free `fetch()`) |

## What happens

The Fetch standard's Response and Request constructors "extract a body", and
when the body has a type and no `Content-Type` was given, they append the
body's type to the headers. For a string that is
`text/plain;charset=UTF-8`. Bun does this for `URLSearchParams`, a typed
`Blob` and `Response.json`, but **not for a string**, in a `Response` or a
`Request`:

```
DIFF  string: (none)  (standard: text/plain;charset=utf-8)
ok    URLSearchParams: application/x-www-form-urlencoded;charset=UTF-8
ok    Blob with a type: text/csv
DIFF  Request with a string body: (none)  (standard: text/plain;charset=utf-8)
ok    Response.json (control): application/json;charset=utf-8
```

`Bun.serve` still writes `text/plain;charset=utf-8` on the wire for `GET`, so
a served client sees it. Code that reads the `Response` object does not: a
socket-free test, a middleware or proxy inspecting `response.headers`, or a
`Request` forwarded to a server that relies on the header.

## How bun-node works around it

bun-common's socket-free `fetch()` (router and both adapters) promises the
same answer a served request gets. A text response sent without a `Headers`
object (see the HEAD report) is recorded, and `toFetchResponse()` adds the
type Bun would write. `res.getHeader("Content-Type")` reports it as well.
Covered by `__tests__/responseNoHeaders.test.ts` ("answers each path the same
way over a socket and through fetch()").

**When it is fixed**, `toFetchResponse`'s `Content-Type` step becomes a no-op
(it only adds the header when missing), so nothing breaks; it can then be
removed.
