---
id: "k-004"
title: "Redis BLPOP Blocking Connection Isolation and Queue Concurrency"
date: 2026-10-28
tags:
  - "redis"
  - "queues"
  - "blpop"
  - "concurrency"
severity: "high"
affected_components:
  - "src/queues/manager.ts"
  - "src/queues/outbound-worker.ts"
symptoms:
  - "Socket hangup or command timeout when issuing SET, GET, or LPUSH while BLPOP is active"
  - "Failure of fencing lock renewal or deduplication checks during long-polling queue waits"
---

# [k-004] Redis BLPOP Blocking Connection Isolation and Queue Concurrency

## Problem / Symptom
In Node.js Redis clients (`redis` v4 / `@redis/client`), blocking operations like `BLPOP`, `BRPOP`, and `BZPOPMIN` hold the underlying TCP socket in a blocking state until either an element is available in the target list or the timeout expires:

```typescript
// ANTI-PATTERN: Reusing a single Redis client for both BLPOP and command execution
const client = createClient();
await client.connect();

// Thread 1 blocks the socket for up to 300 seconds
await client.blPop("whatsapp:send:priority", 300);

// Thread 2 attempts to acquire a deduplication lock or fencing lock
// Fails or hangs because socket is currently blocked waiting for BLPOP reply
await client.set("dedupe:msg:hash", "1", { NX: true });
```

If the gateway uses a single shared client instance, inbound message deduplication and orchestrator fencing checks freeze while the outbound worker awaits new outbound queue tasks.

---

## Approved Solution
Isolate blocking consumers using a dedicated connection created via `client.duplicate()`:

```typescript
// INVARIANT: Redis BLPOP blocks the socket connection; dedicated client required for consumers
const blockingClient = client.duplicate();
await blockingClient.connect();

// Outbound worker uses blockingClient exclusively for blPop
const worker = new RedisOutboundWorker({
  client: blockingClient,
  orchestrator,
});

// Publishers, deduplicators, and fencing locks use general client
const publisher = new RedisInboundPublisher({ client });
const lock = new RedisFencingLock({ client });
```

Additionally, set short `blpopTimeoutSeconds` (e.g., 2s) to allow timely inspection of orchestrator transition states (`FENCING`, `COLD_START_STANDBY`, `RECOVERY_SWAP`) and graceful process shutdown.

---

## Invariant Verification Command
```bash
pnpm test tests/redis-queue.test.ts
```
