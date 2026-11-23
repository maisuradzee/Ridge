#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  baseUrl: "http://127.0.0.1:8787",
  concurrency: 500,
  durationSeconds: 15,
  rampSeconds: 3,
  thinkTimeMs: 1000,
  timeoutMs: 5000,
  maxP95Ms: 1500,
  maxErrorRate: 0.01,
  reportPath: "artifacts/ridge-stage5-api-load-report.json",
});

function integerArg(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new Error(name + " must be an integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + " must be between " + minimum + " and " + maximum + ".");
  }
  return parsed;
}

export function parseArgs(argv = []) {
  const config = { ...DEFAULTS };
  const numeric = {
    "--concurrency": ["concurrency", 1, 5000],
    "--duration-seconds": ["durationSeconds", 5, 300],
    "--ramp-seconds": ["rampSeconds", 0, 300],
    "--think-time-ms": ["thinkTimeMs", 0, 10000],
    "--timeout-ms": ["timeoutMs", 100, 30000],
    "--max-p95-ms": ["maxP95Ms", 1, 30000],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      config.help = true;
      continue;
    }
    if (flag === "--base-url" || flag === "--report-path" || flag === "--max-error-rate") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for " + flag + ".");
      }
      index += 1;
      if (flag === "--base-url") config.baseUrl = value;
      else if (flag === "--report-path") config.reportPath = value;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error("--max-error-rate must be between 0 and 1.");
        }
        config.maxErrorRate = parsed;
      }
      continue;
    }
    if (Object.hasOwn(numeric, flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for " + flag + ".");
      }
      index += 1;
      const [key, minimum, maximum] = numeric[flag];
      config[key] = integerArg(value, flag, minimum, maximum);
      continue;
    }
    throw new Error("Unknown argument: " + flag);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(config.baseUrl);
  } catch {
    throw new Error("--base-url must be a valid URL.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("--base-url must use HTTP or HTTPS.");
  }
  if (config.rampSeconds > config.durationSeconds) {
    throw new Error("--ramp-seconds cannot exceed --duration-seconds.");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/, "");
  config.reportPath = config.reportPath.trim();
  if (!config.reportPath) throw new Error("--report-path cannot be empty.");
  return config;
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("Percentile fraction must be between 0 and 1.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}

export function summarizeLoad({
  latenciesMs,
  failureCount,
  durationMs,
  concurrency,
  maxObservedInFlightRequests,
  maxP95Ms,
  maxErrorRate,
}) {
  const samples = Array.isArray(latenciesMs) ? latenciesMs : [];
  const totalRequests = samples.length;
  const failures = Math.max(0, Number(failureCount) || 0);
  const errorRate = totalRequests > 0 ? failures / totalRequests : 1;
  const safeDurationMs = Math.max(1, Number(durationMs) || 0);
  const p95Ms = percentile(samples, 0.95);
  const passed = totalRequests > 0 &&
    errorRate <= maxErrorRate &&
    p95Ms !== null &&
    p95Ms <= maxP95Ms;

  return {
    passed,
    activeVirtualUsers: concurrency,
    maxObservedInFlightRequests,
    totalRequests,
    failedRequests: failures,
    successfulRequests: totalRequests - failures,
    errorRate: Number(errorRate.toFixed(5)),
    requestsPerSecond: Number((totalRequests / (safeDurationMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: percentile(samples, 0.5),
      p95: p95Ms,
      p99: percentile(samples, 0.99),
      max: samples.length ? Number(Math.max(...samples).toFixed(2)) : null,
    },
    thresholds: {
      maxP95Ms,
      maxErrorRate,
    },
  };
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function readJsonResponse(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Response body was not valid JSON.");
    error.code = "invalid_json";
    throw error;
  }
}

export async function runLoadTest(config) {
  const healthResponse = await fetch(new URL("/health", config.baseUrl), {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!healthResponse.ok) {
    throw new Error("RIDGE health endpoint returned HTTP " + healthResponse.status + ".");
  }
  const health = await readJsonResponse(healthResponse);
  if (health.environment !== "development") {
    throw new Error("Safety stop: this load runner only accepts a development RIDGE API.");
  }
  if (health.storage !== "memory-ephemeral") {
    throw new Error("Safety stop: load testing requires isolated memory-ephemeral storage.");
  }

  const routeNames = ["world_state", "player_profile", "player_wallet"];
  const routeCounts = { world_state: 0, player_profile: 0, player_wallet: 0 };
  const statusCounts = {};
  const errorKinds = {};
  const latenciesMs = [];
  let failureCount = 0;
  let inFlightRequests = 0;
  let maxObservedInFlightRequests = 0;

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = started + config.durationSeconds * 1000;
  const runId = Date.now().toString(36);

  async function virtualPlayer(playerIndex) {
    const rampDelay = config.concurrency > 1
      ? config.rampSeconds * 1000 * playerIndex / (config.concurrency - 1)
      : 0;
    if (rampDelay > 0) await sleep(rampDelay);
    if (performance.now() >= deadline) return;

    const playerId = "ridge-load-" + runId + "-" + playerIndex;
    let sequence = 0;

    while (performance.now() < deadline) {
      const route = routeNames[(playerIndex + sequence) % routeNames.length];
      let path;
      const headers = {};
      if (route === "world_state") {
        path = "/v1/world/state";
      } else if (route === "player_profile") {
        path = "/v1/player/me";
        headers["x-ridge-player-id"] = playerId;
      } else {
        path = "/v1/player/wallet";
        headers["x-ridge-player-id"] = playerId;
      }

      routeCounts[route] += 1;
      const requestStarted = performance.now();
      inFlightRequests += 1;
      maxObservedInFlightRequests = Math.max(maxObservedInFlightRequests, inFlightRequests);

      try {
        const response = await fetch(new URL(path, config.baseUrl), {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        statusCounts[String(response.status)] = (statusCounts[String(response.status)] ?? 0) + 1;
        const payload = await readJsonResponse(response);
        if (!response.ok) {
          const error = new Error("HTTP " + response.status);
          error.code = "http_" + response.status;
          throw error;
        }
        if (route === "world_state" && typeof payload.worldId !== "string") {
          const error = new Error("World state contract mismatch.");
          error.code = "invalid_world_state";
          throw error;
        }
        if (route === "player_profile" && payload.id !== playerId) {
          const error = new Error("Player profile contract mismatch.");
          error.code = "invalid_player_profile";
          throw error;
        }
        if (route === "player_wallet" && (payload.playerId !== playerId || payload.currency !== "GEL")) {
          const error = new Error("Player wallet contract mismatch.");
          error.code = "invalid_player_wallet";
          throw error;
        }
      } catch (error) {
        failureCount += 1;
        const code = error?.code ??
          (error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "request_error");
        errorKinds[code] = (errorKinds[code] ?? 0) + 1;
      } finally {
        latenciesMs.push(performance.now() - requestStarted);
        inFlightRequests -= 1;
      }

      sequence += 1;
      if (config.thinkTimeMs > 0) await sleep(config.thinkTimeMs);
    }
  }

  await Promise.all(
    Array.from({ length: config.concurrency }, (_, index) => virtualPlayer(index)),
  );
  const finished = performance.now();

  const summary = summarizeLoad({
    latenciesMs,
    failureCount,
    durationMs: finished - started,
    concurrency: config.concurrency,
    maxObservedInFlightRequests,
    maxP95Ms: config.maxP95Ms,
    maxErrorRate: config.maxErrorRate,
  });

  return {
    schema: "ridge.stage5.api-load-report.v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    target: {
      baseUrl: config.baseUrl,
      environment: health.environment,
      storage: health.storage,
      service: health.service,
    },
    workload: {
      concurrency: config.concurrency,
      durationSeconds: config.durationSeconds,
      rampSeconds: config.rampSeconds,
      thinkTimeMs: config.thinkTimeMs,
      routes: routeCounts,
    },
    statusCounts,
    errorKinds,
    summary,
    validationBoundary: {
      httpApiLoadOnly: true,
      unrealReplicationTested: false,
      dedicatedServerRuntimeTested: false,
      productionDatabaseTested: false,
      note: "500 virtual HTTP clients do not represent 500 connected Unreal Engine players.",
    },
  };
}

function printHelp() {
  process.stdout.write(
    "RIDGE Stage 5 development API load test\n" +
    "Options: --base-url URL --concurrency N --duration-seconds N --ramp-seconds N\n" +
    "         --think-time-ms N --timeout-ms N --max-p95-ms N\n" +
    "         --max-error-rate 0..1 --report-path PATH\n" +
    "Safety: requires development mode and memory-ephemeral storage; refuses production or database-backed targets.\n",
  );
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return;
  }
  const report = await runLoadTest(config);
  const reportPath = resolve(process.cwd(), config.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({
    reportPath: config.reportPath,
    target: report.target,
    summary: report.summary,
    validationBoundary: report.validationBoundary,
  }, null, 2) + "\n");
  if (!report.summary.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write("RIDGE load test failed: " + (error?.message ?? error) + "\n");
    process.exitCode = 1;
  });
}
