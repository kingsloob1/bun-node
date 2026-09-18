/**
 * JSON parsing that says *where* it failed. `JSON.parse` does the parsing;
 * only when it throws does a small scanner walk the text to find the
 * offending position, because engines disagree on whether (and how) their
 * messages carry one — JavaScriptCore's carry none at all.
 */

/** Where and why a JSON text failed to parse. */
export interface JsonParseError {
  /** What is wrong, e.g. "Expected ',' or '}'". */
  message: string;
  /** 1-based line. */
  line: number;
  /** 1-based column (in UTF-16 code units). */
  column: number;
  /** 0-based offset into the text. */
  offset: number;
}

/** The outcome of {@link parseJsonText}. */
export type JsonParseResult =
  | {
      /** It parsed. */
      ok: true;
      /** The parsed value. */
      value: unknown;
    }
  | {
      /** It did not parse. */
      ok: false;
      /** Where and why. */
      error: JsonParseError;
    };

/** Thrown inside the scanner with the failing offset. */
class ScanError extends Error {
  /** 0-based offset. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** Describes the character at `index` for a message. */
function describe(text: string, index: number): string {
  return index >= text.length
    ? "end of input"
    : `'${text[index] === "\n" ? "\\n" : text[index]}'`;
}

/**
 * Walks `text` as JSON (RFC 8259) and throws a {@link ScanError} at the
 * first position that is not valid. Returns normally for valid JSON.
 */
function scan(text: string): void {
  let index = 0;

  const skipWhitespace = () => {
    while (
      index < text.length &&
      (text[index] === " " ||
        text[index] === "\t" ||
        text[index] === "\n" ||
        text[index] === "\r")
    ) {
      index++;
    }
  };

  const fail = (expected: string): never => {
    throw new ScanError(
      `Expected ${expected} but found ${describe(text, index)}`,
      index,
    );
  };

  const literal = (word: string) => {
    for (let i = 0; i < word.length; i++) {
      if (text[index] !== word[i]) {
        fail(`'${word}'`);
      }
      index++;
    }
  };

  const string = () => {
    index++; // opening quote
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') {
        index++;
        return;
      }
      if (char === "\\") {
        const next = text[index + 1];
        if (next === "u") {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(index + 2, index + 6))) {
            index += 2;
            fail("four hex digits after \\u");
          }
          index += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) {
          index++;
          fail("a valid escape");
        }
        index += 2;
        continue;
      }
      if (char < " ") {
        throw new ScanError(
          "Control characters must be escaped in strings",
          index,
        );
      }
      index++;
    }
    throw new ScanError("Unterminated string", index);
  };

  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(
      text.slice(index, index + 400),
    );
    if (!match) {
      fail("a number");
    }
    index += match![0].length;
  };

  const value = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index++;
      skipWhitespace();
      if (text[index] === "}") {
        index++;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') {
          fail("a property name in double quotes");
        }
        string();
        skipWhitespace();
        if (text[index] !== ":") {
          fail("':'");
        }
        index++;
        value();
        skipWhitespace();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "}") {
          index++;
          return;
        }
        fail("',' or '}'");
      }
    }
    if (char === "[") {
      index++;
      skipWhitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      for (;;) {
        value();
        skipWhitespace();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "]") {
          index++;
          return;
        }
        fail("',' or ']'");
      }
    }
    if (char === '"') {
      string();
      return;
    }
    if (char === "t") {
      literal("true");
      return;
    }
    if (char === "f") {
      literal("false");
      return;
    }
    if (char === "n") {
      literal("null");
      return;
    }
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      number();
      return;
    }
    fail("a value");
  };

  value();
  skipWhitespace();
  if (index < text.length) {
    fail("end of input");
  }
}

/** 1-based line and column of an offset. */
export function lineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/** Parses JSON; on failure, reports the message with its line and column. */
export function parseJsonText(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (caught) {
    let message = caught instanceof Error ? caught.message : String(caught);
    let offset = 0;
    try {
      scan(text);
      // The scanner accepted what JSON.parse refused (should not happen);
      // keep the engine's message without a position.
    } catch (scanned) {
      if (scanned instanceof ScanError) {
        message = scanned.message;
        offset = scanned.offset;
      }
    }
    return {
      ok: false,
      error: { message, offset, ...lineColumn(text, offset) },
    };
  }
}

/** The UTF-8 size of a text, in bytes (what the API measures against its limits). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Formats a byte count: `512 B`, `1.5 KiB`, `2.0 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The editor's state, as `JsonEditor` reports it on every change. */
export interface JsonEditorState {
  /** The raw text. */
  text: string;
  /** The parsed value; `undefined` when the text does not parse (or is empty). */
  value: unknown;
  /** Whether the text parses (or is empty and `allowEmpty`) and fits `maxBytes`. The one flag a submit button needs. */
  valid: boolean;
  /** The parse error with its line and column, or `null`. */
  error: JsonParseError | null;
  /** The text's UTF-8 size. */
  bytes: number;
  /** Whether `bytes` exceeds `maxBytes`. */
  overLimit: boolean;
}

/** Options of {@link jsonEditorState}. */
export interface JsonEditorStateOptions {
  /** The size limit, bytes. */
  maxBytes?: number;
  /** Whether empty (whitespace-only) text is valid, as `undefined`. Defaults to `false`. */
  allowEmpty?: boolean;
}

/**
 * Works out a {@link JsonEditorState} from text, e.g. to seed a form's
 * validity before the first edit.
 */
export function jsonEditorState(
  text: string,
  { maxBytes, allowEmpty = false }: JsonEditorStateOptions = {},
): JsonEditorState {
  const bytes = byteLength(text);
  const overLimit = maxBytes !== undefined && bytes > maxBytes;
  if (allowEmpty && text.trim() === "") {
    return {
      text,
      value: undefined,
      valid: !overLimit,
      error: null,
      bytes,
      overLimit,
    };
  }
  const parsed = parseJsonText(text);
  return parsed.ok
    ? {
        text,
        value: parsed.value,
        valid: !overLimit,
        error: null,
        bytes,
        overLimit,
      }
    : {
        text,
        value: undefined,
        valid: false,
        error: parsed.error,
        bytes,
        overLimit,
      };
}
