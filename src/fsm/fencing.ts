import type { EngineName } from "../contracts/driver.js";

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
 * Task [01.6] will provide the Redis-backed distributed implementation (SET NX EX).
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
