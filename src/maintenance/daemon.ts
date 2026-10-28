import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import { logger as defaultLogger } from "../index.js";
import {
  calculateNextMaintenanceWindow,
  calculateTypingDelay,
  DEFAULT_SCHEDULE_CONFIG,
} from "./jitter.js";
import { generateDynamicKeepalivePayload } from "./payload.js";
import type {
  MaintenanceCycleResult,
  MaintenanceDaemonOptions,
  MaintenanceScheduleConfig,
  PayloadGenerator,
} from "./types.js";

/**
 * Standby Maintenance Daemon
 *
 * Runs periodic, anti-fingerprinting keep-alive cycles for the cold-standby WWebJS engine.
 * Prevents WhatsApp from expiring companion linked devices (14+ day companion idle rule)
 * without keeping a resident 500MB+ Chromium browser process running.
 */
export class StandbyMaintenanceDaemon {
  private readonly orchestrator: FailoverOrchestrator;
  private readonly standbyDriver: IWhatsAppDriver;
  private readonly scheduleConfig: MaintenanceScheduleConfig;
  private readonly selfChatJid: string | undefined;
  private readonly logger: Logger;
  private readonly payloadGenerator: PayloadGenerator;
  private readonly randomGenerator: () => number;

  private running = false;
  private cycleActive = false;
  private nextScheduledRun: Date | null = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(options: MaintenanceDaemonOptions) {
    this.orchestrator = options.orchestrator;
    this.standbyDriver = options.standbyDriver ?? options.orchestrator.getStandbyDriver();
    this.scheduleConfig = {
      ...DEFAULT_SCHEDULE_CONFIG,
      ...options.scheduleConfig,
    };
    this.selfChatJid = options.selfChatJid;
    this.logger = options.logger ?? defaultLogger;
    this.payloadGenerator = options.payloadGenerator ?? generateDynamicKeepalivePayload;
    this.randomGenerator = options.randomGenerator ?? Math.random;

    if (options.autoStart) {
      this.start();
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public isCycleActive(): boolean {
    return this.cycleActive;
  }

  public getNextScheduledRun(): Date | null {
    return this.nextScheduledRun;
  }

  public getSequence(): number {
    return this.sequence;
  }

  /**
   * Starts the maintenance scheduler.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("Starting StandbyMaintenanceDaemon scheduler");
    this.scheduleNext();
  }

  /**
   * Stops the maintenance scheduler and clears any active timers.
   */
  public stop(): void {
    this.running = false;
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    this.nextScheduledRun = null;
    this.logger.info("Stopped StandbyMaintenanceDaemon scheduler");
  }

  /**
   * Schedules the next keep-alive execution based on randomized jitter and quiet hours.
   */
  public scheduleNext(): Date {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }

    const nextDate = calculateNextMaintenanceWindow(
      new Date(),
      this.scheduleConfig,
      this.randomGenerator,
    );
    this.nextScheduledRun = nextDate;

    if (this.running) {
      const delayMs = Math.max(0, nextDate.getTime() - Date.now());
      this.scheduledTimer = setTimeout(() => {
        void this.handleScheduledTick();
      }, delayMs);
      // Unref timer so it does not block Node.js process exit
      if (typeof this.scheduledTimer.unref === "function") {
        this.scheduledTimer.unref();
      }
    }

    this.logger.info(
      { nextRun: nextDate.toISOString() },
      "Scheduled next standby keep-alive maintenance window",
    );
    return nextDate;
  }

  /**
   * Manually or timer-triggered execution of a single maintenance keep-alive cycle.
   */
  public async triggerCycleNow(): Promise<MaintenanceCycleResult> {
    if (this.cycleActive) {
      throw new Error("Cannot trigger maintenance cycle: a cycle is already currently active");
    }

    // INVARIANT: Maintenance cycles must only execute when primary is active and healthy.
    // If failover is already active (standby active), standby is not idle and keepalive is redundant.
    const currentState = this.orchestrator.getState();
    if (currentState !== "PRIMARY_ACTIVE") {
      this.logger.warn(
        { state: currentState },
        "Skipping standby maintenance cycle because orchestrator is not in PRIMARY_ACTIVE state",
      );
      if (this.running) {
        this.scheduleNext();
      }
      throw new Error(
        `Cannot execute maintenance keepalive in orchestrator state ${currentState}; primary is not active`,
      );
    }

    this.cycleActive = true;
    const cycleId = randomUUID();
    const startedAt = new Date();
    this.sequence++;

    this.logger.info({ cycleId, sequence: this.sequence }, "Starting standby maintenance cycle");

    try {
      // 1. Coordinate with orchestrator to enter MAINTENANCE_KEEPALIVE and boot standby Chromium
      await this.orchestrator.enterMaintenanceKeepalive();

      // 2. Resolve self-chat target JID
      const targetJid = this.resolveTargetJid();
      if (!targetJid) {
        throw new Error(
          "Unable to resolve self-chat JID for keepalive (driver returned undefined and no selfChatJid configured)",
        );
      }

      // 3. Simulate typing presence (composing) for 3–5 seconds
      const typingDelayMs = calculateTypingDelay(
        this.scheduleConfig.typingDelayMinMs,
        this.scheduleConfig.typingDelayMaxMs,
        this.randomGenerator,
      );

      this.logger.debug(
        { targetJid, typingDelayMs },
        "Simulating typing presence before keepalive dispatch",
      );

      if (this.standbyDriver.sendPresence) {
        await this.standbyDriver.sendPresence(targetJid, "composing");
      }

      await this.sleep(typingDelayMs);

      // 4. Generate dynamic non-repeating payload and send strictly to self-chat
      const payload = this.payloadGenerator(targetJid, this.sequence);
      const receipt = await this.standbyDriver.sendMessage(targetJid, payload);

      // 5. Clear typing presence state
      if (this.standbyDriver.sendPresence) {
        await this.standbyDriver.sendPresence(targetJid, "paused");
      }

      // 6. Coordinate with orchestrator to exit MAINTENANCE_KEEPALIVE and teardown Chromium
      await this.orchestrator.exitMaintenanceKeepalive();

      // 7. Verify clean teardown of Chromium child processes / driver state
      this.verifyCleanTeardown();

      const completedAt = new Date();
      const nextScheduledRun = this.running ? this.scheduleNext() : new Date();

      this.logger.info(
        {
          cycleId,
          receiptId: receipt.id,
          targetJid,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
        "Standby maintenance cycle completed successfully; Chromium RAM released",
      );

      return {
        cycleId,
        startedAt,
        completedAt,
        targetJid,
        messageReceiptId: receipt.id,
        typingDelayMs,
        nextScheduledRun,
        success: true,
      };
    } catch (error) {
      this.logger.error({ error, cycleId }, "Error during standby maintenance cycle");

      // INVARIANT: Guarantee teardown attempt on failure to prevent leaked Chromium zombies
      try {
        if (this.orchestrator.getState() === "MAINTENANCE_KEEPALIVE") {
          await this.orchestrator.exitMaintenanceKeepalive();
        } else {
          await this.standbyDriver.disconnect();
        }
      } catch (cleanupErr) {
        this.logger.error({ cleanupErr }, "Failed during emergency maintenance cleanup");
      }

      if (this.running) {
        this.scheduleNext();
      }

      throw error;
    } finally {
      this.cycleActive = false;
    }
  }

  private async handleScheduledTick(): Promise<void> {
    try {
      await this.triggerCycleNow();
    } catch (err) {
      this.logger.warn(
        { err },
        "Scheduled keep-alive cycle encountered an error; will retry next window",
      );
    }
  }

  private resolveTargetJid(): string | undefined {
    if (this.selfChatJid) {
      return this.selfChatJid;
    }
    return this.standbyDriver.getSelfJid?.();
  }

  private verifyCleanTeardown(): void {
    const status = this.standbyDriver.getStatus();
    if (status.connected || status.state !== "DISCONNECTED") {
      this.logger.warn(
        { status },
        "Standby driver not cleanly disconnected after maintenance cycle",
      );
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
