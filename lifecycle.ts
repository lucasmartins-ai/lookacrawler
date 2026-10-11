/**
 * Process-level cleanup registry.
 *
 * Modules that hold long-lived handles (Chromium processes, the egress guard
 * listener) register a cleanup here when they are loaded. One-shot entry points
 * such as the CLI call `runCleanups()` when they finish, so the process can exit
 * without importing heavy modules it never used.
 */
type Cleanup = () => unknown | Promise<unknown>;

const cleanups = new Set<Cleanup>();

export function registerCleanup(fn: Cleanup): void {
  cleanups.add(fn);
}

/** Run every registered cleanup once, bounded by `timeoutMs`. Never throws. */
export async function runCleanups(timeoutMs = 10_000): Promise<void> {
  const pending = [...cleanups];
  cleanups.clear();
  if (pending.length === 0) return;
  const all = Promise.allSettled(pending.map((fn) => Promise.resolve().then(fn)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
}
