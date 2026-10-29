import type { EngineName, EngineStatus } from "../contracts/driver.js";

/**
 * Core lifecycle states of the Failover Orchestrator finite state machine.
 *
 * INVARIANT: Matches the 6 lifecycle states documented in .agent/NOTES.md:
 * - PRIMARY_ACTIVE: Primary running, Standby dormant, Outbound bound to primary.
 * - FENCING: Primary failing/killed, Standby dormant, Outbound paused/buffered.
 * - COLD_START_STANDBY: Standby booting (~15-30s), Outbound paused/buffered.
 * - FALLBACK_ACTIVE: Standby connected, Outbound bound to standby, Silent probe active.
 * - MAINTENANCE_KEEPALIVE: Standby temporary wakeup, Outbound bound to primary.
 * - RECOVERY_SWAP: Primary restored, Standby draining/destroying Chromium, Outbound paused.
 */
export type FailoverState =
  | "PRIMARY_ACTIVE"
  | "FENCING"
  | "COLD_START_STANDBY"
  | "FALLBACK_ACTIVE"
  | "MAINTENANCE_KEEPALIVE"
  | "RECOVERY_SWAP"
  | "SHUTDOWN";

/**
 * Discrete events triggering transitions in the Failover FSM.
 */
export type FailoverEvent =
  | "TRIP_CIRCUIT"
  | "FENCING_COMPLETE"
  | "STANDBY_READY"
  | "STANDBY_FAILED"
  | "PROBE_STABLE"
  | "PROBE_FAILED"
  | "RECOVERY_COMPLETE"
  | "ENTER_MAINTENANCE"
  | "EXIT_MAINTENANCE"
  | "MANUAL_FAILOVER"
  | "MANUAL_FAILBACK"
  | "SHUTDOWN";

/**
 * Snapshot of orchestrator state for observability and health endpoints.
 */
export interface FailoverSnapshot {
  readonly state: FailoverState;
  readonly activeEngine: EngineName | null;
  readonly primaryStatus: EngineStatus;
  readonly standbyStatus: EngineStatus;
  readonly bufferedMessagesCount: number;
  readonly failureCount: number;
  readonly failoverCount?: number | undefined;
  readonly failbackCount?: number | undefined;
  readonly lastTransitionAt: Date;
  readonly lastError?: string | undefined;
}

/**
 * Transition listener signature.
 */
export type StateChangeListener = (
  from: FailoverState,
  to: FailoverState,
  event: FailoverEvent,
  reason?: string,
) => void;
