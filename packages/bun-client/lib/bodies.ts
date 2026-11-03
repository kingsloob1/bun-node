/**
 * Bodies beyond JSON (typed-client plan, `other-transports.md` §3, §4,
 * PR-C9): a multipart body built from typed fields and files, a download
 * delivered as the call's `as` asks, and a streamed response read as an
 * `AsyncIterable`, NDJSON line by line or raw chunk by chunk.
 *
 * **Loaded lazily**, as `./validation` is: `client.ts` imports this module
 * with `import()` only when a call sends files or a multipart body, or a
 * response is a download or streams, so a JSON-only app loads none of it
 * and a splitting bundler puts it in its own chunk
 * (`__tests__/budget.test.ts`).
 *
 * Nothing here imports a Bun or Node API: it is browser code.
 */
/** A file as a call gives it: one, or several for one field. */
export type FilesInput = Readonly<Record<string, Blob | readonly Blob[]>>;

/**
 * A `Blob` as a `File` with a name: a `File` with a name as it is, anything
 * else a `File` of the same bytes and type named `"blob"`. So a check sees a
 * `File` (zod's `z.file()`), and the part goes out with a file name: Bun
 * serialises a nameless `Blob` with `filename=""` where the spec says
 * `"blob"`, and busboy then reads a typed one as a text field
 * (oven-sh/bun#35439, still present on 1.4.4-canary.1+11c367163;
 * `docs/bun-bugs/formdata-blob-empty-filename.md`). Remove the renaming
 * once a stable Bun names it.
 */
export function asFile(blob: Blob): File {
  if (typeof File !== "undefined" && blob instanceof File && blob.name)
    return blob;
  return new File([blob], "blob", { type: blob.type });
}

/** A call's `files` with every `Blob` a named `File` ({@link asFile}); `undefined` and `null` entries dropped. */
export function normaliseFiles(
  files: FilesInput,
): Record<string, File | File[]> {
  const out: Record<string, File | File[]> = {};
  for (const [name, value] of Object.entries(files)) {
    if (value === undefined || value === null) continue;
    out[name] = Array.isArray(value)
      ? (value as readonly Blob[]).filter((file) => file != null).map(asFile)
      : asFile(value as Blob);
  }
  return out;
}

/**
 * A multipart body: the fields as bun-common's parser reads them back (the
 * query serialiser's pairs, handed over by the client so this chunk shares
 * no module with the entry: nested objects with dots, arrays of scalars
 * repeated), then each file under its field, a list repeated.
 *
 * @param fields The body's fields as `[name, value]` pairs.
 * @param files  The files, already {@link normaliseFiles normalised}.
 */
export function formDataOf(
  fields: readonly (readonly [string, string])[],
  files: Readonly<Record<string, File | readonly File[]>> | undefined,
): FormData {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  for (const [name, value] of Object.entries(files ?? {})) {
    for (const file of Array.isArray(value) ? value : [value as File])
      form.append(name, file, file.name);
  }
  return form;
}

