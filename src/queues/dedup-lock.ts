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
 * Atomic Redis Lua script for cross-bucket deduplication:
 * - Checks all candidate keys across adjacent timestamp buckets.
 * - If any key exists, aborts and returns 0 (duplicate).
 * - If none exist, atomically sets all candidate keys with TTL EX and returns 1 (novel).
 * Eliminates cross-bucket race conditions and cuts Redis round-trips from 4 to 1.
 */
export const ATOMIC_DEDUP_LUA_SCRIPT = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then
    return 0
  end
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, '1', 'EX', ARGV[1])
end
return 1
`.trim();

/**
 * Distributed deduplication filter using atomic Redis Lua scripts with fallback to SET NX EX.
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

    // INVARIANT: Atomic Lua script checks candidate keys across adjacent buckets and claims them
    // in a single server turn to prevent cross-bucket race conditions and cut network RTT from 4 to 1.
    if (typeof this.client.eval === "function") {
      const result = await this.client.eval(ATOMIC_DEDUP_LUA_SCRIPT, {
        keys: candidateKeys,
        arguments: [String(this.ttlSeconds)],
      });
      return Number(result) === 1;
    }

    // Fallback if Redis client does not support EVAL (e.g. basic mock)
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
   * Releases or invalidates deduplication lock(s) (useful for tests or DLQ redelivery).
   * Accepts either a raw hash string or an InboundMessage to clear all candidate bucket keys.
   */
  async releaseLock(hashOrMsg: string | InboundMessage): Promise<void> {
    if (typeof hashOrMsg === "string") {
      await this.client.del(`${this.prefix}${hashOrMsg}`);
      return;
    }

    const candidateHashes = calculateDedupCandidateHashes(
      {
        remoteJid: hashOrMsg.remoteJid,
        senderJid: hashOrMsg.senderJid,
        timestamp: hashOrMsg.timestamp,
        textBody: hashOrMsg.textBody,
        mediaDigest: hashOrMsg.media?.digest,
      },
      this.clockSkewSeconds,
    );

    const keys = candidateHashes.map((h) => `${this.prefix}${h}`);
    await this.client.del(keys);
  }
}
