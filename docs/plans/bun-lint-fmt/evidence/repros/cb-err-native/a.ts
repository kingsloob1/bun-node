export function wrap(error: Error): Error;
export function wrap(error: unknown): unknown;
export function wrap(error: unknown): unknown {
  return error;
}
