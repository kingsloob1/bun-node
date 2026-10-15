# Bun bug, filed as [oven-sh/bun#45330](https://github.com/oven-sh/bun/issues/45330): `fetch()` drops the first `/` of a request target that starts with `//`

Found by the routing differential (its `//a//b` probes had to move to a raw
TCP socket). Reduced here to a single file with none of our code. **Filed** 2026-10-15 as
[oven-sh/bun#45330](https://github.com/oven-sh/bun/issues/45330), after a
fresh search found nothing matching.

## Reproduction [M]

[`repro.mjs`](repro.mjs): a raw `node:net` server records the request line a
`fetch("http://127.0.0.1:<port>//a//b?x=1")` sends. Exits 1 while the bug is
present.

| Runtime | Request line sent | Exit |
|---|---|---|
| Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) | `GET /a//b?x=1 HTTP/1.1` | 1 |
| Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) | `GET /a//b?x=1 HTTP/1.1` | 1 |
| Bun 1.4.4-canary.1 (`7583003d82122bbfa5e06dcd688d8c2d1533fa22`) | `GET /a//b?x=1 HTTP/1.1` | 1 |
| Node 24.2.0 (undici) | `GET //a//b?x=1 HTTP/1.1` | 0 |

In every runtime `new URL(url).pathname` is `//a//b`: the URL parser is
right, the HTTP client rewrites the target. Platform:
`Linux 7.0.0-38-generic x86_64`.

```bash
bun repro.mjs; echo $?    # 1
node repro.mjs; echo $?   # 0
```

## Existing issues searched (2026-10-15)

`gh search issues --repo oven-sh/bun` with "fetch double slash path",
"fetch leading double slash", "fetch strips slash", "double slash request
path fetch", "fetch // pathname", "fetch removes leading slash", "fetch
duplicate slashes url", "double slash", "double slashes", "request-target
fetch", "fetch normalizes path", "fetch url path slash", "multiple slashes",
"fetch pathname slash", "undici double slash", "\"//\" fetch", "path starting
with //", "protocol-relative path fetch", "fetch collapses", "leading
slashes", "fetch sends wrong path", "http client path normalization", and the
REST search `repo:oven-sh/bun "double slash"` (63 results). Nothing matches;
the nearest are #44176 (`Bun.serve` routes: raw request-target against a
normalised `req.url`, server side) and #17363 (trailing slashes on static
routes). Raw output: [`search-results.txt`](search-results.txt). Search
again before filing.

## Draft issue (template `2-bug-report.yml`)

**Title:** `fetch()` sends `/a//b` for a URL whose pathname is `//a//b`

- **What version of Bun is running?** `1.4.3+c6da4a4d3` (also 1.4.2+744846f84
  and 1.4.4-canary.1+7583003d8)
- **What platform is your computer?** `Linux 7.0.0-38-generic x86_64 unknown`
- **What steps can reproduce the bug?** The contents of `repro.mjs`, then
  `bun repro.mjs`.
- **What is the expected behavior?** The request line carries the URL's
  pathname unchanged, `GET //a//b?x=1 HTTP/1.1`, as Node's `fetch` sends it and
  as `new URL(url).pathname` (`//a//b`) says.
- **What do you see instead?** `GET /a//b?x=1 HTTP/1.1`: the first of the two
  leading slashes is dropped.
- **Additional information:** A server cannot tell `//a//b` from `/a//b`
  when the client is Bun's `fetch`, so tests of path normalisation written
  with `fetch` pass or fail for the wrong reason.

## What it means for us

Nothing in our packages depends on it. It matters to tests: a parity test
that sends a path starting with `//` through Bun's `fetch` does not send what
it says. The routing differential uses a raw socket for those paths; the
permanent routing parity test (plan §9.2) must too, with a comment naming the
issue, oven-sh/bun#45330.
