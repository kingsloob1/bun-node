import type { ChildToParent, ParentToChild } from "../../lib/runner/protocol";

/**
 * A stand-in for the global `Worker`, for tests that need to decide when a
 * thread "stops": a real one's `close` arrives whenever Bun gets to it, which
 * is the very thing those tests cannot wait on (oven-sh/bun#44216).
 *
 * It speaks just enough of the executor protocol to be started — it says
 * `ready` on the next turn, as the real entry does once loaded — and then
 * does nothing on its own. `terminate()` fires `close` after `closeAfter`
 * milliseconds, or never when that is `false`, until the test calls
 * {@link FakeWorker.exit} itself. `WorkerExecutor` reads the global at
 * `start()`, so installing this before a run is all it takes.
 */
export class FakeWorker extends EventTarget {
  /** Every instance built while installed, oldest first. */
  static readonly instances: FakeWorker[] = [];
  /**
   * How long after `terminate()` a new instance fires `close`, in
   * milliseconds; `false` for never, until the test calls `exit()`.
   */
  static closeAfter: number | false = 0;

  /** The URL it was built with. */
  readonly url: string | URL;
  /** Every message the executor posted to it, in order. */
  readonly received: ParentToChild[] = [];
  /** How many times `terminate()` was called. */
  terminations = 0;
  /** Whether `close` has fired. */
  closed = false;
  /** This instance's `closeAfter`, fixed when it was built. */
  readonly #closeAfter: number | false;

  constructor(
    /** The entry the executor asked for. */
    url: string | URL,
  ) {
    super();
    this.url = url;
    this.#closeAfter = FakeWorker.closeAfter;
    FakeWorker.instances.push(this);
    setTimeout(() => this.emit({ t: "ready", pid: 0, protocol: 1 }), 0);
  }

  /** Records a message from the executor. */
  postMessage(message: ParentToChild): void {
    this.received.push(message);
  }

  /** Counts the call, and fires `close` after `closeAfter` unless `false`. */
  terminate(): void {
    this.terminations += 1;
    if (this.terminations === 1 && this.#closeAfter !== false) {
      setTimeout(() => this.exit(), this.#closeAfter);
    }
  }

  /** The thread "stops": fires `close`, once. */
  exit(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  /** Delivers `message` to the executor as if the thread had posted it. */
  emit(message: ChildToParent): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  /** Accepted and ignored, as the executor calls it. */
  unref(): void {}

  /** Accepted and ignored. */
  ref(): void {}
}

/**
 * Puts {@link FakeWorker} in place of the global `Worker`, resetting its
 * instances and `closeAfter`, and returns the function that restores the
 * real one.
 */
export function installFakeWorker(
  /** The initial `FakeWorker.closeAfter`; defaults to `0`. */
  closeAfter: number | false = 0,
): () => void {
  const real = globalThis.Worker;
  FakeWorker.instances.length = 0;
  FakeWorker.closeAfter = closeAfter;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return () => {
    globalThis.Worker = real;
  };
}
