# `Bun.serve` accepts a request with two `Host` header lines

| | |
|---|---|
| **Bun** | 1.4.2 to 1.4.5-canary.1 (`862278db7`), Linux x64 |
| **Status** | Filed: [oven-sh/bun#44232](https://github.com/oven-sh/bun/issues/44232) (open; our builds confirmed in comments, 2026-11-07 and 2026-11-16) |
| **Reproduction** | [`duplicate-host-accepted.ts`](./duplicate-host-accepted.ts) (exits 1 while present) |
| **Worked around in** | bun-security's layer L6, `shape.host` (`packages/bun-security/lib/engine/shape.ts`) |

## What happens

An HTTP/1.1 request with two `Host` lines (`Host: a.example` and
`Host: b.example`) reaches the `fetch` handler with `200 OK`. `req.url` is
built from the first line (`http://a.example/`), and
`req.headers.get("host")` is both values joined, `"a.example, b.example"`.

## Why it is a bug

RFC 9112 §3.2: "A server MUST respond with a 400 (Bad Request) status code
to any HTTP/1.1 request message that lacks a Host header field and to any
request message that contains more than one Host header field line or a Host
header field with an invalid field value." Bun already answers `400` for a
missing `Host`. Two `Host` lines are how host-header injection and
virtual-host confusion are attempted: a proxy and the app can each read a
different one.

## How bun-node works around it

bun-security's L6 refuses a request whose `Host` value holds a comma (a valid
`Host` never does), with `400` and rule `shape.host`, on by default.
Covered by `packages/bun-security/__tests__/serve/withSecurity.shape.test.ts`
(T-L6-2, two `Host` lines over a raw socket, with a one-line negative control)
and `__tests__/engine/shape.test.ts`.

Remove the refusal's reason to exist once Bun answers `400` itself, in a
stable release; the check can stay as defence in depth.
