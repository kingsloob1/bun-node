# Construction step 1: build nothing a request does not need

Interleaved in one process (`ab-sync.ts` pattern: both trees loaded side by
side, 21 rounds × 40k, medians), adapter defaults, against `58d0d97`:

| | before | after | change |
|---|---:|---:|---:|
| `BunRequest.init` + `new BunResponse` | 967 ns | 591 ns | −38.9% |
| served `GET /static` | 2,636 ns | 1,862 ns | −29.4% |
| served `GET /user/42` | 2,688 ns | 1,810 ns | −32.7% |

`wrk` (3 rounds, req/s):

| target | static | param | middleware |
|---|---:|---:|---:|
| bun-common | 32,787 | 33,691 | 31,673 |
| base/bun-common | 30,299 | 30,083 | 30,694 |
| change | +8.2% | +12.0% | +3.2% |
| bun-nest | 20,906 | 19,859 | 18,110 |
| base/bun-nest | 20,913 | 18,551 | 18,706 |

What went: a per-request options copy (`parseQuery` unset in the adapter's
defaults was written as `true` into a private copy), the init-task array
(`ready()` now rebuilds its report from a bitmask), the empty-query object
and the empty-cookie objects (built on first read), `Buffer.alloc(0)` per
bodiless request (one shared zero-length buffer), `originalUrl`'s
concatenation when there is no query or fragment, a second split of the path
in the router (the adapters pass `requestPath`), and repeated
`request.method.toUpperCase()` reads.
