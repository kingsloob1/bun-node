# `Bun.gunzipSync` decodes only a gzip payload's first member, and ignores what follows

| | |
|---|---|
| **Bun** | 1.4.2 (`744846f8`), 1.4.3 (`c6da4a4d`), 1.4.4-canary.1+11c367163, Linux x64 |
| **Status** | Filed as [oven-sh/bun#47341](https://github.com/oven-sh/bun/issues/47341) (2026-10-29; no earlier issue found) |
| **Reproduction** | [`gunzip-sync-reads-first-member-only.ts`](./gunzip-sync-reads-first-member-only.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-cache/lib/core/decompress.ts`, `decodeNative` (the ISIZE check) |

## What happens

Given two gzip members back to back, `Bun.gunzipSync` returns the first
member's content and drops the second. Given one member followed by bytes
that are not gzip at all, it returns the member's content and raises
nothing. `node:zlib`'s `gunzipSync`, in Bun as in Node, decodes both members
of the first input and throws on the second.

```
DIFF  two members (RFC 1952 §2.2)
      Bun.gunzipSync    "hello "
      zlib.gunzipSync   "hello world"
DIFF  one member, then 3 garbage bytes
      Bun.gunzipSync    "hello "
      zlib.gunzipSync   throws: incorrect header check
```

## Why it is a bug

RFC 1952 §2.2: "A gzip file consists of a series of 'members' (compressed
data sets)", and `gunzip` decodes them all, as Node's zlib, Python's
`gzip.decompress` and Go's `gzip.Reader` (multistream by default) do. Bun's
answer loses data silently: nothing tells the caller that bytes were left
over. `Bun.gunzipSync` reads the trailer of the member it decoded and stops
there (`gunzip_or_inflate_sync` in `src/runtime/api/BunObject.rs` reads to
the first `Z_STREAM_END`). [S]

## How bun-node works around it

bun-cache decodes a small gzip entry with `Bun.gunzipSync` when its length
proves the output fits the entry limit (the decompression cap). This cache
writes one member, but an entry planted in the store, or written by another
program, may hold more. So after a native decode the output's length is held
to the payload's last four bytes, the ISIZE of its last member (RFC 1952
§2.3.1): when they differ, the payload is decoded again with `node:zlib`, whose
answer is the one the cache always gave. Covered by
`packages/bun-cache/__tests__/core/decompress.test.ts` ("a gzip payload of two
members, or with bytes after its member, reads as node:zlib reads it"). A
crafted payload whose last member records the first member's size still reads
as its first member alone; only an attacker who can already write any value
to the store can make one.

**When it is fixed** (the reproduction exits 0 on the Bun version
`engines.bun` requires), the ISIZE check after `Bun.gunzipSync` can go. The
check before it stays: it keeps Bun from reserving an attacker's ISIZE.