/** Reads a response body chunk by chunk; the reader is released (and the body cancelled) when iteration stops early. */
async function* chunksOf(
  response: Response,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A raw streamed body (`chunks()` with `framing: "raw"`): its bytes as they
 * arrive, one `Uint8Array` per chunk the platform delivers. Nothing is
 * checked (as on the server, a raw chunk's schema sees bytes).
 */
export function rawChunks(response: Response): AsyncIterable<Uint8Array> {
  return chunksOf(response);
}

/**
 * A streamed body as the call's `data` (`other-transports.md` §4): raw
 * chunks, or NDJSON values checked line by line, a line that is not JSON
 * ending the iteration with a `ClientError` naming it.
 *
 * @param response    The response, its body unread.
 * @param framing     How the body is cut.
 * @param check       Each NDJSON line's check; `undefined` for none.
 * @param key         The route key, for the error.
 * @param ClientError The client's error class, handed over so this chunk
 *                    shares no module with the entry.
 */
export function streamed(
  response: Response,
  framing: "ndjson" | "raw",
  check: LineCheck | undefined,
  key: string,
  ClientError: ClientErrorClass,
): AsyncIterable<unknown> {
  return framing === "raw"
    ? rawChunks(response)
    : ndjsonValues(
        response,
        check,
        (line, cause) =>
          new ClientError(
            `${key} answered ${response.status} with line ${line} that is not JSON`,
            { key, cause },
          ),
      );
}

/** What {@link ndjsonValues} checks each line with: the value to deliver, or a throw. */
export type LineCheck = (value: unknown) => Promise<unknown>;

/**
 * An NDJSON body (`chunks()` with `framing: "ndjson"`), one value per line,
 * as bun-common frames it: lines split across chunk boundaries, a trailing
 * `\r` dropped, blank lines skipped, the last line checked when the stream
 * ends without its `\n`. Each line is parsed and handed to `check` (the
 * status's response checks, under the call's failure mode), and what it
 * returns is yielded. A line that is not JSON ends the iteration with a
 * `ClientError`.
 *
 * @param response The response, its body unread.
 * @param check    Each line's check; `undefined` delivers lines unchecked.
 * @param fail     Builds the error for a line that is not JSON (`line` from 1).
 */
export async function* ndjsonValues(
  response: Response,
  check: LineCheck | undefined,
  fail: (line: number, cause: unknown) => Error,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder();
  let buffered = "";
  let line = 0;
  const parse = async (
    text: string,
  ): Promise<{ value: unknown } | undefined> => {
    const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
    line++;
    if (trimmed.trim() === "") return undefined;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw fail(line, error);
    }
    return { value: check === undefined ? value : await check(value) };
  };
  for await (const chunk of chunksOf(response)) {
    buffered += decoder.decode(chunk, { stream: true });
    let end = buffered.indexOf("\n");
    while (end !== -1) {
      const parsed = await parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (parsed !== undefined) yield parsed.value;
      end = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") {
    const parsed = await parse(buffered);
    if (parsed !== undefined) yield parsed.value;
  }
}

/**
 * The file name a `Content-Disposition` header gives: `filename*` (RFC
 * 5987, percent-decoded) first, then `filename`, quoted or not; `undefined`
 * for none.
 */
export function filenameOf(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=[^']*'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A malformed encoding: fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header);
  const name = (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim();
  return name || undefined;
}

/** A body read: its value, whether it is left unread, and a download's file name. */
export interface ReadBody {
  /** What `data` or `error` holds. */
  readonly value: unknown;
  /** The body is left unread (a stream to iterate or read): no whole-body check runs on it. */
  readonly unread?: boolean;
  /** The download's file name, from `Content-Disposition`. */
  readonly filename?: string;
}

/** An NDJSON media type: `application/x-ndjson`, `application/ndjson`, `application/jsonl`, `application/jsonlines`. */
function isNdjsonType(type: string): boolean {
  return /^application\/(?:x-)?(?:nd-?json|jsonl|jsonlines)\b/i.test(type);
}

/**
 * A body the client does not read as JSON or text: a streamed one
 * (`framing`, from the manifest's `chunks`, or an NDJSON media type) as an
 * `AsyncIterable` ({@link streamed}), anything else as a {@link download}.
 *
 * @param response    The response, its body unread.
 * @param as          The call's `as`.
 * @param framing     The status's framing, when the manifest declares one.
 * @param check       Each NDJSON line's check; `undefined` for none.
 * @param key         The route key, for errors.
 * @param ClientError The client's error class (see {@link streamed}).
 */
export async function read(
  response: Response,
  as: "blob" | "stream" | "arrayBuffer" | undefined,
  framing: "ndjson" | "raw" | undefined,
  check: LineCheck | undefined,
  key: string,
  ClientError: ClientErrorClass,
): Promise<ReadBody> {
  const cut =
    framing ??
    (isNdjsonType(response.headers.get("content-type") ?? "")
      ? "ndjson"
      : undefined);
  return cut === undefined
    ? download(response, as)
    : {
        value: streamed(response, cut, check, key, ClientError),
        unread: true,
      };
}

/** The client's `ClientError` constructor, as this module calls it. */
type ClientErrorClass = new (
  message: string,
  options: { key: string; cause: unknown },
) => Error;

/**
 * A download (a body neither JSON nor text), delivered as `as` asks
 * (`other-transports.md` §4): a `Blob` (a `File` carrying the
 * `Content-Disposition` file name, when the header gives one), the unread
 * stream, or an `ArrayBuffer`.
 */
export async function download(
  response: Response,
  as: "blob" | "stream" | "arrayBuffer" | undefined,
): Promise<ReadBody> {
  const filename = filenameOf(response.headers.get("content-disposition"));
  const named = filename === undefined ? {} : { filename };
  if (as === "stream")
    return {
      value: response.body ?? new Blob([]).stream(),
      unread: true,
      ...named,
    };
  if (as === "arrayBuffer")
    return { value: await response.arrayBuffer(), ...named };
  const blob = await response.blob();
  return {
    value:
      filename === undefined || typeof File === "undefined"
        ? blob
        : new File([blob], filename, { type: blob.type }),
    ...named,
  };
}
