import { Buffer } from "node:buffer";
import { writeSync } from "node:fs";

/**
 * The container channel's framing, shared by the runner inside the container
 * (`container-entry.ts`, which writes frames) and the worker outside it
 * (`queue/container/executor.ts`, which reads them). Internal.
 *
 * **Why frames.** The runner's messages share the container's stdout with
 * whatever the processor writes there: its `console.log`, a subprocess, a
 * timer still printing while the result goes out. One `write(2)` to a pipe
 * is kept whole only up to `PIPE_BUF` (4096 bytes on Linux); a longer one can
 * be interleaved with another writer's bytes, and a 2 MiB result written as
 * one line was cut by the processor's own output (measured: lost in 3 runs of
 * 3). So every message is cut into frames that each fit one atomic write: a
 * newline, then `<prefix> <id> <index> <count> <part>`, then a newline. The
 * leading newline puts the frame on a line of its own whatever the processor
 * left unterminated before it; nothing can land inside it.
 *
 * Each frame's part is base64 of a slice of the message's UTF-8 bytes, so a
 * frame is ASCII whatever the message holds, is cut on no character, and
 * costs a fixed size on the wire. The message is never transformed whole:
 * the frames are produced one at a time from one UTF-8 encoding of it, and
 * the worker decodes each into one buffer for the message, grown as its
 * bytes arrive. (Escaping the whole JSON to ASCII first, as an earlier
 * version did, tripled a non-ASCII result in memory and got a
 * 3.6M-character one OOM-killed at the default 256m.)
 */

/** The largest write a pipe keeps whole: `PIPE_BUF` on Linux. */
export const FRAME_BYTES = 4096;

/**
 * The most bytes of a message one frame carries: 2880, which base64 makes
 * 3840 characters, leaving room for the frame's header within
 * {@link FRAME_BYTES}.
 */
export const FRAME_PAYLOAD = 2880;

/**
 * The frames of one message, one at a time, each a complete line with its
 * leading newline, at most {@link FRAME_BYTES} bytes.
 */
export function* encodeFrames(
  /** The channel's line prefix. */
  prefix: string,
  /** The message's id, unique among this runner's messages. */
  id: number,
  /** The message, as JSON. */
  json: string,
): Generator<string> {
  const bytes = Buffer.from(json, "utf8");
  const count = Math.max(1, Math.ceil(bytes.length / FRAME_PAYLOAD));
  const tag = id.toString(36);
  for (let index = 0; index < count; index++) {
    const part = bytes
      .subarray(index * FRAME_PAYLOAD, (index + 1) * FRAME_PAYLOAD)
      .toString("base64");
    yield `\n${prefix} ${tag} ${index} ${count} ${part}\n`;
  }
}

/** How long a full stdout may stay full before the runner gives up on it: 30 s. */
export const WRITE_PATIENCE = 30_000;

/**
 * Writes `text` to file descriptor `fd` in one `write(2)` where the pipe
 * allows, retrying while it is full, so a frame is never split. Blocks the
 * calling thread until it is out — the runner's main thread, which has
 * nothing else to do meanwhile.
 */
export function writeWhole(
  fd: number,
  text: string,
  /** How long a full pipe may stay full before this gives up and throws, in ms. */
  patience = WRITE_PATIENCE,
): void {
  const bytes = Buffer.from(text, "latin1");
  let written = 0;
  let waitedSince: number | undefined;
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written, bytes.length - written);
      waitedSince = undefined;
    } catch (error) {
      if ((error as { code?: string }).code !== "EAGAIN") {
        throw error;
      }
      // The pipe is full: the worker reads it continuously, so wait a
      // moment — but not for ever, if nobody reads it any more.
      waitedSince ??= Date.now();
      if (Date.now() - waitedSince > patience) {
        throw new Error(`stdout stayed full for ${patience} ms`);
      }
      Bun.sleepSync(1);
    }
  }
}

/** What reading one frame line gave. */
export type FrameResult =
  | {
      /** A whole message's JSON, once its last frame has arrived. */
      message: string;
      /**
       * Set when this message's first frame cut off one that never got its
       * last: that one is dropped, and this one is read.
       */
      cutOff?: true;
    }
  | {
      /** The message is larger than the channel takes. */
      tooLarge: number;
    }
  | {
      /** The line was not a frame after all: keep it as output. */
      text: true;
    }
  | {
      /** A frame of a message that was cut off by another one: dropped. */
      broken: true;
    }
  | undefined;

