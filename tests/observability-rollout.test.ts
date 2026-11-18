import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { DisabledDriver } from "../src/drivers/disabled.js";
import { InMemoryFencingLock } from "../src/fsm/fencing.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import type { FailoverState } from "../src/fsm/types.js";
import { GatewayHttpServer } from "../src/http/server.js";
import type { HealthResponsePayload } from "../src/http/types.js";
import {
  parsePrometheusMetrics,
  parseRolloutCliArgs,
  REQUIRED_PROMETHEUS_METRICS,
  verifyRollout,
} from "../src/observability/rollout-verifier.js";
import type { QueueManagerStatus, RedisQueueManager } from "../src/queues/manager.js";

class MockDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;

  constructor(name: EngineName, initialStatus?: Partial<EngineStatus>) {
    this.name = name;
    this.status = {
      engine: name,
      state: initialStatus?.state ?? "CONNECTED",
      connected: initialStatus?.connected ?? true,
      ...initialStatus,
    };
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  setStatus(status: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...status };
  }

  async connect(): Promise<void> {
    this.status = { ...this.status, state: "CONNECTED", connected: true };
  }

  async disconnect(): Promise<void> {
    this.status = { ...this.status, state: "DISCONNECTED", connected: false };
  }

  async sendMessage(to: string, _content: OutboundMessage): Promise<MessageReceipt> {
    return { id: "msg_1", to, timestamp: Date.now(), status: "SENT" };
  }

  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}
  onStatusChange(_handler: (status: EngineStatus) => void): void {}
}

class MockQueueManager {
  public dlqLength = 0;
  public throwOnLengths = false;

  getStatus(): QueueManagerStatus {
    return {
      isOpen: true,
      publisher: { publishedCount: 10, duplicateCount: 2 },
      worker: {
        isRunning: true,
        isPaused: false,
        processedCount: 20,
        errorCount: 1,
        requeuedCount: 3,
        dlqCount: this.dlqLength,
      },
      react: {
        isRunning: true,
        isPaused: false,
        processedCount: 5,
        errorCount: 1,
      },
    };
  }

  async getQueueLengths(): Promise<{
    inbox: number;
    outbound: number;
    notifications: number;
    outboundLow: number;
    react: number;
    dlq: number;
  }> {
    if (this.throwOnLengths) {
      throw new Error("Simulated Redis connection error");
    }
    return {
      inbox: 2,
      outbound: 1,
      notifications: 4,
      outboundLow: 3,
      react: 1,
      dlq: this.dlqLength,
    };
  }
}

