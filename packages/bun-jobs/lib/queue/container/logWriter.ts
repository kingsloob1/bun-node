/** The longest entry a batch of lines is joined into, in characters: 64 KiB. */
export const LOG_BATCH_CHARS = 64 * 1024;

/**
 * Writes a container attempt's own output to its job's log, one write at a
 * time. Internal.
 *
 * A container's stdout and stderr arrive as lines, and a processor printing
 * one character per line produces hundreds of thousands of them. Writing each
 * as it came — `void job.log(line)` — put every one of them in flight at once
 * (measured: 513,146 concurrent `addJobLog` calls and +760 MB for 600,000
 * one-character lines). Here at most one write is in flight per attempt;
 * the lines that arrive meanwhile wait, and are written together as one log
 * entry, joined by newlines and cut into entries of at most
 * {@link LOG_BATCH_CHARS} characters. What waits is bounded upstream: the
 * target's `maxLogBytes` caps an attempt's output before it reaches here.
 */
export class AttemptLogWriter {
  /** The lines waiting for the write in flight to finish. */
  #queued: string[] = [];
  /** The write loop, while it runs. */
  #pumping: Promise<void> | undefined;
  /** The most writes ever in flight at once: for tests. */
  maxInFlight = 0;
  /** Writes in flight now. */
  #inFlight = 0;

  constructor(
    /** Appends one entry to the job's log; its rejection is ignored. */
    private readonly write: (entry: string) => Promise<unknown>,
  ) {}

  /** Queues one line, and starts the write loop if it is not running. */
  push(line: string): void {
    this.#queued.push(line);
    this.#pumping ??= this.#pump().finally(() => {
      this.#pumping = undefined;
    });
  }

  /**
   * Resolves `true` once every line pushed so far has been written, or
   * `false` when `timeoutMs` ran out first: a store that never answers a
   * write must not hold the attempt open for ever. Never rejects. Lines still
   * queued then are written if the store comes back, after the attempt.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ranOut = new Promise<false>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, false);
    });
    try {
      return await Promise.race([
        (async () => {
          while (this.#pumping) {
            await this.#pumping;
          }
          return true as const;
        })(),
        ranOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Writes what is queued, one entry at a time, until nothing is. */
  async #pump(): Promise<void> {
    while (this.#queued.length > 0) {
      const entry = this.#take();
      this.#inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
      try {
        await this.write(entry);
      } catch {
        // A log line that could not be stored does not fail the job.
      } finally {
        this.#inFlight--;
      }
    }
  }

  /** The next entry: queued lines joined, up to {@link LOG_BATCH_CHARS}. */
  #take(): string {
    let size = 0;
    let count = 0;
    while (count < this.#queued.length) {
      const next = this.#queued[count]!.length + 1;
      if (count > 0 && size + next > LOG_BATCH_CHARS) {
        break;
      }
      size += next;
      count++;
    }
    return this.#queued.splice(0, count).join("\n");
  }
}
