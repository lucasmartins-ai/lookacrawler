export interface CrawlMetrics {
  requests: number;
  successes: number;
  failures: number;
  cacheHits: number;
  retries: number;
  bytesFetched: number;
  durationMs: number;
}

const metrics: CrawlMetrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  cacheHits: 0,
  retries: 0,
  bytesFetched: 0,
  durationMs: 0,
};

export function recordMetric<K extends keyof CrawlMetrics>(key: K, value = 1): void {
  metrics[key] += value;
}

export function getMetrics(): CrawlMetrics {
  return { ...metrics };
}

export function resetMetrics(): void {
  for (const key of Object.keys(metrics) as Array<keyof CrawlMetrics>) metrics[key] = 0;
}
