import { RedisFencingLock } from "../fsm/fencing.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import { logger } from "../index.js";
import { RedisDeduplicator } from "./dedup-lock.js";
import { RedisInboundPublisher } from "./inbound-publisher.js";
import { RedisOutboundWorker } from "./outbound-worker.js";
import { RedisReactWorker } from "./react-worker.js";
import {
  DEFAULT_BLPOP_TIMEOUT_SECONDS,
  DEFAULT_DEDUP_PREFIX,
  DEFAULT_DEDUP_TTL_SECONDS,
  DEFAULT_DLQ_QUEUE,
  DEFAULT_INBOX_QUEUE,
  DEFAULT_LOW_PRIORITY_OUTBOUND_QUEUE,
  DEFAULT_NOTIFICATIONS_QUEUE,
  DEFAULT_OUTBOUND_QUEUE,
  DEFAULT_REACT_QUEUE,
  type InboundPublisherMetrics,
  type IRedisClient,
  type OutboundDelayConfig,
  type OutboundWorkerMetrics,
  type ReactWorkerMetrics,
} from "./types.js";

export interface RedisQueueManagerOptions {
  readonly client: IRedisClient;
  readonly blockingClient?: IRedisClient | undefined;
  readonly reactClient?: IRedisClient | undefined;
  readonly orchestrator: FailoverOrchestrator;
  readonly inboxQueueKey?: string | undefined;
  readonly outboundQueueKey?: string | undefined;
  readonly notificationsQueueKey?: string | undefined;
  readonly lowPriorityOutboundQueueKey?: string | undefined;
  readonly reactQueueKey?: string | undefined;
  readonly dlqQueueKey?: string | undefined;
  readonly maxSendRetries?: number | undefined;
  readonly dedupPrefix?: string | undefined;
  readonly dedupTtlSeconds?: number | undefined;
  readonly blpopTimeoutSeconds?: number | undefined;
  readonly pauseCheckIntervalMs?: number | undefined;
  readonly delayConfig?: Partial<OutboundDelayConfig> | undefined;
  readonly enableTypingPresence?: boolean | undefined;
}

export interface QueueManagerStatus {
  readonly isOpen: boolean;
  readonly publisher: InboundPublisherMetrics;
  readonly worker: OutboundWorkerMetrics;
  readonly react: ReactWorkerMetrics;
}

/**
 * Top-level manager orchestrating Redis queue pipelines:
 * - Subscribes to inbound messages from FailoverOrchestrator and publishes deduplicated payloads to inbox
 * - Consumes from priority outbound queue with failover backpressure awareness
 * - Consumes from whatsapp:react queue with dedicated socket
 * - Exposes distributed fencing lock and deduplicator primitives
 */
export class RedisQueueManager {
  private readonly client: IRedisClient;
  private readonly blockingClient: IRedisClient;
  private readonly reactClient: IRedisClient;
  private readonly orchestrator: FailoverOrchestrator;

  private readonly fencingLock: RedisFencingLock;
  private readonly deduplicator: RedisDeduplicator;
  private readonly publisher: RedisInboundPublisher;
  private readonly worker: RedisOutboundWorker;
  private readonly reactWorker: RedisReactWorker;
  private readonly inboxQueueKey: string;
  private readonly outboundQueueKey: string;
  private readonly notificationsQueueKey: string;
  private readonly lowPriorityOutboundQueueKey: string;
  private readonly reactQueueKey: string;
  private readonly dlqQueueKey: string;

  private unsubscribeInbound?: (() => void) | undefined = undefined;
  private isStarted = false;

