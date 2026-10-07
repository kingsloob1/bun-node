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
 * The JSON is made pure ASCII first (`\uXXXX` escapes), so a frame is cut
 * on a character boundary by construction and its bytes are its characters.
 */

/** The largest write a pipe keeps whole: `PIPE_BUF` on Linux. */
export const FRAME_BYTES = 4096;

/** The most characters of a message one frame carries, leaving room for its header. */
export const FRAME_PAYLOAD = FRAME_BYTES - 96;

/** A JSON text with every non-ASCII character escaped: same value, ASCII only. */
export function asciiJson(json: string): string {
  // Anything outside printable ASCII (space to tilde): what JSON.stringify
  // leaves unescaped there is only DEL and non-ASCII text.
  return json.replace(
    /[^\x20-\x7E]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The frames of one message, each a complete line with its leading newline,
 * at most {@link FRAME_BYTES} bytes.
 */
export function encodeFrames(
  /** The channel's line prefix. */
  prefix: string,
  /** The message's id, unique among this runner's messages. */
  id: number,
  /** The message, as JSON. */
  json: string,
): string[] {
  const ascii = asciiJson(json);
  const count = Math.max(1, Math.ceil(ascii.length / FRAME_PAYLOAD));
  const tag = id.toString(36);
  const frames: string[] = [];
  for (let index = 0; index < count; index++) {
    const part = ascii.slice(
      index * FRAME_PAYLOAD,
      (index + 1) * FRAME_PAYLOAD,
    );
    frames.push(`\n${prefix} ${tag} ${index} ${count} ${part}\n`);
  }
  return frames;
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

/** The header after the prefix: id, index, count, then the part. */
const HEADER = /^ ([\da-z]{1,10}) (\d{1,9}) (\d{1,9}) (.*)$/s;

/**
 * Puts a message back together from its frames, as the worker reads them.
 * Frames arrive in order, since one thread writes them; anything that is not
 * a well-formed next frame is reported, never guessed at.
 */
export class FrameDecoder {
  /** The message being assembled. */
  #current: { id: string; count: number; parts: string[] } | undefined;

  constructor(
    /** The channel's line prefix. */
    private readonly prefix: string,
    /** The largest message accepted, in characters of its ASCII JSON. */
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
    if (count < 1 || index >= count) {
      return { text: true };
    }
    if (index === 0) {
      const broken = this.#current !== undefined;
      if (count * FRAME_PAYLOAD > this.maxMessage + FRAME_PAYLOAD) {
        this.#current = undefined;
        return { tooLarge: count * FRAME_PAYLOAD };
      }
      this.#current = { id, count, parts: [part] };
      if (broken) {
        // The message before this one never got its last frame.
        return count === 1 ? this.#finish() : { broken: true };
      }
    } else {
      const current = this.#current;
      if (
        !current ||
        current.id !== id ||
        current.count !== count ||
        current.parts.length !== index
      ) {
        this.#current = undefined;
        return { broken: true };
      }
      current.parts.push(part);
    }
    return this.#current!.parts.length === this.#current!.count
      ? this.#finish()
      : undefined;
  }

  /** The finished message, and a clean slate. */
  #finish(): FrameResult {
    const message = this.#current!.parts.join("");
    this.#current = undefined;
    return { message };
  }
}
