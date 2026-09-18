import type { TypedEmitter } from "@kingsleyweb/bun-common";
import { EventEmitter } from "node:events";

/**
 * A typed event surface backed by a lazily-created `node:events` emitter.
 *
 * `BunRunner`, `BunQueue` and `BunQueueWorker` all emit events, and all of
 * them are frequently used without a listener (a producer that only calls
 * `add`, a runner driven entirely by its schedule). Building the emitter on
 * the first `on`/`once` call keeps those instances free, and `emit` is a
 * no-op until someone listens. The pattern is bun-common's `BunWebSocket`,
 * generalised so three classes do not each re-implement fifteen methods.
 *
 * `Events` is what a listener sees; `EmitEvents` is what the class itself
 * emits, and the two differ only where a listener is promised something
 * narrower than the emitting code can state. A registry-bound `BunQueue`
 * emits a plain `Job`, and its listeners are handed a job discriminated by
 * name — the same object, described by the job map the context declared.
 * Keeping the emitting side on the plain map is what lets the class body stay
 * free of casts: it never has to prove, generically, what only the map says.
 */
export abstract class TypedEmitterBase<
  Events extends Record<string, (...args: any[]) => any>,
  EmitEvents extends Record<string, (...args: any[]) => any> = Events,
> implements TypedEmitter<Events> {
  /** The emitter, absent until something listens. */
  #emitter: EventEmitter | undefined = undefined;
  /**
   * Whether a listener may exist for a job-name-scoped event (`completed:sendEmail`).
   *
   * Set when one is added, and worked out again from the listeners actually
   * registered whenever any are removed. It can only err towards `true` — a
   * `once` listener removes itself without passing through here — which costs
   * {@link safeEmitScoped} the name it would have built anyway; it never skips
   * one that is listening.
   */
  #hasScoped = false;

  /** Returns the emitter, creating it on demand. */
  protected get events(): EventEmitter {
    if (!this.#emitter) {
      const emitter = new EventEmitter();
      // Runners and workers legitimately attract many listeners (one per
      // in-flight job); the ten-listener warning would be noise.
      emitter.setMaxListeners(0);
      this.#emitter = emitter;
    }
    return this.#emitter;
  }

  /** The event name as `node:events` wants it. */
  #name(event: keyof Events): string | symbol {
    return event as string | symbol;
  }

  /** Notes a listener added for `event`. */
  #added(event: keyof Events): void {
    if (typeof event === "string" && event.includes(":")) {
      this.#hasScoped = true;
    }
  }

  /** Works out again whether any scoped listener remains, after a removal. */
  #removed(): void {
    this.#hasScoped =
      this.#emitter
        ?.eventNames()
        .some((name) => typeof name === "string" && name.includes(":")) ??
      false;
  }

  addListener<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.events.addListener(this.#name(event), listener);
    this.#added(event);
    return this;
  }

  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.events.on(this.#name(event), listener);
    this.#added(event);
    return this;
  }

  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.events.once(this.#name(event), listener);
    this.#added(event);
    return this;
  }

  prependListener<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.events.prependListener(this.#name(event), listener);
    this.#added(event);
    return this;
  }

  prependOnceListener<E extends keyof Events>(
    event: E,
    listener: Events[E],
  ): this {
    this.events.prependOnceListener(this.#name(event), listener);
    this.#added(event);
    return this;
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.#emitter?.off(this.#name(event), listener);
    this.#removed();
    return this;
  }

  removeListener<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.#emitter?.removeListener(this.#name(event), listener);
    this.#removed();
    return this;
  }

  removeAllListeners<E extends keyof Events>(event?: E): this {
    // `removeAllListeners` branches on `arguments.length`, not on the
    // argument's value: forwarding `undefined` explicitly reads as "remove
    // listeners for the event named `undefined`", which removes nothing.
    if (event === undefined) {
      this.#emitter?.removeAllListeners();
    } else {
      this.#emitter?.removeAllListeners(this.#name(event));
    }
    this.#removed();
    return this;
  }

  /** Emits an event; `false` when nothing is listening. */
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    return this.#emitter
      ? this.#emitter.emit(this.#name(event), ...args)
      : false;
  }

  eventNames(): (keyof Events | string | symbol)[] {
    return this.#emitter?.eventNames() ?? [];
  }

  listeners<E extends keyof Events>(event: E): Events[E][] {
    return (this.#emitter?.listeners(this.#name(event)) ?? []) as Events[E][];
  }

  listenerCount<E extends keyof Events>(event: E): number {
    return this.#emitter?.listenerCount(this.#name(event)) ?? 0;
  }

  getMaxListeners(): number {
    return this.#emitter?.getMaxListeners() ?? EventEmitter.defaultMaxListeners;
  }

  setMaxListeners(maxListeners: number): this {
    this.events.setMaxListeners(maxListeners);
    return this;
  }

  /**
   * Emits `event`, guaranteeing a listener's throw cannot take down the
   * caller — a failing metrics listener must not fail the job it observed.
   * Returns whether anything was listening.
   */
  protected safeEmit<E extends keyof EmitEvents>(
    event: E,
    ...args: Parameters<EmitEvents[E]>
  ): boolean {
    try {
      // The raw emitter rather than `emit`, which is typed for listeners and
      // may describe these arguments more narrowly than this class can.
      return this.#emitter
        ? this.#emitter.emit(event as string | symbol, ...args)
        : false;
    } catch {
      return true;
    }
  }

  /**
   * Emits an event, and the same event qualified by a job's name.
   *
   * `completed` and `completed:sendEmail` carry identical arguments, so a
   * listener on either sees the same thing. Emitting both is what lets a
   * consumer running twenty kinds of job through one queue listen for the one
   * it cares about, instead of filtering by name inside a listener that runs
   * for every job.
   *
   * The qualified name is built only when something is listening for it.
   * Building it unconditionally would allocate a string per event per job on
   * a path that is otherwise allocation-free.
   */
  protected safeEmitScoped<E extends keyof EmitEvents & string>(
    event: E,
    jobName: string,
    ...args: Parameters<EmitEvents[E]>
  ): boolean {
    const heard = this.safeEmit(event, ...args);

    // No scoped listener anywhere: skip building a name nobody asked for, on
    // every event of every job.
    if (!this.#hasScoped) {
      return heard;
    }

    const scoped = `${event}:${jobName}`;

    if ((this.#emitter?.listenerCount(scoped) ?? 0) === 0) {
      return heard;
    }

    return (
      this.safeEmit(scoped as keyof EmitEvents, ...(args as never)) || heard
    );
  }
}
