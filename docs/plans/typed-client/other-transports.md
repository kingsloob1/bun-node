# Typed client: the "etc." — RPC, uploads, downloads, streams, gRPC

A sub-plan of [`README.md`](README.md) (**TC**). The user's list ended in
"etc."; this document takes each remaining kind of request and says in or
out, with why.

Written 2026-11-02 against `develop` at `e80ab379`. **No product code was
changed.** Markings as in TC.

**Status (2026-11-03): approved by the user** (TC §14, Q26; names as in
TC §16). **Built**: the named-operation proxy (§2, in PR-C1) and **PR-C9**
(§3, §4, and bun-common's `RouteDoc.request.files`; TC's Status row says
what and which new names await approval). Upload progress over XHR stays
later, on demand.

---

## 1. Verdicts

| Kind | Verdict | Where |
|---|---|---|
| tRPC-style RPC (call an operation by name) | **in**, as a thin proxy over the HTTP map | §2 |
| Form and multipart uploads | **in**: typed `FormData` from the body declaration; upload progress **later** | §3 |
| File downloads | **in**: typed by the declared media type (`opaque()`), returned as `Blob` or a stream | §4 |
| Streaming bodies (NDJSON, chunked) | **in**: typed async iteration, checked per chunk | §4 |
| Streaming request bodies | **in**, as a pass-through | §4 |
| gRPC, Connect, gRPC-Web | **out** | §5 |
| JSON-RPC 2.0 | **out** (no server in bun-node speaks it) | §5 |

---

## 2. Named operations (tRPC-style) [D]

`api.op.getUser({ params })` is the same call as
`api.get("/users/:id", { params })`, found by `operationId`. Every route in
the model has one: `.describe({ operationId })`, the property name in
`defineRoutes()` (`bun-common/lib/defineRoutes.ts:197`, where the name
becomes the `operationId`), or the generator's derived one
(`bun-common/lib/docs/openapi.ts` `operationId` option) [S].

- It is a **proxy over the same map**, so it adds no type cost beyond one
  mapped type from `operationId` to key, and no runtime beyond a lookup
  table the generator writes [D].
- What tRPC adds beyond naming (procedures without HTTP paths, batching,
  its own wire format) is not proposed: the server here is HTTP-first, and
  its routes already have names.
- Was "later, optional" in the old TC §6.1; **in PR-C1** now, since
  `defineRoutes` (#534) made operation names the norm for the registry.

## 3. Uploads [D]

- **What exists** [S]: bun-common parses `multipart/form-data` and
  `application/x-www-form-urlencoded` into `req.body`
  (`bun-common/lib/BunRequest.ts:125-147`) and files through the multipart
  system (`lib/multipart/`); `validate({ body })` checks the parsed fields;
  files are not a validation target (`BunValidate.ts:56-57`: params, query,
  body, headers, cookies, signedCookies). An HTTP body may be declared per
  media type (`MediaMap`, `contract/model.ts:53-56`) [S].
- **The client**: a route whose body is declared for `multipart/form-data`
  (or urlencoded) takes `body` as a typed object of its fields, plus
  `files: { [field]: Blob | File | (Blob | File)[] }` typed from the route's
  documented file fields, and builds the `FormData` (or
  `URLSearchParams`) itself. A plain `FormData` passes through untyped, as
  now (TC §6.1).
- **Documenting file fields** needs a declaration the server has not got:
  OpenAPI's `format: binary` per field. Proposed: `.describe({ request: {
  files: { avatar: { maxBytes, mediaTypes } } } })` documents them (a
  `RouteDoc.request` field; `docs/routeDoc.ts:81-101` [S] holds the request
  docs today) and the multipart middleware's limits stay the enforcement
  [D]. Until then a file field is typed `Blob | File` from the OpenAPI
  `format: binary` when a hand-written document says so.
- **Validation**: the fields are checked by the body's built-in and BYO
  schemas before the `FormData` is built; files are checked for presence,
  count, `maxBytes` and media type only (content is the server's).
- **Upload progress is later**: `fetch` reports none [V, MDN]; streaming a
  request body (`duplex: "half"`) works in Chromium and Bun but not Firefox
  or Safari [V]; the portable way is `XMLHttpRequest`'s `upload.onprogress`.
  A `transport: "xhr"` per call, with `onUploadProgress`, is a small later
  PR (~1 d) if asked.

## 4. Downloads and streams [D]

The response declaration already says what kind of body a status has
(`ContractKind`: `value`, `chunks`, `sse`, `opaque`; `contract/model.ts:95`)
and its media type [S]. The client maps each:

| Declared | Result `data` | Validation |
|---|---|---|
| a JSON schema (`value`) | the parsed JSON, typed (TC §4.4) | TC §5 |
| `opaque("application/pdf")` | `Blob` by default; `as: "stream"` gives the `ReadableStream`, `as: "arrayBuffer"` an `ArrayBuffer` | status, headers and media type only (as the server) |
| `chunks(S, { framing: "ndjson" })` | an `AsyncIterable<Jsonify<…>>`, one value per line | each line, built-in and BYO, under TC §5.5 |
| `chunks(S)` (raw) | an `AsyncIterable<Uint8Array>` | none |
| `sse({ … })` | `sse(api, …)` ([`sse.md`](sse.md)) | per event |
| a `text/*` schema | `string` | the schema |

- **Downloads to a file** are the platform's (a `Blob` URL in a browser,
  `Bun.write` in Bun); the client adds `filename` from
  `Content-Disposition` to the result [D].
- **Streaming request bodies**: a `ReadableStream` body passes through with
  `duplex: "half"` set; typed only as a stream [D].
- **Range requests and resumable downloads**: out; bun-common answers ranges
  (`rangeParser`), and an app can send `Range` as a header.

## 5. Out: gRPC, Connect, gRPC-Web, JSON-RPC [D]

- **Nothing in bun-node speaks them** [S: no dependency, no transport; the
  only gRPC in the code is a made-up transport in the contract core's test
  fixtures, `bun-common/__tests__/contract/fixtures.ts:127-135`].
- **gRPC** needs HTTP/2 trailers end to end, and a browser cannot speak it
  without gRPC-Web and a proxy [V]. **Connect** works over HTTP/1.1 with
  JSON, but its types come from Protobuf: a second schema language,
  `protoc`/`buf` codegen and `@bufbuild/protobuf` at runtime, which is the
  dependency policy's opposite.
- **The door stays open**: the contract core is transport-agnostic by
  design (`defineTransport`, `contract/transport.ts:184`) [S], so a gRPC
  transport could be declared later, and a client for it would follow the
  same rules. Not planned.
- **JSON-RPC 2.0** over HTTP or WebSocket is a channel with one message
  type and an id: an app wanting it can declare it as a channel today
  ([`websocket.md`](websocket.md) gives it typing and request/response).

## 6. PRs and effort

| PR | What | Effort |
|---|---|---|
| in PR-C1 | the named-operation proxy | +0.5 d |
| **PR-C9** bodies | typed multipart/urlencoded bodies and files; downloads by kind (`Blob`, stream, `ArrayBuffer`, `filename`); NDJSON and raw chunk iteration with per-chunk checks; streaming request bodies | ~2.5 d |
| bun-common, with PR-C9 | `RouteDoc.request.files` documented as `format: binary` | ~0.5 d |
| *later, on demand* | upload progress over XHR | ~1 d |

Questions: answered 2026-11-02 (TC §14 Q26, approved as recommended). Names: TC §16, approved 2026-11-02.