/** The header after the prefix: id, index, count, then the part (base64). */
const HEADER = /^ ([\da-z]{1,10}) (\d{1,9}) (\d{1,9}) ([\w+/=]*)$/;

/** The buffer a message starts with, before any of its bytes arrive. */
const EMPTY = Buffer.alloc(0);

/**
 * Puts a message back together from its frames, as the worker reads them.
 * Frames arrive in order, since one thread writes them; anything that is not
 * a well-formed next frame is reported, never guessed at, and once per
 * message: the frames still to come of a message already dropped are
 * consumed without another report. Each frame is decoded into one buffer for
 * the message, so reassembly holds the message's bytes once, not a list of
 * parts and their join.
 *
 * The buffer grows with what arrives, by doubling, up to what the first
 * frame's count claims — never allocated for the claim up front. A frame
 * costs what it carries: allocating the claim for each first frame let a
 * container printing 50-byte forged ones (`<prefix> <id> 0 5826 `) make the
 * worker allocate 16 MB a line, and stalled its event loop for 14-17 s in
 * an 8 s flood (measured).
 */
export class FrameDecoder {
  /** The message being assembled. */
  #current:
    | {
        /** Its id, as written. */
        id: string;
        /** How many frames its first one said it has. */
        count: number;
        /** The index of the frame expected next. */
        next: number;
        /** Its bytes so far, from 0 to `size`; grows as they arrive. */
        buffer: Buffer;
        /** How many bytes of `buffer` hold the message. */
        size: number;
      }
    | undefined;

  /**
   * The message last dropped, as its id and count: its later frames are
   * consumed quietly, so a message counts once however many frames it had.
   */
  #dropped: { id: string; count: number } | undefined;

  constructor(
    /** The channel's line prefix. */
    private readonly prefix: string,
    /** The largest message accepted, in bytes of its UTF-8 JSON. */
    private readonly maxMessage: number,
  ) {}

  /** Reads one line. Only a line starting with the prefix can be a frame. */
  push(line: string): FrameResult {
    if (!line.startsWith(this.prefix)) {
      return { text: true };
    }
    const header = HEADER.exec(line.slice(this.prefix.length));
    if (!header) {
      // The prefix, but not a frame: the processor printing its own argv,
      // say. Its text, kept as such.
      return { text: true };
    }
    const [, id, indexText, countText, part] = header as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const index = Number(indexText);
    const count = Number(countText);
    if (count < 1 || index >= count || part.length > (FRAME_PAYLOAD / 3) * 4) {
      return { text: true };
    }
    let broken = false;
    if (index === 0) {
      const previous = this.#current;
      broken = previous !== undefined;
      this.#dropped = previous && { id: previous.id, count: previous.count };
      if ((count - 1) * FRAME_PAYLOAD > this.maxMessage) {
        this.#current = undefined;
        this.#dropped = { id, count };
        return { tooLarge: count * FRAME_PAYLOAD };
      }
      this.#current = { id, count, next: 0, buffer: EMPTY, size: 0 };
    }
    const current = this.#current;
    if (
      !current ||
      current.id !== id ||
      current.count !== count ||
      current.next !== index
    ) {
      if (this.#dropped?.id === id && this.#dropped.count === count) {
        // A later frame of the message already dropped: counted then.
        return undefined;
      }
      // This frame's message cannot be read, and neither can the one being
      // assembled, if any. Its later frames are this message's.
      this.#current = undefined;
      this.#dropped = { id, count };
      return { broken: true };
    }
    // Room for this part: it decodes to at most three bytes in four.
    const needed = current.size + Math.ceil((part.length * 3) / 4);
    if (needed > current.buffer.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(
          current.count * FRAME_PAYLOAD,
          Math.max(FRAME_PAYLOAD, current.buffer.length * 2, needed),
        ),
      );
      current.buffer.copy(grown, 0, 0, current.size);
      current.buffer = grown;
    }
    current.size += current.buffer.write(part, current.size, "base64");
    current.next++;
    if (current.next < current.count) {
      return broken ? { broken: true } : undefined;
    }
    this.#current = undefined;
    if (current.size > this.maxMessage) {
      return { tooLarge: current.size };
    }
    const message = current.buffer.toString("utf8", 0, current.size);
    // The message before this one never got its last frame; this one is
    // whole, and is read.
    return broken ? { message, cutOff: true } : { message };
  }
}
