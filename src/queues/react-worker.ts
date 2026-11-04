import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import type { FailoverState } from "../fsm/types.js";
import { logger } from "../index.js";
import {
  DEFAULT_BLPOP_TIMEOUT_SECONDS,
  DEFAULT_REACT_JITTER_MAX_MS,
  DEFAULT_REACT_JITTER_MIN_MS,
  DEFAULT_REACT_QUEUE,
  type IRedisClient,
  type ReactPayload,
  ReactPayloadSchema,
  type ReactWorkerMetrics,
} from "./types.js";

export interface RedisReactWorkerOptions {
  readonly client: IRedisClient;
  readonly orchestrator: FailoverOrchestrator;
  readonly reactQueueKey?: string | undefined;
  readonly blpopTimeoutSeconds?: number | undefined;
  readonly pauseCheckIntervalMs?: number | undefined;
  readonly minJitterMs?: number | undefined;
  readonly maxJitterMs?: number | undefined;
}

const TRANSITION_STATES: ReadonlySet<FailoverState> = new Set([
  "FENCING",
  "COLD_START_STANDBY",
  "RECOVERY_SWAP",
]);

/**
 * Dedicated consumer for emoji reactions on whatsapp:react via Redis BLPOP.
 *
 * INVARIANT: Must operate on a dedicated duplicate Redis socket to prevent
 * BLPOP blocking contention with outbound message queues (k-002).
 */
export class RedisReactWorker {
  private readonly client: IRedisClient;
  private readonly orchestrator: FailoverOrchestrator;
  private readonly reactQueueKey: string;
  private readonly blpopTimeoutSeconds: number;
  private readonly pauseCheckIntervalMs: number;
  private readonly minJitterMs: number;
  private readonly maxJitterMs: number;

  private isRunning = false;
  private isPaused = false;
  private loopPromise?: Promise<void> | undefined = undefined;
  private unsubscribeOrchestrator?: (() => void) | undefined = undefined;
  private pauseWakeupResolve?: (() => void) | undefined = undefined;
  private pauseTimer?: NodeJS.Timeout | undefined = undefined;
  private loopSleepTimer?: NodeJS.Timeout | undefined = undefined;
  private jitterTimer?: NodeJS.Timeout | undefined = undefined;
  private jitterResolve?: (() => void) | undefined = undefined;

  private processedCount = 0;
  private errorCount = 0;
  private lastProcessedAt?: Date | undefined = undefined;
  private lastError?: string | undefined = undefined;

