/**
 * Re-entrancy guard for the worker's `setInterval` tick loop (ported from helios).
 *
 * `setInterval` does not await its callback, so a tick longer than the interval
 * would start a second concurrent run and race the single-writer datastore.
 * An overlapping fire calls `onSkip` and returns. The flag resets in `finally`
 * so a throw cannot wedge the guard.
 */
export function reentrant(
  fn: () => Promise<void>,
  onSkip: () => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      onSkip();
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
