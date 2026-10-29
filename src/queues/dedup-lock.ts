import type { InboundMessage } from "../contracts/messages.js";
import { calculateDedupCandidateHashes } from "../utils/dedup.js";
import { DEFAULT_DEDUP_PREFIX, DEFAULT_DEDUP_TTL_SECONDS, type IRedisClient } from "./types.js";

export interface RedisDeduplicatorOptions {
  readonly client: IRedisClient;
  readonly prefix?: string;
  readonly ttlSeconds?: number;
  readonly clockSkewSeconds?: number;
}

/**
 * Distributed deduplication filter using Redis SET NX EX.
 *
 * INVARIANT: Cross-device companion sockets (Baileys and WWebJS) receive identical
 * messages with slight clock skew (±5s). We generate candidate hashes across adjacent
 * 10-second buckets and atomically acquire the deduplication lock with 300s TTL.
 */
export class RedisDeduplicator {
  private readonly client: IRedisClient;
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  private readonly clockSkewSeconds: number;

  constructor(options: RedisDeduplicatorOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? DEFAULT_DEDUP_PREFIX;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 5;
  }

  /**
   * Attempts to acquire an atomic deduplication lock for an inbound message.
   *
   * @returns true if the message is novel and the lock was acquired;
   *          false if the message is a duplicate within the clock-skew / TTL window.
   */
  async acquireLock(msg: InboundMessage): Promise<boolean> {
    const candidateHashes = calculateDedupCandidateHashes(
      {
        remoteJid: msg.remoteJid,
        senderJid: msg.senderJid,
        timestamp: msg.timestamp,
        textBody: msg.textBody,
        mediaDigest: msg.media?.digest,
      },
      this.clockSkewSeconds,
    );

    const candidateKeys = candidateHashes.map((h) => `${this.prefix}${h}`);

    // Check if any candidate key already exists in Redis
    if (typeof this.client.mGet === "function") {
      const values = await this.client.mGet(candidateKeys);
      if (values.some((val) => val !== null)) {
        return false;
      }
    } else {
      const results = await Promise.all(candidateKeys.map((key) => this.client.get(key)));
      if (results.some((val) => val !== null)) {
        return false;
      }
    }

    // Atomically set primary dedup key with NX and TTL
    const primaryKey = `${this.prefix}${msg.dedupHash}`;
    const acquired = await this.client.set(primaryKey, "1", {
      NX: true,
      EX: this.ttlSeconds,
    });

    if (acquired !== "OK") {
      return false;
    }

    // Cache remaining candidate keys to optimize lookups from adjacent buckets
    for (const hash of candidateHashes) {
      if (hash !== msg.dedupHash) {
        await this.client.set(`${this.prefix}${hash}`, "1", {
          EX: this.ttlSeconds,
        });
      }
    }

    return true;
  }

  /**
   * Releases or invalidates a deduplication lock (useful for tests or DLQ redelivery).
   */
  async releaseLock(hash: string): Promise<void> {
    await this.client.del(`${this.prefix}${hash}`);
  }
}
