import { pathToFileURL } from "node:url";
import type { HealthResponsePayload, QrResponsePayload } from "../http/types.js";

export interface ParsedMetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface RolloutCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface RolloutVerificationOptions {
  readonly baseUrl: string;
  readonly allowDegraded?: boolean | undefined;
  readonly allowUnpaired?: boolean | undefined;
  readonly maxDlqMessages?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export interface RolloutVerificationReport {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly timestamp: string;
  readonly checks: readonly RolloutCheckResult[];
}

export const REQUIRED_PROMETHEUS_METRICS: readonly string[] = [
  "gateway_health_status",
  "gateway_mode",
  "gateway_uptime_seconds",
  "failover_events_total",
  "failback_events_total",
  "fsm_state",
  "engine_status",
  "queue_length",
  "dlq_messages_total",
  "messages_processed_total",
  "messages_outbound_errors_total",
  "messages_requeued_total",
  "messages_inbound_published_total",
  "messages_inbound_duplicate_total",
  "messages_react_processed_total",
  "messages_react_errors_total",
  "outbound_buffer_depth",
  "circuit_breaker_consecutive_failures",
];

function parseMetricLabels(rawLabels: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  for (const match of rawLabels.matchAll(labelPattern)) {
    const key = match[1];
    const val = match[2];
    if (key !== undefined && val !== undefined) {
      labels[key] = val.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return labels;
}

/**
 * Parses Prometheus text exposition format (version 0.0.4) into structured samples.
 */
export function parsePrometheusMetrics(body: string): Map<string, ParsedMetricSample[]> {
  const samples = new Map<string, ParsedMetricSample[]>();
  const linePattern =
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(linePattern);
    if (!match) continue;

    const name = match[1];
    const rawLabels = match[2] ?? "";
    const valueStr = match[3];
    if (!name || !valueStr) continue;

    const value = Number(valueStr);
    if (Number.isNaN(value)) continue;

    const list = samples.get(name) ?? [];
    list.push({ name, labels: parseMetricLabels(rawLabels), value });
    samples.set(name, list);
  }

  return samples;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetchFn(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function evaluateHealthPayload(
  statusCode: number,
  health: HealthResponsePayload,
  allowDegraded: boolean,
): RolloutCheckResult {
  if (statusCode !== 200) {
    return {
      name: "http_health",
      passed: false,
      detail: `Expected HTTP 200 from /health, received ${statusCode} (status=${health.status})`,
    };
  }

  const statusAllowed = health.status === "ok" || (allowDegraded && health.status === "degraded");
  if (!statusAllowed) {
    return {
      name: "http_health",
      passed: false,
      detail: `Gateway health status is "${health.status}" (fsm_state=${health.fsm_state ?? "unknown"})`,
    };
  }

  if (health.queues && !health.queues.isOpen) {
    return {
      name: "http_health",
      passed: false,
      detail: "Redis queue manager connection is closed (queues.isOpen=false)",
    };
  }

  return {
    name: "http_health",
    passed: true,
    detail: `status=${health.status}, active_engine=${health.active_engine}, mode=${health.gateway_mode ?? "failover"}`,
  };
}

function evaluateMetricsPayload(
  statusCode: number,
  contentType: string | null,
  body: string,
  maxDlqMessages: number,
): RolloutCheckResult[] {
  const results: RolloutCheckResult[] = [];
  if (statusCode !== 200) {
    results.push({
      name: "http_metrics",
      passed: false,
      detail: `Expected HTTP 200 from /metrics, received ${statusCode}`,
    });
    return results;
  }

  const validContentType = contentType?.includes("text/plain") ?? false;
  const parsed = parsePrometheusMetrics(body);
  const missing = REQUIRED_PROMETHEUS_METRICS.filter((metric) => !parsed.has(metric));

  results.push({
    name: "http_metrics",
    passed: validContentType && missing.length === 0,
    detail:
      missing.length > 0
        ? `Missing required Prometheus metrics: ${missing.join(", ")}`
        : validContentType
          ? `Verified ${REQUIRED_PROMETHEUS_METRICS.length} required metric families`
          : `Unexpected Content-Type: ${contentType ?? "none"}`,
  });

  const dlqSample = parsed.get("queue_length")?.find((sample) => sample.labels.queue === "dlq");
  const dlqDepth = dlqSample?.value ?? 0;
  results.push({
    name: "dlq_depth",
    passed: dlqDepth <= maxDlqMessages,
    detail: `dlq_depth=${dlqDepth} (threshold <= ${maxDlqMessages})`,
  });

  return results;
}

async function checkPrimaryQr(
  baseUrl: string,
  allowUnpaired: boolean,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<RolloutCheckResult> {
  const res = await fetchWithTimeout(`${baseUrl}/qr/baileys`, timeoutMs, fetchFn);
  if (res.status !== 200) {
    return {
      name: "qr_baileys",
      passed: false,
      detail: `Expected HTTP 200 from /qr/baileys, received ${res.status}`,
    };
  }

  const data = (await res.json()) as QrResponsePayload;
  const ok = data.status === "CONNECTED" || allowUnpaired;
  return {
    name: "qr_baileys",
    passed: ok,
    detail: `baileys status=${data.status}`,
  };
}

async function checkStandbyQr(
  baseUrl: string,
  gatewayMode: "failover" | "baileys_only",
  allowUnpaired: boolean,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<RolloutCheckResult> {
  const res = await fetchWithTimeout(`${baseUrl}/qr/wwebjs`, timeoutMs, fetchFn);
  if (gatewayMode === "baileys_only") {
    const data = (await res.json()) as { status?: string };
    const passed = res.status === 404 && data.status === "DISABLED";
    return {
      name: "qr_wwebjs",
      passed,
      detail: `baileys_only mode: http=${res.status}, status=${data.status ?? "unknown"}`,
    };
  }

  if (res.status !== 200) {
    return {
      name: "qr_wwebjs",
      passed: false,
      detail: `Expected HTTP 200 from /qr/wwebjs, received ${res.status}`,
    };
  }

  const data = (await res.json()) as QrResponsePayload;
  const readyStates = new Set(["STANDBY_READY", "CONNECTED"]);
  const passed = readyStates.has(data.status) || allowUnpaired;
  return {
    name: "qr_wwebjs",
    passed,
    detail: `wwebjs status=${data.status}`,
  };
}

/**
 * Runs post-deploy production rollout verification against a running gateway HTTP endpoint.
 */
export async function verifyRollout(
  options: RolloutVerificationOptions,
): Promise<RolloutVerificationReport> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const allowDegraded = options.allowDegraded ?? false;
  const allowUnpaired = options.allowUnpaired ?? false;
  const maxDlqMessages = options.maxDlqMessages ?? 0;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchFn = options.fetchFn ?? fetch;

  const checks: RolloutCheckResult[] = [];
  let gatewayMode: "failover" | "baileys_only" = "failover";

  try {
    const healthRes = await fetchWithTimeout(`${baseUrl}/health`, timeoutMs, fetchFn);
    const healthData = (await healthRes.json()) as HealthResponsePayload;
    gatewayMode = healthData.gateway_mode ?? "failover";
    checks.push(evaluateHealthPayload(healthRes.status, healthData, allowDegraded));
  } catch (err) {
    checks.push({
      name: "http_health",
      passed: false,
      detail: `Health probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const metricsRes = await fetchWithTimeout(`${baseUrl}/metrics`, timeoutMs, fetchFn);
    const metricsBody = await metricsRes.text();
    checks.push(
      ...evaluateMetricsPayload(
        metricsRes.status,
        metricsRes.headers.get("content-type"),
        metricsBody,
        maxDlqMessages,
      ),
    );
  } catch (err) {
    checks.push({
      name: "http_metrics",
      passed: false,
      detail: `Metrics probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    checks.push(await checkPrimaryQr(baseUrl, allowUnpaired, timeoutMs, fetchFn));
  } catch (err) {
    checks.push({
      name: "qr_baileys",
      passed: false,
      detail: `Primary QR probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    checks.push(await checkStandbyQr(baseUrl, gatewayMode, allowUnpaired, timeoutMs, fetchFn));
  } catch (err) {
    checks.push({
      name: "qr_wwebjs",
      passed: false,
      detail: `Standby QR probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    ok: checks.every((check) => check.passed),
    baseUrl,
    timestamp: new Date().toISOString(),
    checks,
  };
}

export function parseRolloutCliArgs(argv: readonly string[]): RolloutVerificationOptions {
  let baseUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
  let allowDegraded = false;
  let allowUnpaired = false;
  let maxDlqMessages = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) {
      baseUrl = argv[i + 1] as string;
      i++;
    } else if (arg === "--allow-degraded") {
      allowDegraded = true;
    } else if (arg === "--allow-unpaired") {
      allowUnpaired = true;
    } else if (arg === "--max-dlq" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        maxDlqMessages = parsed;
      }
      i++;
    }
  }

  return { baseUrl, allowDegraded, allowUnpaired, maxDlqMessages };
}

async function runCli(): Promise<void> {
  const options = parseRolloutCliArgs(process.argv.slice(2));
  const report = await verifyRollout(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  void runCli();
}
