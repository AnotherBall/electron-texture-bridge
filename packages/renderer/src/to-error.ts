/**
 * Normalize an unknown `catch` value into an `Error` instance. `Error`
 * instances pass through unchanged; anything else is stringified into the
 * message and the original value is preserved on `cause` for debugging.
 * Shared by every bridge that emits `"error"` events from a `catch` block.
 */
export const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(`${value}`, { cause: value });
};
