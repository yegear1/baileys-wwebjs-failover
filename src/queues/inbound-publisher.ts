import type { InboundMessage } from "../contracts/messages.js";
import { logger } from "../index.js";
import { RedisDeduplicator } from "./dedup-lock.js";
import { DEFAULT_INBOX_QUEUE, type InboundPublisherMetrics, type IRedisClient } from "./types.js";

export interface RedisInboundPublisherOptions {
  readonly client: IRedisClient;
  readonly deduplicator?: RedisDeduplicator | undefined;
  readonly inboxQueueKey?: string | undefined;
}

export interface PublishResult {
  readonly published: boolean;
  readonly reason?: "DUPLICATE" | "ERROR" | undefined;
  readonly queueKey?: string | undefined;
}

/**
 * Publishes normalized inbound messages to the downstream Redis queue with
 * distributed deduplication protection.
 *
 * INVARIANT: Push to inbox queue (LPUSH whatsapp:receive:inbox) occurs strictly
 * after acquiring the atomic deduplication lock to guarantee at-most-once delivery.
 */
export class RedisInboundPublisher {
  private readonly client: IRedisClient;
  private readonly deduplicator: RedisDeduplicator;
  private readonly inboxQueueKey: string;

  private publishedCount = 0;
  private duplicateCount = 0;
  private lastPublishedAt?: Date | undefined;
  private lastDuplicateAt?: Date | undefined;

  constructor(options: RedisInboundPublisherOptions) {
    this.client = options.client;
    this.deduplicator = options.deduplicator ?? new RedisDeduplicator({ client: options.client });
    this.inboxQueueKey = options.inboxQueueKey ?? DEFAULT_INBOX_QUEUE;
  }

  async publish(msg: InboundMessage): Promise<PublishResult> {
    const isNovel = await this.deduplicator.acquireLock(msg);
    if (!isNovel) {
      this.duplicateCount += 1;
      this.lastDuplicateAt = new Date();
      logger.info(
        {
          id: msg.id,
          remoteJid: msg.remoteJid,
          dedupHash: msg.dedupHash,
        },
        "Inbound message discarded by deduplication lock",
      );
      return { published: false, reason: "DUPLICATE" };
    }

    try {
      const payloadString = JSON.stringify(msg);
      await this.client.lPush(this.inboxQueueKey, payloadString);

      this.publishedCount += 1;
      this.lastPublishedAt = new Date();

      logger.info(
        {
          id: msg.id,
          remoteJid: msg.remoteJid,
          queue: this.inboxQueueKey,
        },
        "Inbound message pushed to inbox queue",
      );

      return { published: true, queueKey: this.inboxQueueKey };
    } catch (err) {
      logger.error(
        {
          err,
          id: msg.id,
          queue: this.inboxQueueKey,
        },
        "Failed to push inbound message to Redis queue",
      );
      return { published: false, reason: "ERROR" };
    }
  }

  getMetrics(): InboundPublisherMetrics {
    return {
      publishedCount: this.publishedCount,
      duplicateCount: this.duplicateCount,
      lastPublishedAt: this.lastPublishedAt,
      lastDuplicateAt: this.lastDuplicateAt,
    };
  }
}
