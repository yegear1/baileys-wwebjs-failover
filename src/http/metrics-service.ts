import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import type { FailoverState } from "../fsm/types.js";
import type { RedisQueueManager } from "../queues/manager.js";
import type { HealthService } from "./health-service.js";
import type { HealthStatus } from "./types.js";

export interface MetricsServiceDependencies {
  readonly orchestrator: FailoverOrchestrator;
  readonly primaryDriver: IWhatsAppDriver;
  readonly standbyDriver: IWhatsAppDriver;
  readonly queueManager?: RedisQueueManager | undefined;
  readonly healthService?: HealthService | undefined;
}

const ALL_FSM_STATES: readonly FailoverState[] = [
  "PRIMARY_ACTIVE",
  "FENCING",
  "COLD_START_STANDBY",
  "FALLBACK_ACTIVE",
  "MAINTENANCE_KEEPALIVE",
  "RECOVERY_SWAP",
  "SHUTDOWN",
];

const ALL_HEALTH_STATUSES: readonly HealthStatus[] = ["ok", "degraded", "down"];

/**
 * Service generating and formatting real-time Prometheus exposition metrics.
 *
 * INVARIANT: Conforms to Prometheus text exposition format (version 0.0.4).
 * NEVER leaks credentials, pairing tokens, JIDs, phone numbers, or private message payloads.
 */
export class MetricsService {
  private readonly orchestrator: FailoverOrchestrator;
  private readonly primaryDriver: IWhatsAppDriver;
  private readonly standbyDriver: IWhatsAppDriver;
  private readonly queueManager?: RedisQueueManager | undefined;
  private readonly healthService?: HealthService | undefined;

  constructor(dependencies: MetricsServiceDependencies) {
    this.orchestrator = dependencies.orchestrator;
    this.primaryDriver = dependencies.primaryDriver;
    this.standbyDriver = dependencies.standbyDriver;
    this.queueManager = dependencies.queueManager;
    this.healthService = dependencies.healthService;
  }

  public async getMetrics(): Promise<string> {
    const lines: string[] = [];

    this.appendHealthMetrics(lines);
    this.appendFsmMetrics(lines);
    this.appendEngineMetrics(lines);
    await this.appendQueueMetrics(lines);

    return `${lines.join("\n")}\n`;
  }

  private appendHealthMetrics(lines: string[]): void {
    if (!this.healthService) return;

    const health = this.healthService.getHealth();
    lines.push(
      "# HELP gateway_health_status Holistic gateway service health status (1 = active, 0 = inactive).",
    );
    lines.push("# TYPE gateway_health_status gauge");
    for (const status of ALL_HEALTH_STATUSES) {
      lines.push(`gateway_health_status{status="${status}"} ${health.status === status ? 1 : 0}`);
    }
  }

  private appendFsmMetrics(lines: string[]): void {
    const snapshot = this.orchestrator.getSnapshot();
    const currentState = snapshot.state;

    lines.push(
      "# HELP failover_events_total Total number of failover transitions from primary to standby.",
    );
    lines.push("# TYPE failover_events_total counter");
    lines.push(`failover_events_total ${this.orchestrator.getFailoverCount()}`);

    lines.push(
      "# HELP failback_events_total Total number of recovery failback transitions to primary.",
    );
    lines.push("# TYPE failback_events_total counter");
    lines.push(`failback_events_total ${this.orchestrator.getFailbackCount()}`);

    lines.push(
      "# HELP fsm_state Current state of the failover orchestrator state machine (1 = active, 0 = inactive).",
    );
    lines.push("# TYPE fsm_state gauge");
    for (const state of ALL_FSM_STATES) {
      lines.push(`fsm_state{state="${state}"} ${currentState === state ? 1 : 0}`);
    }

    lines.push(
      "# HELP outbound_buffer_depth Number of in-flight outbound messages buffered in memory during transition states.",
    );
    lines.push("# TYPE outbound_buffer_depth gauge");
    lines.push(`outbound_buffer_depth ${snapshot.bufferedMessagesCount}`);

    lines.push(
      "# HELP circuit_breaker_consecutive_failures Current consecutive send failure count tracked by circuit breaker.",
    );
    lines.push("# TYPE circuit_breaker_consecutive_failures gauge");
    lines.push(`circuit_breaker_consecutive_failures ${snapshot.failureCount}`);
  }

