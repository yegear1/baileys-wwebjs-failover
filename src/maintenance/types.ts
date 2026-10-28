import type { Logger } from "pino";
import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { OutboundMessage } from "../contracts/messages.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";

export interface MaintenanceScheduleConfig {
  /**
   * Minimum days before next keep-alive trigger (default: 3).
   */
  readonly minDays: number;
  /**
   * Maximum days before next keep-alive trigger (default: 5).
   */
  readonly maxDays: number;
  /**
   * Quiet hours window start hour in local time (default: 2, for 02:xx).
   */
  readonly windowStartHour: number;
  /**
   * Quiet hours window start minute in local time (default: 30, for xx:30).
   */
  readonly windowStartMinute: number;
  /**
   * Quiet hours window end hour in local time (default: 5, for 05:xx).
   */
  readonly windowEndHour: number;
  /**
   * Quiet hours window end minute in local time (default: 40, for xx:40).
   */
  readonly windowEndMinute: number;
  /**
   * Minimum simulated typing presence delay in milliseconds (default: 3,000 ms).
   */
  readonly typingDelayMinMs: number;
  /**
   * Maximum simulated typing presence delay in milliseconds (default: 5,000 ms).
   */
  readonly typingDelayMaxMs: number;
}

export interface MaintenanceCycleResult {
  readonly cycleId: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly targetJid: string;
  readonly messageReceiptId: string;
  readonly typingDelayMs: number;
  readonly nextScheduledRun: Date;
  readonly success: boolean;
  readonly error?: string;
}

export type PayloadGenerator = (to: string, sequence: number) => OutboundMessage;

export interface MaintenanceDaemonOptions {
  readonly orchestrator: FailoverOrchestrator;
  readonly standbyDriver?: IWhatsAppDriver;
  readonly scheduleConfig?: Partial<MaintenanceScheduleConfig>;
  /**
   * Manual override for self-chat JID (if not auto-discovered from standby driver).
   */
  readonly selfChatJid?: string | undefined;
  readonly logger?: Logger;
  readonly payloadGenerator?: PayloadGenerator;
  readonly randomGenerator?: () => number;
  /**
   * Whether to start timer immediately upon construction.
   * Default: false.
   */
  readonly autoStart?: boolean;
}
