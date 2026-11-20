/**
 * Shared thenable probe.
 *
 * Host callbacks and the server-key resolver return either a value or a
 * Promise; checking `then` (rather than `instanceof Promise`) also accepts
 * cross-realm promises and thenables.
 */
export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
