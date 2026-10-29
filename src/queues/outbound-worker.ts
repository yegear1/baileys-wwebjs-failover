import type { OutboundMessage } from "../contracts/messages.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import type { FailoverState } from "../fsm/types.js";
import { logger } from "../index.js";
import {
  DEFAULT_BLPOP_TIMEOUT_SECONDS,
  DEFAULT_DLQ_QUEUE,
  DEFAULT_MAX_SEND_RETRIES,
  DEFAULT_OUTBOUND_QUEUE,
  type IRedisClient,
  type NormalizedOutboundRequest,
  type OutboundQueuePayload,
  OutboundQueuePayloadSchema,
  type OutboundWorkerMetrics,
} from "./types.js";

export interface RedisOutboundWorkerOptions {
  readonly client: IRedisClient;
  readonly orchestrator: FailoverOrchestrator;
  readonly outboundQueueKey?: string | undefined;
  readonly dlqQueueKey?: string | undefined;
  readonly maxSendRetries?: number | undefined;
  readonly blpopTimeoutSeconds?: number | undefined;
  readonly pauseCheckIntervalMs?: number | undefined;
}

/**
 * States during which outbound dispatch must be paused and left in Redis buffer.
 */
const TRANSITION_STATES: ReadonlySet<FailoverState> = new Set([
  "FENCING",
  "COLD_START_STANDBY",
  "RECOVERY_SWAP",
]);

/**
 * Normalizes outbound queue payloads accepting both canonical whatsapp-api schemas
 * and native gateway message objects.
 */
export function normalizeOutboundPayload(raw: unknown): NormalizedOutboundRequest {
  const parsed: OutboundQueuePayload = OutboundQueuePayloadSchema.parse(raw);

  if ("phone_number" in parsed) {
    const to = parsed.phone_number.trim();
    const content: OutboundMessage = {
      to,
      type: "text",
      text: parsed.content,
      media: parsed.media,
      quotedMessageId: parsed.quote_id ?? undefined,
    };
    return {
      id: parsed.id ?? undefined,
      to,
      content,
      retryCount: parsed.retryCount,
    };
  }

  const to = parsed.to.trim();
  const content: OutboundMessage = {
    to,
    type: parsed.type,
    text: parsed.text,
    media: parsed.media,
    quotedMessageId: parsed.quotedMessageId ?? undefined,
  };
  return {
    id: parsed.id ?? undefined,
    to,
    content,
    retryCount: parsed.retryCount,
  };
}

/**
 * Outbound worker consuming from whatsapp:send:priority via Redis BLPOP.
 *
 * INVARIANT: Graceful backpressure halts BLPOP consumption while the orchestrator
 * is in failover transition states (FENCING, COLD_START_STANDBY, RECOVERY_SWAP).
 * This keeps outbound messages safely in Redis rather than vulnerable in process memory.
 */
export class RedisOutboundWorker {
  private readonly client: IRedisClient;
  private readonly orchestrator: FailoverOrchestrator;
  private readonly outboundQueueKey: string;
  private readonly dlqQueueKey: string;
  private readonly maxSendRetries: number;
  private readonly blpopTimeoutSeconds: number;
  private readonly pauseCheckIntervalMs: number;

  private isRunning = false;
  private isPaused = false;
  private loopPromise?: Promise<void> | undefined = undefined;
  private unsubscribeOrchestrator?: (() => void) | undefined = undefined;
  private pauseWakeupResolve?: (() => void) | undefined = undefined;

  private processedCount = 0;
  private errorCount = 0;
  private requeuedCount = 0;
  private dlqCount = 0;
  private lastProcessedAt?: Date | undefined = undefined;
  private lastError?: string | undefined = undefined;

  constructor(options: RedisOutboundWorkerOptions) {
    this.client = options.client;
    this.orchestrator = options.orchestrator;
    this.outboundQueueKey = options.outboundQueueKey ?? DEFAULT_OUTBOUND_QUEUE;
    this.dlqQueueKey = options.dlqQueueKey ?? DEFAULT_DLQ_QUEUE;
    this.maxSendRetries = options.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
    this.blpopTimeoutSeconds = options.blpopTimeoutSeconds ?? DEFAULT_BLPOP_TIMEOUT_SECONDS;
    this.pauseCheckIntervalMs = options.pauseCheckIntervalMs ?? 500;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    // React immediately to orchestrator state transitions
    this.unsubscribeOrchestrator = this.orchestrator.onStateChange((_from, to, _event, _reason) => {
      const shouldPause = TRANSITION_STATES.has(to);
      if (shouldPause) {
        this.isPaused = true;
        logger.warn(
          { state: to },
          "Orchestrator entering transition state; pausing outbound queue worker",
        );
      } else if (this.isPaused) {
        this.isPaused = false;
        logger.info({ state: to }, "Failover completed; resuming outbound queue worker");
        this.triggerWakeup();
      }
    });

    this.loopPromise = this.runLoop();
    logger.info({ queue: this.outboundQueueKey }, "Redis outbound worker started");
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

    this.triggerWakeup();

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = undefined;
    }

