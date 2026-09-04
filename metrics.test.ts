import { describe, it, expect, beforeEach } from "bun:test";
import { recordMetric, getMetrics, resetMetrics, type CrawlMetrics } from "./metrics.js";

describe("Metrics Module (metrics.ts)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("should initialize all metrics to 0", () => {
    const snapshot = getMetrics();
    expect(snapshot.requests).toBe(0);
    expect(snapshot.successes).toBe(0);
    expect(snapshot.failures).toBe(0);
    expect(snapshot.cacheHits).toBe(0);
    expect(snapshot.retries).toBe(0);
    expect(snapshot.bytesFetched).toBe(0);
    expect(snapshot.durationMs).toBe(0);
    expect(snapshot.escalations).toBe(0);
  });

  it("should increment metric by 1 by default", () => {
    recordMetric("requests");
    recordMetric("successes");
    recordMetric("cacheHits");

    const snapshot = getMetrics();
    expect(snapshot.requests).toBe(1);
    expect(snapshot.successes).toBe(1);
    expect(snapshot.cacheHits).toBe(1);
    expect(snapshot.failures).toBe(0);
  });

  it("should increment metric by custom value", () => {
    recordMetric("bytesFetched", 2048);
    recordMetric("bytesFetched", 1024);
    recordMetric("durationMs", 350);

    const snapshot = getMetrics();
    expect(snapshot.bytesFetched).toBe(3072);
    expect(snapshot.durationMs).toBe(350);
  });

  it("should reset all metrics when resetMetrics is called", () => {
    recordMetric("requests", 10);
    recordMetric("failures", 3);
    recordMetric("escalations", 2);

    expect(getMetrics().requests).toBe(10);
    expect(getMetrics().failures).toBe(3);
    expect(getMetrics().escalations).toBe(2);

    resetMetrics();

    const snapshot = getMetrics();
    expect(snapshot.requests).toBe(0);
    expect(snapshot.failures).toBe(0);
    expect(snapshot.escalations).toBe(0);
  });

  it("should return a decoupled clone in getMetrics so mutations do not affect internal state", () => {
    const snapshot = getMetrics();
    snapshot.requests = 999;

    expect(getMetrics().requests).toBe(0);
  });
});
