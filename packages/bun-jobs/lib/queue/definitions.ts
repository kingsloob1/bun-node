import type { JobOptions, JobProcessor } from "./types";

/**
 * Jobs described by name, so one worker can run all of them.
 *
 * Without this a consumer writes the dispatch itself — one worker per queue
 * and a `switch (job.name)` inside it, or a queue per kind of job and a worker
 * for each. Both work; both put the routing in the caller and leave nothing
 * that can be asked *what jobs exist*, which is what a dashboard, a health
 * check and every per-name feature need.
 *
 * A definition is the name, the handler and the defaults every job of that
 * name should carry. Declaring the defaults once is the point: `attempts: 5`
 * belongs to what the job *is*, not to each place that happens to enqueue one,
 * and scattering it across call sites is how two of them come to disagree.
 */

/** What a definition says about jobs of one name, beyond how to run them. */
export interface JobDefinitionOptions extends JobOptions {
  /**
   * How many of *this* job may run at once, across the registry's worker.
   *
   * Not yet enforced — the worker's concurrency is a single number covering
   * every name it runs. Recorded here because it belongs to the definition,
   * and the per-name limit that reads it is a separate piece of work.
   */
  concurrency?: number;
}

/** One named job: how to run it, and what its jobs carry by default. */
export interface JobDefinition<TData = unknown, TResult = unknown> {
  /** The name jobs of this kind are added under. */
  name: string;
  /** What runs when one of them is claimed. */
  handler: JobProcessor<TData, TResult>;
  /** Merged under every job added by this name. */
  options: JobDefinitionOptions;
}

/**
 * The definitions a context knows about.
 *
 * Deliberately a plain map rather than anything cleverer: the whole value is
 * that there is one place to ask, and asking is the common operation — every
 * claimed job looks its handler up here.
 */
export class JobDefinitions {
  /** Definitions by name. */
  readonly #byName = new Map<string, JobDefinition<never, never>>();

  /**
   * Records how to run jobs of one name.
   *
   * Defining the same name twice replaces the first, which is what a caller
   * reloading a module expects. It is not silent: the caller asked for it by
   * calling `define` again.
   */
  set<TData, TResult>(definition: JobDefinition<TData, TResult>): void {
    this.#byName.set(
      definition.name,
      definition as unknown as JobDefinition<never, never>,
    );
  }

  /** The definition for a name, or `undefined`. */
  get(name: string): JobDefinition<never, never> | undefined {
    return this.#byName.get(name);
  }

  /** Whether a name has been defined. */
  has(name: string): boolean {
    return this.#byName.has(name);
  }

  /** Every name defined, in the order they were defined. */
  names(): string[] {
    return [...this.#byName.keys()];
  }

  /** Every definition, for a dashboard or a health check. */
  all(): JobDefinition<never, never>[] {
    return [...this.#byName.values()];
  }

  /** Forgets a definition. */
  delete(name: string): boolean {
    return this.#byName.delete(name);
  }

  /** How many names are defined. */
  get size(): number {
    return this.#byName.size;
  }
}