describe("Operational Observability & Production Rollout Verification", () => {
  const servers: GatewayHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) await s.stop();
    }
  });

  async function startTestGateway(options?: {
    gatewayMode?: "failover" | "baileys_only";
    primaryStatus?: Partial<EngineStatus>;
    standbyStatus?: Partial<EngineStatus>;
    dlqLength?: number;
  }): Promise<{
    baseUrl: string;
    primaryDriver: MockDriver;
    standbyDriver: IWhatsAppDriver;
    orchestrator: FailoverOrchestrator;
    queueManager: MockQueueManager;
  }> {
    const gatewayMode = options?.gatewayMode ?? "failover";
    const primaryDriver = new MockDriver("baileys", options?.primaryStatus);
    const standbyDriver: IWhatsAppDriver =
      gatewayMode === "baileys_only"
        ? new DisabledDriver("wwebjs", "Disabled by GATEWAY_MODE=baileys_only")
        : new MockDriver("wwebjs", {
            state: "STANDBY_READY",
            connected: false,
            ...options?.standbyStatus,
          });

    const queueManager = new MockQueueManager();
    queueManager.dlqLength = options?.dlqLength ?? 0;

    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      fencingLock: new InMemoryFencingLock(),
      gatewayMode,
      disableBackgroundProbeTimer: true,
    });

    const server = new GatewayHttpServer({
      orchestrator,
      primaryDriver,
      standbyDriver,
      queueManager: queueManager as unknown as RedisQueueManager,
      port: 0,
      host: "127.0.0.1",
    });
    servers.push(server);
    const port = await server.start(0, "127.0.0.1");

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      primaryDriver,
      standbyDriver,
      orchestrator,
      queueManager,
    };
  }

  it("exports gateway_mode, uptime, react, notifications, and error metrics safely", async () => {
    const { baseUrl, queueManager } = await startTestGateway({ gatewayMode: "failover" });

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as HealthResponsePayload;
    expect(health.gateway_mode).toBe("failover");

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const body = await metricsRes.text();
    const parsed = parsePrometheusMetrics(body);

    for (const metricName of REQUIRED_PROMETHEUS_METRICS) {
      expect(parsed.has(metricName)).toBe(true);
    }

    const modeFailover = parsed.get("gateway_mode")?.find((s) => s.labels.mode === "failover");
    const modeBaileys = parsed.get("gateway_mode")?.find((s) => s.labels.mode === "baileys_only");
    expect(modeFailover?.value).toBe(1);
    expect(modeBaileys?.value).toBe(0);

    const notifQueue = parsed.get("queue_length")?.find((s) => s.labels.queue === "notifications");
    const reactQueue = parsed.get("queue_length")?.find((s) => s.labels.queue === "react");
    expect(notifQueue?.value).toBe(4);
    expect(reactQueue?.value).toBe(1);
    expect(parsed.get("messages_outbound_errors_total")?.[0]?.value).toBe(1);
    expect(parsed.get("messages_react_processed_total")?.[0]?.value).toBe(5);
    expect(parsed.get("messages_react_errors_total")?.[0]?.value).toBe(1);

    // Metrics endpoint remains resilient if Redis lLen throws transiently
    queueManager.throwOnLengths = true;
    const resilientRes = await fetch(`${baseUrl}/metrics`);
    expect(resilientRes.status).toBe(200);
  });

  it("verifies healthy failover rollout end-to-end", async () => {
    const { baseUrl } = await startTestGateway({ gatewayMode: "failover" });
    const report = await verifyRollout({ baseUrl });

    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it("verifies healthy baileys_only rollout with 404 DISABLED on /qr/wwebjs", async () => {
    const { baseUrl } = await startTestGateway({ gatewayMode: "baileys_only" });
    const report = await verifyRollout({ baseUrl });

    expect(report.ok).toBe(true);
    const wwebjsCheck = report.checks.find((c) => c.name === "qr_wwebjs");
    expect(wwebjsCheck?.passed).toBe(true);
    expect(wwebjsCheck?.detail).toContain("baileys_only");
  });

  it("fails rollout verification on DLQ breach, degraded fallback, down state, or unpaired QR", async () => {
    const { baseUrl, primaryDriver, standbyDriver, orchestrator, queueManager } =
      await startTestGateway({ dlqLength: 2 });

    const dlqFail = await verifyRollout({ baseUrl, maxDlqMessages: 0 });
    expect(dlqFail.ok).toBe(false);
    expect(dlqFail.checks.find((c) => c.name === "dlq_depth")?.passed).toBe(false);

    const dlqAllowed = await verifyRollout({ baseUrl, maxDlqMessages: 2 });
    expect(dlqAllowed.ok).toBe(true);

    // Reset DLQ and test unpaired standby QR while primary is connected
    queueManager.dlqLength = 0;
    (standbyDriver as MockDriver).setStatus({ state: "PAIRING_QR_READY", connected: false });
    const unpairedFail = await verifyRollout({ baseUrl });
    expect(unpairedFail.ok).toBe(false);
    expect(unpairedFail.checks.find((c) => c.name === "qr_wwebjs")?.passed).toBe(false);

    const unpairedAllowed = await verifyRollout({
      baseUrl,
      allowUnpaired: true,
    });
    expect(unpairedAllowed.ok).toBe(true);

    // Unpaired primary QR is accepted by qr_baileys check only with allowUnpaired, though health is 503 down
    primaryDriver.setStatus({ state: "PAIRING_QR_READY", connected: false });
    const primaryUnpaired = await verifyRollout({ baseUrl, allowUnpaired: true });
    expect(primaryUnpaired.checks.find((c) => c.name === "qr_baileys")?.passed).toBe(true);
    expect(primaryUnpaired.checks.find((c) => c.name === "http_health")?.passed).toBe(false);

    // Test degraded FALLBACK_ACTIVE state
    (standbyDriver as MockDriver).setStatus({ state: "CONNECTED", connected: true });
    const internalOrchestrator = orchestrator as unknown as { state: FailoverState };
    internalOrchestrator.state = "FALLBACK_ACTIVE";

    const degradedRejected = await verifyRollout({ baseUrl, allowUnpaired: true });
    expect(degradedRejected.ok).toBe(false);
    expect(degradedRejected.checks.find((c) => c.name === "http_health")?.passed).toBe(false);

    const degradedAllowed = await verifyRollout({
      baseUrl,
      allowDegraded: true,
      allowUnpaired: true,
    });
    expect(degradedAllowed.ok).toBe(true);

    // Test 503 down state
    (standbyDriver as MockDriver).setStatus({ state: "DISCONNECTED", connected: false });
    internalOrchestrator.state = "FENCING";
    const downReport = await verifyRollout({ baseUrl, allowDegraded: true, allowUnpaired: true });
    expect(downReport.ok).toBe(false);
    expect(downReport.checks.find((c) => c.name === "http_health")?.passed).toBe(false);
  });

  it("parses rollout CLI arguments cleanly", () => {
    const parsed = parseRolloutCliArgs([
      "--url",
      "http://127.0.0.1:4100",
      "--allow-degraded",
      "--allow-unpaired",
      "--max-dlq",
      "5",
    ]);

    expect(parsed.baseUrl).toBe("http://127.0.0.1:4100");
    expect(parsed.allowDegraded).toBe(true);
    expect(parsed.allowUnpaired).toBe(true);
    expect(parsed.maxDlqMessages).toBe(5);
  });

  it("ships valid Grafana dashboard JSON and Prometheus alert rules referencing exported metrics", () => {
    const dashboardPath = resolve("docs/observability/grafana-dashboard.json");
    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8")) as {
      title: string;
      panels: Array<{ targets: Array<{ expr: string }> }>;
    };
    expect(dashboard.title).toContain("baileys-wwebjs-failover");
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);

    const alertsPath = resolve("docs/observability/prometheus-alerts.yml");
    const alertsYaml = readFileSync(alertsPath, "utf8");
    expect(alertsYaml).toContain("GatewayDown");
    expect(alertsYaml).toContain("GatewayFailoverFlapping");
    expect(alertsYaml).toContain("GatewayDeadLetterQueueNonEmpty");
    expect(alertsYaml).toContain("GatewayChromiumRestartLoop");
  });
});