  constructor(options: RedisQueueManagerOptions) {
    this.client = options.client;
    this.orchestrator = options.orchestrator;
    this.inboxQueueKey = options.inboxQueueKey ?? DEFAULT_INBOX_QUEUE;
    this.outboundQueueKey = options.outboundQueueKey ?? DEFAULT_OUTBOUND_QUEUE;
    this.notificationsQueueKey = options.notificationsQueueKey ?? DEFAULT_NOTIFICATIONS_QUEUE;
    this.lowPriorityOutboundQueueKey =
      options.lowPriorityOutboundQueueKey ?? DEFAULT_LOW_PRIORITY_OUTBOUND_QUEUE;
    this.reactQueueKey = options.reactQueueKey ?? DEFAULT_REACT_QUEUE;
    this.dlqQueueKey = options.dlqQueueKey ?? DEFAULT_DLQ_QUEUE;

    // INVARIANT: Redis BLPOP blocks the socket connection; dedicated client required for consumers
    this.blockingClient =
      options.blockingClient ??
      (typeof this.client.duplicate === "function" ? this.client.duplicate() : this.client);

    this.reactClient =
      options.reactClient ??
      (typeof this.client.duplicate === "function" ? this.client.duplicate() : this.client);

    this.fencingLock = new RedisFencingLock({
      client: this.client,
    });

    this.deduplicator = new RedisDeduplicator({
      client: this.client,
      prefix: options.dedupPrefix ?? DEFAULT_DEDUP_PREFIX,
      ttlSeconds: options.dedupTtlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS,
    });

    this.publisher = new RedisInboundPublisher({
      client: this.client,
      deduplicator: this.deduplicator,
      inboxQueueKey: this.inboxQueueKey,
    });

    this.worker = new RedisOutboundWorker({
      client: this.blockingClient,
      orchestrator: this.orchestrator,
      outboundQueueKey: this.outboundQueueKey,
      notificationsQueueKey: this.notificationsQueueKey,
      lowPriorityOutboundQueueKey: this.lowPriorityOutboundQueueKey,
      dlqQueueKey: this.dlqQueueKey,
      maxSendRetries: options.maxSendRetries,
      blpopTimeoutSeconds: options.blpopTimeoutSeconds ?? DEFAULT_BLPOP_TIMEOUT_SECONDS,
      pauseCheckIntervalMs: options.pauseCheckIntervalMs ?? 500,
      delayConfig: options.delayConfig,
      enableTypingPresence: options.enableTypingPresence,
    });

    this.reactWorker = new RedisReactWorker({
      client: this.reactClient,
      orchestrator: this.orchestrator,
      reactQueueKey: this.reactQueueKey,
      blpopTimeoutSeconds: options.blpopTimeoutSeconds ?? DEFAULT_BLPOP_TIMEOUT_SECONDS,
      pauseCheckIntervalMs: options.pauseCheckIntervalMs ?? 500,
    });
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    if (!this.client.isOpen && typeof this.client.connect === "function") {
      await this.client.connect();
    }
    if (
      this.blockingClient !== this.client &&
      !this.blockingClient.isOpen &&
      typeof this.blockingClient.connect === "function"
    ) {
      await this.blockingClient.connect();
    }
    if (
      this.reactClient !== this.client &&
      this.reactClient !== this.blockingClient &&
      !this.reactClient.isOpen &&
      typeof this.reactClient.connect === "function"
    ) {
      await this.reactClient.connect();
    }

    // Subscribe to inbound messages from the orchestrator
    this.unsubscribeInbound = this.orchestrator.onMessage(async (msg) => {
      await this.publisher.publish(msg);
    });

    // Start consuming outbound and react messages
    this.worker.start();
    this.reactWorker.start();
    this.isStarted = true;

    logger.info("RedisQueueManager initialized and started successfully");
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }
    this.isStarted = false;

    if (this.unsubscribeInbound) {
      this.unsubscribeInbound();
      this.unsubscribeInbound = undefined;
    }

    await Promise.all([this.worker.stop(), this.reactWorker.stop()]);

    if (
      this.reactClient !== this.client &&
      this.reactClient !== this.blockingClient &&
      this.reactClient.isOpen
    ) {
      await this.reactClient.disconnect();
    }
    if (this.blockingClient !== this.client && this.blockingClient.isOpen) {
      await this.blockingClient.disconnect();
    }
    if (this.client.isOpen) {
      await this.client.disconnect();
    }

    logger.info("RedisQueueManager stopped cleanly");
  }

  getFencingLock(): RedisFencingLock {
    return this.fencingLock;
  }

  getDeduplicator(): RedisDeduplicator {
    return this.deduplicator;
  }

  getPublisher(): RedisInboundPublisher {
    return this.publisher;
  }

  getWorker(): RedisOutboundWorker {
    return this.worker;
  }

  getReactWorker(): RedisReactWorker {
    return this.reactWorker;
  }

  getStatus(): QueueManagerStatus {
    return {
      isOpen: Boolean(this.client.isOpen ?? true),
      publisher: this.publisher.getMetrics(),
      worker: this.worker.getMetrics(),
      react: this.reactWorker.getMetrics(),
    };
  }

  /**
   * Asynchronously inspects queue depths across inbox, outbound, low-priority outbound, and dead-letter queues.
   *
   * INVARIANT: Safely falls back to zeroes if the Redis client is offline or lacks lLen method.
   */
  async getQueueLengths(): Promise<{
    inbox: number;
    outbound: number;
    notifications: number;
    outboundLow: number;
    react: number;
    dlq: number;
  }> {
    let inbox = 0;
    let outbound = 0;
    let notifications = 0;
    let outboundLow = 0;
    let react = 0;
    let dlq = 0;

    if (this.client.isOpen && typeof this.client.lLen === "function") {
      try {
        const [inboxLen, outboundLen, notificationsLen, outboundLowLen, reactLen, dlqLen] =
          await Promise.all([
            this.client.lLen(this.inboxQueueKey),
            this.client.lLen(this.outboundQueueKey),
            this.client.lLen(this.notificationsQueueKey),
            this.client.lLen(this.lowPriorityOutboundQueueKey),
            this.client.lLen(this.reactQueueKey),
            this.client.lLen(this.dlqQueueKey),
          ]);
        inbox = inboxLen ?? 0;
        outbound = outboundLen ?? 0;
        notifications = notificationsLen ?? 0;
        outboundLow = outboundLowLen ?? 0;
        react = reactLen ?? 0;
        dlq = dlqLen ?? 0;
      } catch {
        // Fallback to zeroes during client disconnection
      }
    }

    return { inbox, outbound, notifications, outboundLow, react, dlq };
  }
}
