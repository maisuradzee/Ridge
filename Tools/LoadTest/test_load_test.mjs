import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, percentile, summarizeLoad } from "./ridge_api_load_test.mjs";

test("default profile targets 500 virtual clients without touching production", () => {
  const config = parseArgs([]);
  assert.equal(config.concurrency, 500);
  assert.equal(config.durationSeconds, 15);
  assert.equal(config.maxErrorRate, 0.01);
  assert.equal(config.baseUrl, "http://127.0.0.1:8787");
});

test("CLI accepts a bounded custom workload", () => {
  const config = parseArgs([
    "--concurrency", "100",
    "--duration-seconds", "30",
    "--ramp-seconds", "5",
    "--think-time-ms", "500",
    "--max-p95-ms", "900",
    "--max-error-rate", "0.02",
  ]);
  assert.equal(config.concurrency, 100);
  assert.equal(config.durationSeconds, 30);
  assert.equal(config.rampSeconds, 5);
  assert.equal(config.thinkTimeMs, 500);
  assert.equal(config.maxP95Ms, 900);
  assert.equal(config.maxErrorRate, 0.02);
});

test("CLI rejects unsafe or invalid workload bounds", () => {
  assert.throws(() => parseArgs(["--concurrency", "0"]), /between 1 and 5000/);
  assert.throws(() => parseArgs(["--concurrency", "500.5"]), /integer/);
  assert.throws(() => parseArgs(["--duration-seconds", "301"]), /between 5 and 300/);
  assert.throws(() => parseArgs(["--ramp-seconds", "10", "--duration-seconds", "5"]), /cannot exceed/);
  assert.throws(() => parseArgs(["--max-error-rate", "1.1"]), /between 0 and 1/);
  assert.throws(() => parseArgs(["--unknown", "value"]), /Unknown argument/);
});

test("percentile uses nearest-rank and handles empty samples", () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30);
  assert.equal(percentile([50, 10, 40, 20, 30], 0.95), 50);
  assert.equal(percentile([], 0.95), null);
});

test("summary passes only when latency and error thresholds both pass", () => {
  const result = summarizeLoad({
    latenciesMs: [10, 20, 30, 40, 50],
    failureCount: 0,
    durationMs: 1000,
    concurrency: 500,
    maxObservedInFlightRequests: 500,
    maxP95Ms: 100,
    maxErrorRate: 0.01,
  });
  assert.equal(result.passed, true);
  assert.equal(result.totalRequests, 5);
  assert.equal(result.errorRate, 0);
  assert.equal(result.latencyMs.p95, 50);
  assert.equal(result.activeVirtualUsers, 500);
});

test("summary fails on excessive latency, errors, or zero requests", () => {
  const slow = summarizeLoad({
    latenciesMs: [100, 200, 300],
    failureCount: 0,
    durationMs: 1000,
    concurrency: 10,
    maxObservedInFlightRequests: 10,
    maxP95Ms: 100,
    maxErrorRate: 0.01,
  });
  assert.equal(slow.passed, false);

  const errors = summarizeLoad({
    latenciesMs: [10, 20, 30, 40],
    failureCount: 1,
    durationMs: 1000,
    concurrency: 10,
    maxObservedInFlightRequests: 10,
    maxP95Ms: 100,
    maxErrorRate: 0.01,
  });
  assert.equal(errors.passed, false);
  assert.equal(errors.errorRate, 0.25);

  const empty = summarizeLoad({
    latenciesMs: [],
    failureCount: 0,
    durationMs: 1000,
    concurrency: 10,
    maxObservedInFlightRequests: 0,
    maxP95Ms: 100,
    maxErrorRate: 0.01,
  });
  assert.equal(empty.passed, false);
});
