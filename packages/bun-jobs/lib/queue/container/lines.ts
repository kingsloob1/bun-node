/**
 * Splits a byte stream into lines, with a cap on how long one may be.
 *
 * A line past the cap is not buffered: its first bytes are kept so the caller
 * can tell what it was (a channel message or the job's own output), the rest
 * is skipped up to the next newline, and `onOversize` is called once for it.
 * So a container writing an endless line costs the worker the cap, not its
 * memory.
 */
export class LineReader {
  /** The bytes of the line being read, not yet ended by a newline. */
  #parts: Uint8Array[] = [];
  /** How many bytes `#parts` holds. */
  #size = 0;
  /** Set while skipping the rest of an oversize line. */
  #skipping = false;
  /** How many bytes the oversize line had, counted while skipping. */
  #skipped = 0;
  /** The oversize line's first bytes, kept for `onOversize`. */
  #head = "";
  readonly #decoder = new TextDecoder();

  constructor(
    /** The longest line, in bytes, newline excluded. */
    private readonly maxBytes: number,
    /** Called with each whole line, without its newline. */
    private readonly onLine: (line: string) => void,
    /**
     * Called once per line past the cap, when its newline (or the end of the
     * stream) is reached, with its first bytes and its length.
     */
    private readonly onOversize: (head: string, bytes: number) => void,
  ) {}

  /** Feeds one chunk. */
  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      this.#take(chunk.subarray(start, end));
      if (newline === -1) {
        return;
      }
      this.#endLine();
      start = newline + 1;
    }
  }

  /** Ends the stream: a last line without a newline is still delivered. */
  end(): void {
    if (this.#size > 0 || this.#skipping) {
      this.#endLine();
    }
  }

  /** Adds bytes to the current line, switching to skipping past the cap. */
  #take(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    if (this.#skipping) {
      this.#skipped += bytes.length;
      return;
    }
    if (this.#size + bytes.length > this.maxBytes) {
      const kept = this.#concat();
      this.#head = this.#decoder.decode(
        kept.length >= 256
          ? kept.subarray(0, 256)
          : concat(kept, bytes.subarray(0, 256 - kept.length)),
      );
      this.#skipped = this.#size + bytes.length;
      this.#parts = [];
      this.#size = 0;
      this.#skipping = true;
      return;
    }
    this.#parts.push(bytes.slice());
    this.#size += bytes.length;
  }

  /** Delivers the current line, or reports it oversize. */
  #endLine(): void {
    if (this.#skipping) {
      const head = this.#head;
      const bytes = this.#skipped;
      this.#skipping = false;
      this.#skipped = 0;
      this.#head = "";
      this.onOversize(head, bytes);
      return;
    }
    const line = this.#decoder.decode(this.#concat());
    this.#parts = [];
    this.#size = 0;
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  /** The current line's bytes, as one array. */
  #concat(): Uint8Array {
    if (this.#parts.length === 1) {
      return this.#parts[0]!;
    }
    const out = new Uint8Array(this.#size);
    let offset = 0;
    for (const part of this.#parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Two byte arrays, joined. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
