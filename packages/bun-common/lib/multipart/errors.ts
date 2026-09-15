/**
 * Why an upload was refused — multer's `MulterError` codes, plus the ones
 * bun-common adds.
 *
 * - `LIMIT_PART_COUNT` — busboy `limits.parts` exceeded.
 * - `LIMIT_FILE_SIZE` — a file exceeded busboy `limits.fileSize`.
 * - `LIMIT_FILE_COUNT` — busboy `limits.files` exceeded.
 * - `LIMIT_FIELD_KEY` — a field name exceeded busboy `limits.fieldNameSize`.
 * - `LIMIT_FIELD_VALUE` — a field value exceeded busboy `limits.fieldSize`.
 * - `LIMIT_FIELD_COUNT` — busboy `limits.fields` exceeded.
 * - `LIMIT_UNEXPECTED_FILE` — a file on a field the handler does not accept,
 *   or more files on a field than its `maxCount` (multer uses this code for
 *   both).
 * - `MISSING_FIELD_NAME` — a part arrived without a field name.
 * - `FILTER_REJECTED` — bun-common only: an upload `filter` answered a string.
 */
export type UploadErrorCode =
  | "LIMIT_PART_COUNT"
  | "LIMIT_FILE_SIZE"
  | "LIMIT_FILE_COUNT"
  | "LIMIT_FIELD_KEY"
  | "LIMIT_FIELD_VALUE"
  | "LIMIT_FIELD_COUNT"
  | "LIMIT_UNEXPECTED_FILE"
  | "MISSING_FIELD_NAME"
  | "FILTER_REJECTED";

/** Multer's message for each code, used when no more specific one is given. */
export const UPLOAD_ERROR_MESSAGES: Readonly<Record<UploadErrorCode, string>> =
  {
    LIMIT_PART_COUNT: "Too many parts",
    LIMIT_FILE_SIZE: "File too large",
    LIMIT_FILE_COUNT: "Too many files",
    LIMIT_FIELD_KEY: "Field name too long",
    LIMIT_FIELD_VALUE: "Field value too long",
    LIMIT_FIELD_COUNT: "Too many fields",
    LIMIT_UNEXPECTED_FILE: "Unexpected field",
    MISSING_FIELD_NAME: "Field name missing",
    FILTER_REJECTED: "File rejected by the upload filter",
  };

/** The codes that report a size or count limit, and so answer 413. */
const PAYLOAD_TOO_LARGE_CODES: ReadonlySet<UploadErrorCode> = new Set([
  "LIMIT_PART_COUNT",
  "LIMIT_FILE_SIZE",
  "LIMIT_FILE_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
]);

/** Details for an {@link UploadError}. */
export interface UploadErrorOptions {
  /** The field the failure concerns, when one does. */
  field?: string;
  /**
   * A readable message. Defaults to multer's for the code
   * ({@link UPLOAD_ERROR_MESSAGES}).
   */
  message?: string;
  /** The underlying error, when there is one. */
  cause?: unknown;
}

/**
 * Raised when an upload is refused — bun-common's `MulterError`.
 *
 * Tell failures apart by {@link code}, not by message: the messages are meant
 * for people. `status`/`statusCode` follow `http-errors`: `413` for a size or
 * count limit, `400` for everything else, and `expose` is `true` because the
 * message describes the client's own request.
 */
export class UploadError extends Error {
  /** Why the upload was refused. */
  public readonly code: UploadErrorCode;
  /** The field the failure concerns; `undefined` when it concerns none. */
  public readonly field: string | undefined;
  /** Suggested HTTP status: `413` for size and count limits, else `400`. */
  public readonly status: 400 | 413;
  /** The same as {@link status}, for code reading `statusCode`. */
  public readonly statusCode: 400 | 413;
  /** Whether the message is safe to send to the client. Always `true`. */
  public readonly expose = true as const;

  /**
   * @param code Why the upload was refused; see {@link UploadErrorCode}.
   * @param options The field concerned, a message and a cause; see
   *   {@link UploadErrorOptions}.
   */
  constructor(code: UploadErrorCode, options: UploadErrorOptions = {}) {
    super(
      options.message ?? UPLOAD_ERROR_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "UploadError";
    this.code = code;
    this.field = options.field;
    this.status = PAYLOAD_TOO_LARGE_CODES.has(code) ? 413 : 400;
    this.statusCode = this.status;
  }
}
