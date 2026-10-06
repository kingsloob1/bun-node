/**
 * busboy's multipart parse over a body that is already in memory, which is
 * how {@link BunRequest.getMultiParts} always has it: no stream machinery,
 * a native `Buffer.indexOf` for the boundary, and the header block of a part
 * as clients send it read by one regex.
 *
 * It answers exactly what busboy would, and nothing it is unsure of: a body
 * with anything unusual — a limit reached, junk after a boundary, a malformed
 * or oversized header block, a truncated body — answers `undefined`, and the
 * caller runs busboy instead, so busboy's errors and limit events are kept.
 * Parameter and charset decoding are busboy's own helpers. A differential
 * fuzz against busboy (`__tests__/multipartBuffered.test.ts`) holds it to
 * that.
 *
 * Measured against busboy fed the same buffer: about 5× faster on a small
 * upload or a 50-field form, 6× on a 1 MiB file, and faster than Bun's native
 * `Request.formData()` on every shape measured, which answers differently
 * anyway (see `docs/plans/research-trailing-scenarios.md` §7).
 */
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

/** The helpers busboy's own parser uses, from `busboy/lib/utils.js`. */
interface BusboyUtils {
  /** A file name's last path segment; `""` for `.` and `..`. */
  basename: (path: string) => string;
  /** Bytes decoded with a charset busboy knows; `undefined` for one it does not. */
  convertToUTF8: (
    data: Buffer,
    charset: string,
    hint: number,
  ) => string | undefined;
  /** The decoder for a parameter charset (`defParamCharset`). */
  getDecoder: (
    charset: string,
  ) => (value: string, hint: number) => string | undefined;
  /** A parsed `Content-Type`, or `undefined` when malformed. */
  parseContentType: (str: string) =>
    | {
        /** The lower-cased type. */
        type: string;
        /** The lower-cased subtype. */
        subtype: string;
        /** Its parameters, keys lower-cased. */
        params: Record<string, string>;
      }
    | undefined;
  /** A parsed `Content-Disposition`, or `undefined` when malformed. */
  parseDisposition: (
    str: string,
    decoder: (value: string, hint: number) => string | undefined,
  ) =>
    | {
        /** The lower-cased disposition type. */
        type: string;
        /** Its parameters, keys lower-cased. */
        params: Record<string, string>;
      }
    | undefined;
}

// busboy has no `exports` map, so its own helpers are reachable; reusing them
// keeps parameter and charset decoding identical by construction.
const utils = createRequire(import.meta.url)(
  "busboy/lib/utils.js",
) as BusboyUtils;

/** The busboy options the buffered parse honours, as busboy reads them. */
export interface BufferedMultipartConfig {
  /** busboy's limits; reaching any of them hands the body to busboy. */
  limits?: {
    /** Max field value size in bytes (busboy's default: 1 MiB). */
    fieldSize?: number;
    /** Max file size in bytes. */
    fileSize?: number;
    /** Max number of files. */
    files?: number;
    /** Max number of fields. */
    fields?: number;
    /** Max number of parts. */
    parts?: number;
  };
  /** Charset for a field without one of its own; busboy's default `utf8`. */
  defCharset?: string;
  /** Charset for `Content-Disposition` parameters; none (latin1 bytes) by default. */
  defParamCharset?: string;
  /** Keep a file name's path instead of its last segment. */
  preservePath?: boolean;
}

/** A field, as busboy's `field` event reports it. */
export interface BufferedMultipartField {
  /** Marks a field. */
  kind: "field";
  /** The part's `name`, or `undefined` without one. */
  name: string | undefined;
  /** The decoded value; `undefined` for a charset busboy cannot decode. */
  value: string | undefined;
  /** busboy's field info: never truncated here (that hands off to busboy). */
  info: {
    /** Always `false`, as in busboy. */
    nameTruncated: false;
    /** Always `false`: a truncated value is busboy's to report. */
    valueTruncated: false;
    /** The part's `Content-Transfer-Encoding`, lower-cased; `7bit` without one. */
    encoding: string;
    /** The part's type; `text/plain` without one. */
    mimeType: string;
  };
}

