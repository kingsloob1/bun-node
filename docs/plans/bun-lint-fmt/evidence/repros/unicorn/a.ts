interface Waiter { match: (line: string) => boolean }
export function first(waiters: Waiter[], line: string): Waiter | undefined {
  for (const waiter of waiters) {
    if (waiter.match(line)) return waiter;
  }
  return undefined;
}
export const isThree = /^\^3\./.test("^2.0.0");
