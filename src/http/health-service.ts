import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import type { FailoverState } from "../fsm/types.js";
import type { QueueManagerStatus, RedisQueueManager } from "../queues/manager.js";
import type { HealthResponsePayload, HealthStatus } from "./types.js";

export interface HealthServiceDependencies {
  readonly orchestrator: FailoverOrchestrator;
  readonly primaryDriver: IWhatsAppDriver;
  readonly standbyDriver: IWhatsAppDriver;
  readonly queueManager?: RedisQueueManager | undefined;
}

/**
 * Service aggregating health telemetry across multi-engine drivers, FSM orchestrator,
 * and Redis queues into a canonical status report.
 */
export class HealthService {
  private readonly orchestrator: FailoverOrchestrator;
  private readonly primaryDriver: IWhatsAppDriver;
  private readonly standbyDriver: IWhatsAppDriver;
  private readonly queueManager?: RedisQueueManager | undefined;

  constructor(dependencies: HealthServiceDependencies) {
    this.orchestrator = dependencies.orchestrator;
    this.primaryDriver = dependencies.primaryDriver;
    this.standbyDriver = dependencies.standbyDriver;
    this.queueManager = dependencies.queueManager;
  }

  public getHealth(): HealthResponsePayload {
    const fsmState = this.orchestrator.getState();
    const activeEngine = this.orchestrator.getActiveEngine();
    const primaryStatus = this.primaryDriver.getStatus();
    const standbyStatus = this.standbyDriver.getStatus();
    const queueStatus = this.queueManager?.getStatus();

    const status = this.calculateHolisticStatus(
      fsmState,
      primaryStatus.connected,
      standbyStatus.connected,
      queueStatus,
    );

    return {
      status,
      active_engine: activeEngine,
      fsm_state: fsmState,
      primary: primaryStatus,
      standby: standbyStatus,
      ...(queueStatus ? { queues: queueStatus } : {}),
    };
  }

  /**
   * INVARIANT: Computes multi-engine health based on FSM state, active engine connectivity,
   * and Redis queue manager status.
   * - "ok": Primary engine connected in PRIMARY_ACTIVE (or during non-disruptive MAINTENANCE_KEEPALIVE)
   * - "degraded": Operating on backup standby during FALLBACK_ACTIVE or undergoing transitional cold-start/swap
   * - "down": Neither engine connected or fatal queue/socket partition
   */
  private calculateHolisticStatus(
    fsmState: FailoverState,
    primaryConnected: boolean,
    standbyConnected: boolean,
    queueStatus?: QueueManagerStatus,
  ): HealthStatus {
    const queuesReady = queueStatus ? queueStatus.isOpen : true;

    if (!queuesReady) {
      return "degraded";
    }

    if (fsmState === "PRIMARY_ACTIVE" && primaryConnected) {
      return "ok";
    }

    if (fsmState === "MAINTENANCE_KEEPALIVE" && primaryConnected) {
      return "ok";
    }

    if (fsmState === "FALLBACK_ACTIVE" && standbyConnected) {
      return "degraded";
    }

    if (fsmState === "COLD_START_STANDBY" || fsmState === "RECOVERY_SWAP") {
      return "degraded";
    }

    if (primaryConnected || standbyConnected) {
      return "degraded";
    }

    return "down";
  }
}