  constructor(options: RedisReactWorkerOptions) {
    this.client = options.client;
    this.orchestrator = options.orchestrator;
    this.reactQueueKey = options.reactQueueKey ?? DEFAULT_REACT_QUEUE;
    this.blpopTimeoutSeconds = options.blpopTimeoutSeconds ?? DEFAULT_BLPOP_TIMEOUT_SECONDS;
    this.pauseCheckIntervalMs = options.pauseCheckIntervalMs ?? 500;
    this.minJitterMs = Math.max(0, options.minJitterMs ?? DEFAULT_REACT_JITTER_MIN_MS);
    this.maxJitterMs = Math.max(
      this.minJitterMs,
      options.maxJitterMs ?? DEFAULT_REACT_JITTER_MAX_MS,
    );
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    this.unsubscribeOrchestrator = this.orchestrator.onStateChange((_from, to) => {
      const shouldPause = TRANSITION_STATES.has(to);
      if (shouldPause) {
        this.isPaused = true;
      } else if (this.isPaused) {
        this.isPaused = false;
        this.triggerWakeup();
      }
    });

    this.loopPromise = this.runLoop();
    logger.info({ reactQueue: this.reactQueueKey }, "Redis react worker started");
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.unsubscribeOrchestrator) {
      this.unsubscribeOrchestrator();
      this.unsubscribeOrchestrator = undefined;
    }

    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }

    if (this.loopSleepTimer) {
      clearTimeout(this.loopSleepTimer);
      this.loopSleepTimer = undefined;
    }

    this.cancelJitter();
    this.triggerWakeup();

    try {
      if (this.loopPromise) {
        await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    } catch (err) {
      logger.error({ err }, "Error while awaiting react worker loop shutdown");
    } finally {
      this.loopPromise = undefined;
    }
  }

  private cancelJitter(): void {
    if (this.jitterTimer) {
      clearTimeout(this.jitterTimer);
      this.jitterTimer = undefined;
    }
    if (this.jitterResolve) {
      const resolve = this.jitterResolve;
      this.jitterResolve = undefined;
      resolve();
    }
  }

  private async sleepInterruptible(ms: number): Promise<boolean> {
    if (ms <= 0 || !this.isRunning) {
      return this.isRunning;
    }
    await new Promise<void>((resolve) => {
      this.jitterResolve = resolve;
      this.jitterTimer = setTimeout(() => {
        this.jitterTimer = undefined;
        if (this.jitterResolve === resolve) {
          this.jitterResolve = undefined;
          resolve();
        }
      }, ms);
      this.jitterTimer.unref?.();
    });
    return this.isRunning;
  }

  private calculateJitterDelay(): number {
    if (this.maxJitterMs <= 0 || this.maxJitterMs < this.minJitterMs) {
      return 0;
    }
    return Math.floor(Math.random() * (this.maxJitterMs - this.minJitterMs + 1)) + this.minJitterMs;
  }

  private triggerWakeup(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }
    if (this.pauseWakeupResolve) {
      const resolve = this.pauseWakeupResolve;
      this.pauseWakeupResolve = undefined;
      resolve();
    }
  }

  private async waitForResumeOrShutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.pauseWakeupResolve = resolve;
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = undefined;
        if (this.pauseWakeupResolve === resolve) {
          this.pauseWakeupResolve = undefined;
          resolve();
        }
      }, this.pauseCheckIntervalMs);
      this.pauseTimer.unref?.();
    });
  }

  private async processItem(element: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(element);
    } catch (parseErr) {
      logger.error({ parseErr, element }, "Failed to parse reaction JSON payload; discarding");
      return;
    }

    let payload: ReactPayload;
    try {
      payload = ReactPayloadSchema.parse(raw);
    } catch (valErr) {
      logger.error({ valErr, raw }, "Invalid reaction payload schema; discarding");
      return;
    }

    // INVARIANT: Apply randomized human delay (default 350ms-700ms) before dispatching reactions
    // to prevent automated companion bot detection by Meta anti-spam heuristics (k-015).
    const jitterDelay = this.calculateJitterDelay();
    if (jitterDelay > 0) {
      const stillRunning = await this.sleepInterruptible(jitterDelay);
      if (!stillRunning) {
        logger.warn(
          { messageId: payload.messageId, reaction: payload.reaction },
          "Reaction dispatch aborted during human jitter delay due to shutdown",
        );
        return;
      }
    }

    try {
      await this.orchestrator.sendReaction(payload.messageId, payload.reaction, payload.remoteJid);
      this.processedCount += 1;
      this.lastProcessedAt = new Date();
      logger.info(
        {
          messageId: payload.messageId,
          reaction: payload.reaction,
          remoteJid: payload.remoteJid,
          uuid: payload.uuid,
          jitterDelayMs: jitterDelay,
        },
        "Reaction dispatched successfully",
      );
    } catch (dispatchErr) {
      this.errorCount += 1;
      this.lastError = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      logger.error(
        { dispatchErr, messageId: payload.messageId, reaction: payload.reaction },
        "Failed to dispatch reaction via orchestrator",
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      const currentState = this.orchestrator.getState();
      if (TRANSITION_STATES.has(currentState)) {
        this.isPaused = true;
        await this.waitForResumeOrShutdown();
        continue;
      }

      this.isPaused = false;

      try {
        const item = await this.client.blPop(this.reactQueueKey, this.blpopTimeoutSeconds);
        if (!item?.element) {
          continue;
        }

        await this.processItem(item.element);
      } catch (err) {
        if (!this.isRunning) {
          break;
        }

        this.errorCount += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, queue: this.reactQueueKey },
          "Error in react worker loop; applying transient backoff",
        );

        await new Promise((resolve) => {
          this.loopSleepTimer = setTimeout(() => {
            this.loopSleepTimer = undefined;
            resolve(undefined);
          }, 1000);
          this.loopSleepTimer.unref?.();
        });
      }
    }
  }

  getMetrics(): ReactWorkerMetrics {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      lastProcessedAt: this.lastProcessedAt,
      lastError: this.lastError,
    };
  }
}
