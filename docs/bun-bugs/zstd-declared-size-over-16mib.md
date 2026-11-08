# `Bun.zstdDecompressSync` ignores a declared `Frame_Content_Size` above 16 MiB, and allocates the whole content before failing

| | |
|---|---|
| **Bun** | 1.4.2, 1.4.3, 1.4.4-canary.1+11c367163, Linux x64 |
| **Status** | Filed as [oven-sh/bun#48215](https://github.com/oven-sh/bun/issues/48215) (2026-11-08). The related no-size case is [oven-sh/bun#28162](https://github.com/oven-sh/bun/issues/28162) (no output limit) |
| **Reproduction** | [`zstd-declared-size-over-16mib.ts`](./zstd-declared-size-over-16mib.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-cache/lib/core/decompress.ts`: `nativeBound` and `NATIVE_LIMIT` (the native zstd decoder runs only on a payload whose frames all declare their size, the total at most 16 MiB and at most the cap; everything else goes to node:zlib with `maxOutputLength`) |

## What happens

A zstd frame that declares its `Frame_Content_Size` but holds more than
that. When the declared size is at most 16 MiB, `Bun.zstdDecompressSync`
refuses the frame without allocating. Above 16 MiB it decodes and allocates
the frame's **whole** real content, and only then throws. Each input below is
8 KiB of RLE blocks (RFC 8878 §3.1.1); each case runs in a process of its
own:

```
declares 20 MiB, holds 256 MiB: input 8 KiB -> threw Decompression failed: ZstdDecompressionError, RSS +385 MiB
declares 15 MiB, holds 256 MiB: input 8 KiB -> threw Decompression failed: DecompressionFailed, RSS +16 MiB
declares nothing, holds 256 MiB (#28162): input 8 KiB -> decoded 256 MiB, RSS +345 MiB
```

## Why it is a bug

RFC 8878 §3.1.1.1.4: `Frame_Content_Size` is "the original (uncompressed)
size", and a decoder that finds more content than declared has a corrupt
frame. Bun already refuses one at 16 MiB and below, in a buffer of the
declared size; above it, it streams into a growing buffer with no limit, so a
declared size gives no protection and a few KiB of input can allocate
hundreds of MiB.

## How bun-node works around it

bun-cache reads entries anyone with write access to the store could have
planted, so decompression is bounded by the cache's entry limit. The native
decoder runs only on a payload whose own bytes prove it decodes to at most
the cap and to at most 16 MiB (`nativeBound`, `NATIVE_LIMIT`): every frame
declares its size, and the declared total fits both. Anything else, a frame
that declares no size (#28162) or more than 16 MiB, goes to node:zlib's
`zstdDecompressSync` with `maxOutputLength`, which stops at the cap. Covered by
`packages/bun-cache/__tests__/core/decompress.test.ts`.

**When it is fixed** (the reproduction exits 0 on the Bun version
`engines.bun` requires), `NATIVE_LIMIT` can rise for a payload whose frames
all declare their size. The node:zlib path stays for frames that declare none
until #28162 gives `Bun.zstdDecompressSync` an output limit.