/** A file, as busboy's `file` event reports it, with its bytes collected. */
export interface BufferedMultipartFile {
  /** Marks a file. */
  kind: "file";
  /** The part's `name`, or `undefined` without one. */
  name: string | undefined;
  /**
   * The file's bytes: a view of the body, not a copy (busboy's concatenated
   * chunks are a copy). The bytes are the same; writing into them writes into
   * the request's body too, as with a `File` from Bun's `formData()`.
   */
  data: Buffer;
  /** busboy's file info. */
  info: {
    /** The file name (`filename*` over `filename`), its path stripped unless `preservePath`. */
    filename: string | undefined;
    /** The part's `Content-Transfer-Encoding`, lower-cased; `7bit` without one. */
    encoding: string;
    /** The part's type; `text/plain` without one. */
    mimeType: string;
  };
}

/** One part, in body order. */
export type BufferedMultipartPart =
  | BufferedMultipartField
  | BufferedMultipartFile;

const MAX_HEADER_PAIRS = 2000;
const MAX_HEADER_SIZE = 16 * 1024;
const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

/** busboy's default parameter decoder: the header's latin1 string as it is. */
function nullDecoder(value: string): string {
  return value;
}

// busboy's TOKEN, FIELD_VCHAR and QDTEXT tables as regex classes, over the
// latin1 string of a header block (one char per byte).
const TOKEN = "!#$%&'*+\\-.^`|~\\w";
const FIELD_VCHAR = "\\t\\x20-\\x7e\\x80-\\xff";
/** FIELD_VCHAR without space and tab: where busboy starts a value. */
const FIELD_VCHAR_START = "\\x21-\\x7e\\x80-\\xff";
const QDTEXT = "\\t\\x20\\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff";

/**
 * One header line, folded continuations included, as busboy accepts it. The
 * value opens on its first character that is not space or tab (busboy skips
 * those, then reads the rest as it is), so the whitespace and the value
 * cannot trade characters: no backtracking on a long run of blanks.
 */
const HEADER_LINE = new RegExp(
  `([${TOKEN}]+):[ \\t]*((?:[${FIELD_VCHAR_START}][${FIELD_VCHAR}]*)?(?:\\r\\n[ \\t][${FIELD_VCHAR}]*)*)\\r\\n`,
  "y",
);

/** The disposition clients send, read without busboy's char-by-char parser. */
const SIMPLE_DISPOSITION = new RegExp(
  `^form-data; name="([${QDTEXT}]*)"(?:; filename="([${QDTEXT}]*)")?$`,
);

/**
 * A part's whole header block as clients send it: a form-data disposition
 * with a name (and a filename), and at most a parameterless `Content-Type`.
 * Header names and the disposition type compare without case, as busboy
 * lowercases them. Anything else takes the generic path.
 */
const COMMON_BLOCK = new RegExp(
  `content-disposition:[ \\t]*form-data; name="([${QDTEXT}]*)"(?:; filename="([${QDTEXT}]*)")?\\r\\n(?:content-type:[ \\t]*([${TOKEN}]+)/([${TOKEN}]+)\\r\\n)?\\r\\n`,
  "iy",
);

/** The largest header block read as the common one. */
const COMMON_BLOCK_WINDOW = 1024;

/**
 * The `Content-Type` clients send, `multipart/form-data; boundary=<token>`,
 * read without busboy's char-by-char parser: the same answer for this shape
 * (type and parameter name without case, an unquoted token value). Not a
 * cache keyed by the header, since a browser draws a new boundary per form.
 */
