/** Runs async work with at most `max` tasks in flight. */
export interface Limiter {
  /** Runs `task` when a slot is free; settles with its result. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
}

/** Creates a {@link Limiter}. `max` below 1 is treated as 1. */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  const queue: (() => void)[] = [];
  let active = 0;

  const release = () => {
    active--;
    queue.shift()?.();
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          task().then(resolve, reject).finally(release);
        };
        if (active < limit) {
          start();
        } else {
          queue.push(start);
        }
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}