  private appendEngineMetrics(lines: string[]): void {
    const primaryStatus = this.primaryDriver.getStatus();
    const standbyStatus = this.standbyDriver.getStatus();
    const latencies = this.orchestrator.getEngineLatencies();

    lines.push(
      "# HELP engine_status Connectivity state of WhatsApp driver engine (1 = connected, 0 = disconnected).",
    );
    lines.push("# TYPE engine_status gauge");
    lines.push(`engine_status{engine="baileys",role="primary"} ${primaryStatus.connected ? 1 : 0}`);
    lines.push(`engine_status{engine="wwebjs",role="standby"} ${standbyStatus.connected ? 1 : 0}`);

    lines.push(
      "# HELP engine_latency_seconds Last recorded message dispatch latency per engine in seconds.",
    );
    lines.push("# TYPE engine_latency_seconds gauge");
    lines.push(`engine_latency_seconds{engine="baileys"} ${latencies.baileys ?? 0}`);
    lines.push(`engine_latency_seconds{engine="wwebjs"} ${latencies.wwebjs ?? 0}`);

    if (
      "getTotalRestarts" in this.standbyDriver &&
      typeof (this.standbyDriver as { getTotalRestarts?: () => number }).getTotalRestarts ===
        "function"
    ) {
      const restarts = (
        this.standbyDriver as { getTotalRestarts: () => number }
      ).getTotalRestarts();
      lines.push(
        "# HELP chromium_restarts_total Total number of Puppeteer/Chromium restarts executed for recovery.",
      );
      lines.push("# TYPE chromium_restarts_total counter");
      lines.push(`chromium_restarts_total ${restarts}`);
    }
  }

  private async appendQueueMetrics(lines: string[]): Promise<void> {
    const queueStatus = this.queueManager?.getStatus();
    let queueLengths = { inbox: 0, outbound: 0, dlq: 0 };

    if (this.queueManager && typeof this.queueManager.getQueueLengths === "function") {
      queueLengths = await this.queueManager.getQueueLengths();
    }

    lines.push(
      "# HELP queue_length Estimated count of elements currently waiting in Redis queues.",
    );
    lines.push("# TYPE queue_length gauge");
    lines.push(`queue_length{queue="inbox"} ${queueLengths.inbox}`);
    lines.push(`queue_length{queue="outbound"} ${queueLengths.outbound}`);
    lines.push(`queue_length{queue="dlq"} ${queueLengths.dlq}`);

    const dlqTotal = queueStatus?.worker.dlqCount ?? 0;
    lines.push(
      "# HELP dlq_messages_total Total number of messages routed to the dead-letter queue after retry exhaustion.",
    );
    lines.push("# TYPE dlq_messages_total counter");
    lines.push(`dlq_messages_total ${dlqTotal}`);

    const processedTotal = queueStatus?.worker.processedCount ?? 0;
    lines.push("# HELP messages_processed_total Total number of outbound messages processed.");
    lines.push("# TYPE messages_processed_total counter");
    lines.push(`messages_processed_total ${processedTotal}`);

    const requeuedTotal = queueStatus?.worker.requeuedCount ?? 0;
    lines.push(
      "# HELP messages_requeued_total Total number of outbound messages re-queued due to transient dispatch failures.",
    );
    lines.push("# TYPE messages_requeued_total counter");
    lines.push(`messages_requeued_total ${requeuedTotal}`);

    const publishedTotal = queueStatus?.publisher.publishedCount ?? 0;
    lines.push(
      "# HELP messages_inbound_published_total Total number of deduplicated inbound messages published to inbox.",
    );
    lines.push("# TYPE messages_inbound_published_total counter");
    lines.push(`messages_inbound_published_total ${publishedTotal}`);

    const duplicateTotal = queueStatus?.publisher.duplicateCount ?? 0;
    lines.push(
      "# HELP messages_inbound_duplicate_total Total number of duplicate inbound messages filtered out.",
    );
    lines.push("# TYPE messages_inbound_duplicate_total counter");
    lines.push(`messages_inbound_duplicate_total ${duplicateTotal}`);
  }
}