const SIMPLE_CONTENT_TYPE =
  /^multipart\/form-data[ \t]*;[ \t]*boundary=([!#$%&'*+\-.^`|~\w]+)[ \t]*$/i;

/**
 * The body's boundary as busboy reads it, or `undefined` when busboy would
 * not parse it as `multipart/form-data`.
 */
function boundaryFor(contentType: string): string | undefined {
  const simple = SIMPLE_CONTENT_TYPE.exec(contentType);
  if (simple !== null) {
    return simple[1];
  }
  const conType = utils.parseContentType(contentType);
  return conType &&
    conType.type === "multipart" &&
    conType.subtype === "form-data" &&
    typeof conType.params?.boundary === "string"
    ? conType.params.boundary
    : undefined;
}

/** Each boundary's search needle, as busboy builds it (`\r\n--` + boundary, UTF-8). */
const NEEDLES = new Map<string, Buffer>();

function needleFor(boundary: string): Buffer {
  let needle = NEEDLES.get(boundary);
  if (needle === undefined) {
    needle = Buffer.from(`\r\n--${boundary}`);
    if (NEEDLES.size >= 256) {
      NEEDLES.clear();
    }
    NEEDLES.set(boundary, needle);
  }
  return needle;
}

/**
 * busboy's header parser over one header block ending before `end`: the
 * position after the block's blank line, or -1 for anything busboy might
 * answer differently (malformed, near its size or pair caps, unterminated).
 */
function parseHeaderBlock(
  body: Buffer,
  start: number,
  end: number,
  out: Record<string, string[]>,
): number {
  const blockEnd = body.indexOf(CRLFCRLF, start);
  if (
    blockEnd === -1 ||
    blockEnd + 4 > end ||
    // Short of busboy's own cap, so a block near it goes to busboy.
    blockEnd + 4 - start > MAX_HEADER_SIZE - 16
  ) {
    return -1;
  }
  // The block with its last header's CRLF; the blank line ends it.
  const block = body.toString("latin1", start, blockEnd + 2);
  HEADER_LINE.lastIndex = 0;
  let pairs = 0;
  while (HEADER_LINE.lastIndex < block.length) {
    const at = HEADER_LINE.lastIndex;
    const match = HEADER_LINE.exec(block);
    if (match === null || match.index !== at || ++pairs >= MAX_HEADER_PAIRS) {
      return -1;
    }
    const raw = match[2];
    // A folded value continues from the whitespace, without the CRLF.
    const value = raw.includes("\r\n") ? raw.replaceAll("\r\n", "") : raw;
    (out[match[1].toLowerCase()] ??= []).push(value);
  }
  // busboy refuses an empty block as malformed.
  return pairs === 0 ? -1 : blockEnd + 4;
}

/** busboy's `parseDisposition`, with the common shape read by one regex. */
function parseDisposition(
  value: string,
  decoder: (value: string, hint: number) => string | undefined,
): ReturnType<BusboyUtils["parseDisposition"]> {
  const simple = SIMPLE_DISPOSITION.exec(value);
  if (simple === null) {
    return utils.parseDisposition(value, decoder);
  }
  const params: Record<string, string> = Object.create(null);
  const name = decoder(simple[1], 2);
  if (name === undefined) {
    return undefined;
  }
  params.name = name;
  if (simple[2] !== undefined) {
    const filename = decoder(simple[2], 2);
    if (filename === undefined) {
      return undefined;
    }
    params.filename = filename;
  }
  return { type: "form-data", params };
}

/**
 * Parses a whole `multipart/form-data` body as busboy would, or answers
 * `undefined` when busboy should (see the module documentation).
 *
 * @param body The whole body.
 * @param contentType The request's `Content-Type`, boundary included.
 * @param config The busboy options in force.
 */
export function parseBufferedMultipart(
  body: Buffer,
  contentType: string,
  config: BufferedMultipartConfig = {},
): BufferedMultipartPart[] | undefined {
  const boundary = boundaryFor(contentType);
  if (boundary === undefined) {
    return undefined;
  }

  const paramDecoder = config.defParamCharset
    ? utils.getDecoder(config.defParamCharset)
    : nullDecoder;
  const defCharset = config.defCharset || "utf8";
  const limits = config.limits;
  const fieldSizeLimit =
    typeof limits?.fieldSize === "number" ? limits.fieldSize : 1024 * 1024;
  const fileSizeLimit =
    typeof limits?.fileSize === "number" ? limits.fileSize : Infinity;
  const filesLimit =
    typeof limits?.files === "number" ? limits.files : Infinity;
  const fieldsLimit =
    typeof limits?.fields === "number" ? limits.fields : Infinity;
  const partsLimit =
    typeof limits?.parts === "number" ? limits.parts : Infinity;

  const needle = needleFor(boundary);
  const length = body.length;
  // busboy writes CRLF ahead of the body, so a body opening with the
  // boundary itself matches there.
  let matchEnd: number;
  if (
    length >= needle.length - 2 &&
    body.compare(needle, 2, needle.length, 0, needle.length - 2) === 0
  ) {
    matchEnd = needle.length - 2;
  } else {
    const at = body.indexOf(needle);
    if (at === -1) {
      return undefined;
    }
    matchEnd = at + needle.length;
  }

  const parts: BufferedMultipartPart[] = [];
  // busboy's part count after the first boundary, and its partsLimit check.
  let partCount = 0;
  if (partCount === partsLimit) {
    return undefined;
  }
  let files = 0;
  let fields = 0;
  while (true) {
    // After a boundary: `--` ends the form, CRLF opens a part; anything else
    // (or a body ending here) is busboy's to report.
    if (matchEnd + 1 >= length) {
      return undefined;
    }
    const first = body[matchEnd];
    const second = body[matchEnd + 1];
    if (first === 45 && second === 45) {
      // The epilogue after the closing boundary is ignored, as in busboy.
      return parts;
    }
    if (first !== 13 || second !== 10) {
      return undefined;
    }
    const headerStart = matchEnd + 2;
    const next = body.indexOf(needle, headerStart);
    if (next === -1) {
      return undefined;
    }

    let partType = "text/plain";
    let partCharset = defCharset;
    let partEncoding = "7bit";
    let partName: string | undefined;
    let filename: string | undefined;
    let skip = false;
    let contentStart: number;

    // The common block is read from its own bytes alone: up to the first
    // blank line, which nothing inside it can contain.
    const blockEnd = body.indexOf(CRLFCRLF, headerStart);
    let common: RegExpExecArray | null = null;
    if (
      blockEnd !== -1 &&
      blockEnd + 4 <= next &&
      blockEnd + 4 - headerStart <= COMMON_BLOCK_WINDOW
    ) {
      const block = body.toString("latin1", headerStart, blockEnd + 4);
      COMMON_BLOCK.lastIndex = 0;
      common = COMMON_BLOCK.exec(block);
      if (common !== null && COMMON_BLOCK.lastIndex !== block.length) {
        common = null;
      }
    }
    if (common !== null) {
      contentStart = headerStart + COMMON_BLOCK.lastIndex;
      const name = paramDecoder(common[1], 2);
      const rawFilename = common[2];
      const decodedFilename =
        rawFilename === undefined ? undefined : paramDecoder(rawFilename, 2);
      if (
        name === undefined ||
        (rawFilename !== undefined && decodedFilename === undefined)
      ) {
        // busboy's parseDisposition answers nothing: the part is skipped.
        skip = true;
      } else {
        if (name) {
          partName = name;
        }
        if (decodedFilename) {
          filename = config.preservePath
            ? decodedFilename
            : utils.basename(decodedFilename);
        }
        if (common[3] !== undefined) {
          partType = `${common[3].toLowerCase()}/${common[4].toLowerCase()}`;
        }
      }
    } else {
      const header: Record<string, string[]> = Object.create(null);
      contentStart = parseHeaderBlock(body, headerStart, next, header);
      if (contentStart === -1) {
        return undefined;
      }
      const disposition = header["content-disposition"];
      const disp = disposition
        ? parseDisposition(disposition[0], paramDecoder)
        : undefined;
      if (!disp || disp.type !== "form-data") {
        skip = true;
      } else {
        if (disp.params) {
          if (disp.params.name) {
            partName = disp.params.name;
          }
          if (disp.params["filename*"]) {
            filename = disp.params["filename*"];
          } else if (disp.params.filename) {
            filename = disp.params.filename;
          }
          if (filename !== undefined && !config.preservePath) {
            filename = utils.basename(filename);
          }
        }
        const type = header["content-type"];
        if (type) {
          const parsed = utils.parseContentType(type[0]);
          if (parsed) {
            partType = `${parsed.type}/${parsed.subtype}`;
            if (parsed.params && typeof parsed.params.charset === "string") {
              partCharset = parsed.params.charset.toLowerCase();
            }
          }
        }
        const transferEncoding = header["content-transfer-encoding"];
        if (transferEncoding) {
          partEncoding = transferEncoding[0].toLowerCase();
        }
      }
    }

    if (!skip) {
      const size = next - contentStart;
      if (partType === "application/octet-stream" || filename !== undefined) {
        // busboy reports `limit` once a file reaches the cap, even exactly.
        if (files === filesLimit || size >= fileSizeLimit) {
          return undefined;
        }
        ++files;
        parts.push({
          kind: "file",
          name: partName,
          data: body.subarray(contentStart, next),
          info: { filename, encoding: partEncoding, mimeType: partType },
        });
      } else {
        // A value reaching the cap is truncated by busboy.
        if (fields === fieldsLimit || size >= fieldSizeLimit) {
          return undefined;
        }
        ++fields;
        parts.push({
          kind: "field",
          name: partName,
          value:
            size === 0
              ? ""
              : partCharset === "utf8" || partCharset === "utf-8"
                ? body.toString("utf8", contentStart, next)
                : utils.convertToUTF8(
                    body.subarray(contentStart, next),
                    partCharset,
                    0,
                  ),
          info: {
            nameTruncated: false,
            valueTruncated: false,
            encoding: partEncoding,
            mimeType: partType,
          },
        });
      }
    }
    if (++partCount === partsLimit) {
      return undefined;
    }
    matchEnd = next + needle.length;
  }
}
