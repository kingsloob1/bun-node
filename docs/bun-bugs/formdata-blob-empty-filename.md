# A `Blob` appended to `FormData` without a name is sent as `filename=""`

| | |
|---|---|
| **Bun** | 1.4.4-canary.1 (`11c367163`), Linux x64 |
| **Status** | Filed upstream before us: [oven-sh/bun#35439](https://github.com/oven-sh/bun/issues/35439) (divergence 1 of 5; also #14725, #22762); still present on 1.4.4-canary.1+11c367163, where its divergence 5 is fixed ([our comment](https://github.com/oven-sh/bun/issues/35439#issuecomment-6596845696), 2026-11-03) |
| **Reproduction** | [`formdata-blob-empty-filename.ts`](./formdata-blob-empty-filename.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-client/lib/bodies.ts`, `asFile` |

## What happens

`form.append(name, blob)` with a `Blob` that is not a `File` stores an entry
whose `name` is `undefined` and serialises the part as

```
Content-Disposition: form-data; name="file"; filename=""
```

Appended with an explicit name (`form.append(name, blob, "blob")`), the part
carries `filename="blob"`.

## Why it is a bug

The WHATWG XHR standard's "create an entry" step names a `Blob` value that is
not a `File` `"blob"` when no file name is given. With `filename=""`, busboy
(bun-common's multipart parser) reads a part whose type is not
`application/octet-stream` as a text **field**, not a file: a typed `Blob`
uploaded by a client vanishes from the files (measured:
`packages/bun-client/__tests__/bodies.test.ts`, "control: appended bare, a
typed Blob reaches busboy as a field").

## How bun-node works around it

bun-client's multipart builder turns every `Blob` that is not a named `File`
into `new File([blob], "blob", { type })` before it is checked and appended,
and appends it with its name (`asFile`, `normaliseFiles`). Covered by
`__tests__/bodies.test.ts` ("a Blob goes out named \"blob\""); removing the
renaming fails it.

A related divergence of the same issue (3): Bun's `Blob` constructor adds
`;charset=utf-8` to a `text/*` type, so a `text/csv` file's `type` is
`text/csv;charset=utf-8`, and an exact media-type check (zod's `z.mime`) of
such a file fails under Bun, not in a browser. Not worked around.

## Once it is fixed

Re-run the reproduction; when it exits 0 on a **stable** Bun, drop the
renaming in `asFile` (a `File` with a name stays as it is) and this entry.
