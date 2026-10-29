import type { EngineName } from "../contracts/driver.js";
import { DEFAULT_FENCING_KEY, type IRedisClient } from "../queues/types.js";

/**
 * Interface for distributed or local fencing lock.
 *
 * INVARIANT: Hard fencing ensures strictly one engine is designated as active
 * consumer/producer at any point in time, preventing split-brain execution.
 */
export interface IFencingLock {
  acquire(engine: EngineName): Promise<boolean>;
  release(engine: EngineName): Promise<void>;
  getCurrentHolder(): Promise<EngineName | null>;
}

/**
 * In-memory hermetic implementation of IFencingLock for local dev and unit testing.
 */
export class InMemoryFencingLock implements IFencingLock {
  private currentHolder: EngineName | null = null;

  async acquire(engine: EngineName): Promise<boolean> {
    if (this.currentHolder === null || this.currentHolder === engine) {
      this.currentHolder = engine;
      return true;
    }
    return false;
  }

  async release(engine: EngineName): Promise<void> {
    if (this.currentHolder === engine) {
      this.currentHolder = null;
    }
  }

  async getCurrentHolder(): Promise<EngineName | null> {
    return this.currentHolder;
  }
}

export interface RedisFencingLockOptions {
  readonly client: IRedisClient;
  readonly key?: string | undefined;
  readonly ttlSeconds?: number | undefined;
}

/**
 * Distributed Redis-backed implementation of IFencingLock.
 *
 * INVARIANT: Uses SET NX EX to atomically lease the active engine role in Redis,
 * preventing split-brain situations when running in containerized or multi-instance environments.
 */
export class RedisFencingLock implements IFencingLock {
  private readonly client: IRedisClient;
  private readonly key: string;
  private readonly ttlSeconds: number | undefined;

  constructor(options: RedisFencingLockOptions) {
    this.client = options.client;
    this.key = options.key ?? DEFAULT_FENCING_KEY;
    this.ttlSeconds = options.ttlSeconds;
  }

  async acquire(engine: EngineName): Promise<boolean> {
    const current = await this.getCurrentHolder();
    if (current === engine) {
      return true;
    }

    const setOptions = this.ttlSeconds ? { NX: true, EX: this.ttlSeconds } : { NX: true };

    const result = await this.client.set(this.key, engine, setOptions);
    return result === "OK";
  }

  async release(engine: EngineName): Promise<void> {
    // INVARIANT: Only release if current holder matches the designated engine to avoid releasing an usurped lock
    if (typeof this.client.eval === "function") {
      try {
        await this.client.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          {
            keys: [this.key],
            arguments: [engine],
          },
        );
        return;
      } catch {
        // Fallback to check-and-delete if eval is restricted
      }
    }

    const current = await this.getCurrentHolder();
    if (current === engine) {
      await this.client.del(this.key);
    }
  }

  async getCurrentHolder(): Promise<EngineName | null> {
    const value = await this.client.get(this.key);
    if (value === "baileys" || value === "wwebjs") {
      return value;
    }
    return null;
  }
}
