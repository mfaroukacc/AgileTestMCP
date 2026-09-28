// Small bounded-concurrency map. Replaces the old serial loop with a hardcoded
// 5-second sleep before every test case, which dominated total runtime.
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner);
  await Promise.all(workers);
  return results;
}

export function createTimer() {
  const startedAt = Date.now();
  return {
    startedAt,
    elapsedMs: () => Date.now() - startedAt,
    elapsedLabel: () => formatDuration(Date.now() - startedAt),
  };
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}