    logger.info("Redis outbound worker stopped");
  }

  getMetrics(): OutboundWorkerMetrics {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      requeuedCount: this.requeuedCount,
      dlqCount: this.dlqCount,
      lastProcessedAt: this.lastProcessedAt,
      lastError: this.lastError,
    };
  }

  private triggerWakeup(): void {
    if (this.pauseWakeupResolve) {
      const resolve = this.pauseWakeupResolve;
      this.pauseWakeupResolve = undefined;
      resolve();
    }
  }

  private async waitForResumeOrShutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.pauseWakeupResolve = resolve;
      const timer = setTimeout(() => {
        if (this.pauseWakeupResolve === resolve) {
          this.pauseWakeupResolve = undefined;
          resolve();
        }
      }, this.pauseCheckIntervalMs);
      timer.unref?.();
    });
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      const currentState = this.orchestrator.getState();

      // INVARIANT: Hold message queueing inside Redis during active failover/recovery transitions
      if (TRANSITION_STATES.has(currentState)) {
        this.isPaused = true;
        await this.waitForResumeOrShutdown();
        continue;
      }

      this.isPaused = false;

      try {
        const item = await this.client.blPop(this.outboundQueueKey, this.blpopTimeoutSeconds);

        if (!item?.element) {
          // Timeout reached with no element available; continue loop
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
          { err, queue: this.outboundQueueKey },
          "Error in outbound worker loop; applying transient backoff",
        );

        // Sleep briefly before retrying to prevent hot loop on Redis disconnect
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async processItem(rawString: string): Promise<void> {
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawString);
    } catch (parseErr) {
      this.errorCount += 1;
      this.lastError = `JSON parse failure: ${String(parseErr)}`;
      await this.pushToDlq(rawString, `JSON parse failure: ${String(parseErr)}`);
      logger.error(
        { rawString, err: parseErr, dlqQueueKey: this.dlqQueueKey },
        "Moved malformed non-JSON payload from outbound queue to DLQ",
      );
      return;
    }

    let request: NormalizedOutboundRequest;
    try {
      request = normalizeOutboundPayload(rawJson);
    } catch (schemaErr) {
      this.errorCount += 1;
      this.lastError = `Schema validation failure: ${String(schemaErr)}`;
      await this.pushToDlq(rawJson, `Schema validation failure: ${String(schemaErr)}`);
      logger.error(
        { rawJson, err: schemaErr, dlqQueueKey: this.dlqQueueKey },
        "Moved payload failing OutboundQueuePayloadSchema validation to DLQ",
      );
      return;
    }

    try {
      logger.info(
        {
          id: request.id,
          to: request.to,
          type: request.content.type,
        },
        "Dispatching outbound message via orchestrator",
      );

      const receipt = await this.orchestrator.sendMessage(request.to, request.content);

      this.processedCount += 1;
      this.lastProcessedAt = new Date();

      logger.info(
        {
          id: request.id,
          receiptId: receipt.id,
          status: receipt.status,
          to: request.to,
        },
        "Outbound message successfully dispatched",
      );
    } catch (dispatchErr) {
      await this.handleDispatchFailure(request, rawJson, dispatchErr);
    }
  }

  private async pushToDlq(payload: unknown, reason: string): Promise<void> {
    this.dlqCount += 1;
    const dlqPayload = {
      ...(typeof payload === "object" && payload !== null ? payload : { raw: payload }),
      dlqReason: reason,
      dlqTimestamp: new Date().toISOString(),
    };
    try {
      await this.client.lPush(this.dlqQueueKey, JSON.stringify(dlqPayload));
    } catch (err) {
      logger.error({ err, dlqQueueKey: this.dlqQueueKey }, "Failed pushing payload to DLQ");
    }
  }

  private async handleDispatchFailure(
    request: NormalizedOutboundRequest,
    rawJson: unknown,
    dispatchErr: unknown,
  ): Promise<void> {
    this.errorCount += 1;
    const errorMessage = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    this.lastError = errorMessage;

    const currentRetries = request.retryCount ?? 0;

    // INVARIANT: Do not penalize retry count or route to DLQ on graceful shutdown cancellation;
    // preserve payload in priority queue so next gateway startup resumes processing safely.
    const isShutdownError =
      !this.isRunning ||
      errorMessage.includes("shutting down") ||
      errorMessage.includes("buffer cancelled");

    if (isShutdownError) {
      const requeuePayload = {
        ...(typeof rawJson === "object" && rawJson !== null ? rawJson : {}),
        retryCount: currentRetries,
        lastError: errorMessage,
        requeuedAt: new Date().toISOString(),
      };
      try {
        await this.client.lPush(this.outboundQueueKey, JSON.stringify(requeuePayload));
        this.requeuedCount += 1;
        logger.info(
          { id: request.id, to: request.to },
          "Preserved in-flight message to outbound queue due to shutdown cancellation",
        );
      } catch (err) {
        logger.error({ err }, "Failed re-queueing outbound message to Redis on shutdown");
      }
      return;
    }

    const nextRetries = currentRetries + 1;

    if (nextRetries < this.maxSendRetries) {
      const requeuePayload = {
        ...(typeof rawJson === "object" && rawJson !== null ? rawJson : {}),
        retryCount: nextRetries,
        lastError: errorMessage,
        requeuedAt: new Date().toISOString(),
      };
      try {
        await this.client.lPush(this.outboundQueueKey, JSON.stringify(requeuePayload));
        this.requeuedCount += 1;
        logger.warn(
          {
            id: request.id,
            to: request.to,
            retryCount: nextRetries,
            maxSendRetries: this.maxSendRetries,
            err: dispatchErr,
          },
          "Outbound message dispatch failed; re-queued to priority outbound queue",
        );
      } catch (err) {
        logger.error({ err }, "Failed re-queueing outbound message to Redis");
      }
    } else {
      await this.pushToDlq(
        {
          ...(typeof rawJson === "object" && rawJson !== null ? rawJson : {}),
          retryCount: nextRetries,
        },
        `Max send retries (${this.maxSendRetries}) exceeded: ${errorMessage}`,
      );
      logger.error(
        {
          id: request.id,
          to: request.to,
          dlqQueueKey: this.dlqQueueKey,
          retryCount: nextRetries,
          err: dispatchErr,
        },
        "Outbound message exceeded max send retries; moved to DLQ",
      );
    }
  }
}
