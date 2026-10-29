---
id: "k-009"
title: "Redis Lua EVAL Mock Atomicity and Outbound Queue Burst Backpressure"
date: 2026-10-29
tags:
  - "redis"
  - "lua"
  - "concurrency"
  - "deduplication"
  - "backpressure"
  - "load-testing"
severity: "medium"
affected_components:
  - "tests/fixtures/redis-test-env.ts"
  - "tests/load-concurrency.test.ts"
  - "src/queues/dedup-lock.ts"
  - "src/queues/outbound-worker.ts"
symptoms:
  - "Under high-concurrency synthetic storms (e.g. 200 concurrent duplicate events), an in-memory test Redis mock fails deduplication if candidate checks yield to the JS event loop"
  - "Concurrent bursts of outbound messages risk dropping or hanging if BLPOP workers yield inappropriately during failover state transitions"
---

# [k-009] Redis Lua EVAL Mock Atomicity and Outbound Queue Burst Backpressure

## Problem / Symptom

1. **Async Microtask Interleaving in In-Memory Lua Simulation:**
   In production, Redis executes Lua scripts (`EVAL`) sequentially on its single-threaded event loop, guaranteeing absolute atomicity: no other command or script can interleave between checking candidate keys and setting them.
   In local test harnesses using an `InMemoryRedisClient`, implementing `eval()` with `async` methods (`await this.get(key)`) causes execution to yield to the JavaScript microtask queue. When 200 concurrent emits occur via `Promise.all()`, every task performs the check before any task performs the `set`, defeating deduplication in tests even though production Redis is atomic.

2. **Outbound Queue Burst Backpressure Under Transition:**
   During failover transitions (`FENCING`, `COLD_START_STANDBY`, `RECOVERY_SWAP`), outbound dispatch must pause. If high-concurrency bursts arrive while the gateway is mid-failover, messages must remain persisted in Redis without loss or duplicate processing.

---

## Approved Solution

1. **Synchronous Atomic Simulation in Mock Redis EVAL:**
   In `InMemoryRedisClient.eval`, access the in-memory `Map` synchronously without awaiting `this.get()` or yielding to microtasks:
   ```typescript
   if (script.includes("EXISTS")) {
     const keys = options?.keys ?? [];
     const ttlSec = options?.arguments?.[0] ? Number(options.arguments[0]) : 300;

     for (const k of keys) {
       const exp = this.expirations.get(k);
       if (exp !== undefined && Date.now() > exp) {
         this.store.delete(k);
         this.expirations.delete(k);
       } else if (this.store.has(k)) {
         return 0; // Duplicate detected atomically
       }
     }

     for (const k of keys) {
       this.store.set(k, "1");
       this.expirations.set(k, Date.now() + ttlSec * 1000);
     }

     return 1; // Novel message claimed atomically
   }
   ```

2. **Transition State Backpressure Invariant:**
   `RedisOutboundWorker` checks `TRANSITION_STATES.has(currentState)` before invoking `BLPOP`. If active, the worker sets `isPaused = true` and halts Redis dequeuing, leaving pending messages safely buffered in the Redis priority queue. When `FALLBACK_ACTIVE` or `PRIMARY_ACTIVE` is restored, the worker unpauses and drains the entire backlog without loss.

---

## Verification

- `tests/load-concurrency.test.ts` executes:
  - 200-message concurrent outbound bursts under simulated 2ms socket latency.
  - In-flight mid-burst failover with zero message loss (20 primary + 60 standby = 80 total).
  - 200 concurrent inbound emits (25 unique messages replicated 8x simultaneously), proving 25 delivered and 175 dropped.
  - Multi-stream bidirectional concurrency (60 outbound + 60 inbound + 10 metric scrapes simultaneously).
  - Orderly shutdown drain preserving unconsumed items in Redis for subsequent instances.
