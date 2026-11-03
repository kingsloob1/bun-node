/**
 * Compile-time assertions for the bodies beyond JSON (typed-client plan,
 * `other-transports.md` §3–§4, PR-C9): a route's declared `files`, a
 * download delivered as the call's `as` asks, a streamed body's values, a
 * download's `filename`, and the manifest's `bodyType` and `chunks`.
 * Checked by `bun run check`; every `@ts-expect-error` is a negative
 * control.
 */
import type { Result, RouteManifest } from "../lib/index";
import { createClient } from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface Routes {
  "POST /avatar": {
    body: { caption?: string } | FormData | undefined;
    files: { avatar: Blob; extras?: Blob[] };
    responses: { 201: { ok: boolean } };
  };
  "POST /loose": { responses: { 200: unknown } };
  "GET /report": { responses: { 200: Blob; 404: { code: "NOT_FOUND" } } };
  "GET /lines": {
    responses: { 200: AsyncIterable<{ at: Date; n: number }> };
  };
  "GET /bytes": { responses: { 200: AsyncIterable<Uint8Array> } };
}

const api = createClient<Routes>();

export async function probe(): Promise<void> {
  /* files: typed when declared, any record of blobs otherwise. */
  await api.post("/avatar", {
    files: { avatar: new File([], "a.png"), extras: [new Blob([])] },
  });
  await api.post("/avatar", {
    body: { caption: "x" },
    files: { avatar: new Blob([]) },
  });
  await api.post("/loose", {
    files: { any: new Blob([]), many: [new Blob([])] },
  });
  // @ts-expect-error -- the avatar is required
  await api.post("/avatar", { files: {} });
  await api.post("/avatar", {
    // @ts-expect-error -- a declared route's files are named
    files: { avatar: new Blob([]), other: new Blob([]) },
  });
  await api.post("/avatar", {
    // @ts-expect-error -- extras is a list
    files: { avatar: new Blob([]), extras: new Blob([]) },
  });
  // @ts-expect-error -- a file is a Blob, not a string
  await api.post("/loose", { files: { any: "text" } });

  /* Downloads by kind. */
  const blob = await api.get("/report");
  if (blob.ok) {
    type _blob = Expect<Equal<typeof blob.data, Blob>>;
    type _filename = Expect<Equal<typeof blob.filename, string | undefined>>;
  } else {
    type _problem = Expect<Equal<typeof blob.error, { code: "NOT_FOUND" }>>;
  }
  const stream = await api.get("/report", { as: "stream", throwOnError: true });
  type _stream = Expect<Equal<typeof stream, ReadableStream<Uint8Array>>>;
  const buffer = await api.get("/report", {
    as: "arrayBuffer",
    throwOnError: true,
  });
  type _buffer = Expect<Equal<typeof buffer, ArrayBuffer>>;
  const named = await api.get("/report", { as: "blob", throwOnError: true });
  type _named = Expect<Equal<typeof named, Blob>>;
  // @ts-expect-error -- no such kind
  await api.get("/report", { as: "text" });

  /* Streams: one JSON value per line (after JSON), raw bytes as they are. */
  const lines = await api.get("/lines", { throwOnError: true });
  type _lines = Expect<
    Equal<typeof lines, AsyncIterable<{ at: string; n: number }>>
  >;
  const raw = await api.get("/bytes", { throwOnError: true });
  type _raw = Expect<Equal<typeof raw, AsyncIterable<Uint8Array>>>;
  void [stream, buffer, named, lines, raw];
}

/* A stream's line is its value after JSON, not the stream after JSON. */
type LineData = Extract<Result<Routes["GET /lines"]>, { ok: true }>["data"];
type _lineData = Expect<
  Equal<LineData, AsyncIterable<{ at: string; n: number }>>
>;
type StreamIsJson = Equal<LineData, { at: string; n: number }>;
// @ts-expect-error -- a negative control: the data is the stream, not one line
type _streamIsJson = Expect<StreamIsJson>;

/* The manifest's runtime facts for bodies. */
export const manifest = {
  "POST /avatar": { bodyType: "multipart" },
  "GET /lines": { chunks: { 200: "ndjson" } },
  "GET /bytes": { chunks: { 200: "raw" } },
} as const satisfies RouteManifest<Routes>;
export const _badBodyType = {
  // @ts-expect-error -- not a body type
  "POST /avatar": { bodyType: "xml" },
} as const satisfies RouteManifest<Routes>;
export const _badStatus = {
  // @ts-expect-error -- 201 is not a status of the route
  "GET /lines": { chunks: { 201: "ndjson" } },
} as const satisfies RouteManifest<Routes>;
export const _badFraming = {
  // @ts-expect-error -- not a framing
  "GET /bytes": { chunks: { 200: "sse" } },
} as const satisfies RouteManifest<Routes>;
