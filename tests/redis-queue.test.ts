import { describe, expect, it, vi } from "vitest";
import type {
  EngineName,
  EngineStatus,
  IWhatsAppDriver,
  PresenceState,
} from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { RedisFencingLock } from "../src/fsm/fencing.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { RedisDeduplicator } from "../src/queues/dedup-lock.js";
import { RedisInboundPublisher } from "../src/queues/inbound-publisher.js";
import { RedisQueueManager } from "../src/queues/manager.js";
import { normalizeOutboundPayload, RedisOutboundWorker } from "../src/queues/outbound-worker.js";
import type { IRedisClient } from "../src/queues/types.js";
import { calculateDedupHash } from "../src/utils/dedup.js";

class MockWhatsAppDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

  public sentMessages: Array<{ to: string; content: OutboundMessage }> = [];
  public sentPresences: Array<{ to: string; state: PresenceState; timestamp: number }> = [];
  public shouldFailSend = false;

  constructor(name: EngineName) {
    this.name = name;
    this.status = {
      engine: name,
      state: "CONNECTED",
      connected: true,
      batteryLevel: 100,
    };
  }

  async connect(): Promise<void> {
    this.status = { ...this.status, state: "CONNECTED", connected: true };
    this.notifyStatus(this.status);
  }

  async disconnect(): Promise<void> {
    this.status = { ...this.status, state: "DISCONNECTED", connected: false };
    this.notifyStatus(this.status);
  }

  async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (this.shouldFailSend) {
      throw new Error("Simulated driver send failure");
    }
    this.sentMessages.push({ to, content });
    return {
      id: `rcpt_${Date.now()}`,
      to,
      timestamp: Date.now(),
      status: "SENT",
    };
  }

  async sendPresence(to: string, state: PresenceState): Promise<void> {
    this.sentPresences.push({ to, state, timestamp: Date.now() });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (status: EngineStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  async emitInboundMessage(msg: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(msg);
    }
  }

  notifyStatus(status: EngineStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}

class MockRedisClient implements IRedisClient {
  public isOpen = true;
  public readonly kvStore = new Map<string, string>();
  public readonly listStore = new Map<string, string[]>();
  public readonly waiters: Array<{
    keys: string[];
    resolve: (item: { key: string; element: string } | null) => void;
  }> = [];

  constructor(sharedKv?: Map<string, string>, sharedList?: Map<string, string[]>) {
    if (sharedKv) this.kvStore = sharedKv;
    if (sharedList) this.listStore = sharedList;
  }

  async connect(): Promise<void> {
    this.isOpen = true;
  }

  async disconnect(): Promise<void> {
    this.isOpen = false;
    for (const waiter of this.waiters) {
      waiter.resolve(null);
    }
    this.waiters.length = 0;
  }

  async get(key: string): Promise<string | null> {
    return this.kvStore.get(key) ?? null;
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.kvStore.get(key) ?? null);
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean | undefined; EX?: number | undefined },
  ): Promise<string | null> {
    if (options?.NX && this.kvStore.has(key)) {
      return null;
    }
    this.kvStore.set(key, value);
    return "OK";
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let deleted = 0;
    for (const key of keys) {
      if (this.kvStore.delete(key)) deleted++;
    }
    return deleted;
  }

  async lPush(key: string, elements: string | string[]): Promise<number> {
    const list = this.listStore.get(key) ?? [];
    const items = Array.isArray(elements) ? elements : [elements];

    for (const item of items) {
      // Check if any blPop waiter is waiting for this key
      const waiterIdx = this.waiters.findIndex((w) => w.keys.includes(key));
      if (waiterIdx >= 0) {
        const waiter = this.waiters.splice(waiterIdx, 1)[0];
        if (waiter) {
          waiter.resolve({ key, element: item });
          continue;
        }
      }
      list.unshift(item);
    }
    this.listStore.set(key, list);
    return list.length;
  }

  async blPop(
    keyOrKeys: string | string[],
    timeoutSeconds: number,
  ): Promise<{ key: string; element: string } | null> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const key of keys) {
      const list = this.listStore.get(key);
      if (list && list.length > 0) {
        const element = list.pop();
        if (element !== undefined) {
          return { key, element };
        }
      }
    }

    if (timeoutSeconds <= 0 || keys.length === 0) {
      return null;
    }

    return new Promise<{ key: string; element: string } | null>((resolve) => {
      const waiter = { keys, resolve };
      this.waiters.push(waiter);

      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          resolve(null);
        }
      }, timeoutSeconds * 1000);
      timer.unref?.();
    });
  }

  async eval(
    script: string,
    options?: { keys?: string[] | undefined; arguments?: string[] | undefined },
  ): Promise<unknown> {
    if (script.includes("EXISTS")) {
      const keys = options?.keys ?? [];
      for (const key of keys) {
        if (this.kvStore.has(key)) {
          return 0;
        }
      }
      for (const key of keys) {
        this.kvStore.set(key, "1");
      }
      return 1;
    }

    const key = options?.keys?.[0];
    const expectedValue = options?.arguments?.[0];
    if (key && expectedValue && this.kvStore.get(key) === expectedValue) {
      this.kvStore.delete(key);
      return 1;
    }
    return 0;
  }

  duplicate(): IRedisClient {
    return new MockRedisClient(this.kvStore, this.listStore);
  }
}

describe("RedisFencingLock", () => {
  it("acquires uncontested lock and prevents usurping by another engine", async () => {
    const client = new MockRedisClient();
    const lock = new RedisFencingLock({ client, key: "gateway:active_engine", ttlSeconds: 60 });

    const acquiredBaileys = await lock.acquire("baileys");
    expect(acquiredBaileys).toBe(true);
    expect(await lock.getCurrentHolder()).toBe("baileys");

    // Re-acquire by same holder returns true
    expect(await lock.acquire("baileys")).toBe(true);

    // Acquire by rival engine fails
    const acquiredWWebJS = await lock.acquire("wwebjs");
    expect(acquiredWWebJS).toBe(false);
    expect(await lock.getCurrentHolder()).toBe("baileys");

    // Usurping release by rival engine does not release lock
    await lock.release("wwebjs");
    expect(await lock.getCurrentHolder()).toBe("baileys");

    // Legitimate release clears the holder
    await lock.release("baileys");
    expect(await lock.getCurrentHolder()).toBeNull();

    // Rival engine can now acquire
    expect(await lock.acquire("wwebjs")).toBe(true);
    expect(await lock.getCurrentHolder()).toBe("wwebjs");
  });
});

describe("RedisDeduplicator", () => {
  it("atomically locks novel message and rejects duplicate within TTL/clock-skew window", async () => {
    const client = new MockRedisClient();
    const dedup = new RedisDeduplicator({ client, ttlSeconds: 300, clockSkewSeconds: 5 });

    const msg: InboundMessage = {
      id: "msg_001",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000005, // 5s into bucket 170000000
      type: "text",
      textBody: "Hello world",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000005,
        textBody: "Hello world",
      }),
    };

    // First arrival is accepted
    const firstAcquire = await dedup.acquireLock(msg);
    expect(firstAcquire).toBe(true);

    // Exact duplicate arrival is rejected
    const secondAcquire = await dedup.acquireLock(msg);
    expect(secondAcquire).toBe(false);

    // Cross-socket duplicate arriving 3s later (absorbed by bucket skew)
    const slightlyLaterMsg: InboundMessage = {
      ...msg,
      id: "msg_002",
      timestamp: 1700000008,
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000008,
        textBody: "Hello world",
      }),
    };

    const skewAcquire = await dedup.acquireLock(slightlyLaterMsg);
    expect(skewAcquire).toBe(false);
  });

  it("atomically handles concurrent arrivals across boundary buckets via Lua script", async () => {
    const client = new MockRedisClient();
    const dedup = new RedisDeduplicator({ client, ttlSeconds: 300, clockSkewSeconds: 5 });

    // Socket A arrives at boundary t = 1700000009 (bucket 170000000)
    const msgA: InboundMessage = {
      id: "msg_socket_a",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000009,
      type: "text",
      textBody: "Concurrent arrival across boundary",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000009,
        textBody: "Concurrent arrival across boundary",
      }),
    };

    // Socket B arrives at boundary t = 1700000011 (bucket 170000001)
    const msgB: InboundMessage = {
      id: "msg_socket_b",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000011,
      type: "text",
      textBody: "Concurrent arrival across boundary",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000011,
        textBody: "Concurrent arrival across boundary",
      }),
    };

    // Run concurrently
    const [resultA, resultB] = await Promise.all([
      dedup.acquireLock(msgA),
      dedup.acquireLock(msgB),
    ]);

    // Exactly one must acquire the lock and the other must be rejected
    const wins = [resultA, resultB].filter(Boolean);
    expect(wins.length).toBe(1);
  });

  it("falls back to multi-step mGet/set when client.eval is undefined", async () => {
    const rawClient = new MockRedisClient();
    // Simulate Redis client without eval capability
    const fallbackClient = {
      ...rawClient,
      eval: undefined,
      get: (k: string) => rawClient.get(k),
      mGet: (ks: string[]) => rawClient.mGet(ks),
      set: (k: string, v: string, o?: { NX?: boolean; EX?: number }) => rawClient.set(k, v, o),
      del: (k: string | string[]) => rawClient.del(k),
    };

    const dedup = new RedisDeduplicator({
      client: fallbackClient as unknown as IRedisClient,
      ttlSeconds: 300,
      clockSkewSeconds: 5,
    });

    const msg: InboundMessage = {
      id: "fallback_msg_1",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000000,
      type: "text",
      textBody: "Fallback test",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000000,
        textBody: "Fallback test",
      }),
    };

    expect(await dedup.acquireLock(msg)).toBe(true);
    expect(await dedup.acquireLock(msg)).toBe(false);

    // Release lock and verify it can be re-acquired
    await dedup.releaseLock(msg);
    expect(await dedup.acquireLock(msg)).toBe(true);
  });
});

describe("RedisInboundPublisher", () => {
  it("pushes novel messages to inbox queue and filters duplicates", async () => {
    const client = new MockRedisClient();
    const publisher = new RedisInboundPublisher({
      client,
      inboxQueueKey: "whatsapp:receive:inbox",
    });

    const msg: InboundMessage = {
      id: "msg_pub_1",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000010,
      type: "text",
      textBody: "Test message",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000010,
        textBody: "Test message",
      }),
    };

    const firstResult = await publisher.publish(msg);
    expect(firstResult.published).toBe(true);
    expect(firstResult.queueKey).toBe("whatsapp:receive:inbox");

    // Verify pushed to Redis list
    const items = client.listStore.get("whatsapp:receive:inbox");
    expect(items).toBeDefined();
    expect(items).toHaveLength(1);
    const firstItem = items?.[0];
    expect(firstItem).toBeDefined();
    if (firstItem) {
      expect(JSON.parse(firstItem).id).toBe("msg_pub_1");
    }

    // Second publish of same message is dropped
    const secondResult = await publisher.publish(msg);
    expect(secondResult.published).toBe(false);
    expect(secondResult.reason).toBe("DUPLICATE");
    expect(client.listStore.get("whatsapp:receive:inbox")).toHaveLength(1);

    const metrics = publisher.getMetrics();
    expect(metrics.publishedCount).toBe(1);
    expect(metrics.duplicateCount).toBe(1);
    expect(metrics.lastPublishedAt).toBeInstanceOf(Date);
    expect(metrics.lastDuplicateAt).toBeInstanceOf(Date);
  });
});

describe("normalizeOutboundPayload", () => {
  it("correctly normalizes canonical whatsapp-api payload", () => {
    const canonical = {
      phone_number: "5511999998888@c.us",
      content: "Hello from downstream",
      quote_id: "quote_123",
    };

    const normalized = normalizeOutboundPayload(canonical);
    expect(normalized.to).toBe("5511999998888@c.us");
    expect(normalized.content).toEqual({
      to: "5511999998888@c.us",
      type: "text",
      text: "Hello from downstream",
      quotedMessageId: "quote_123",
      media: undefined,
    });
  });

  it("correctly normalizes native outbound message payload", () => {
    const native = {
      id: "req_native_1",
      to: "5511888887777@c.us",
      type: "image" as const,
      text: "Look at this",
      media: {
        mimeType: "image/jpeg",
        digest: "abcd1234digest",
      },
      quotedMessageId: null,
    };

    const normalized = normalizeOutboundPayload(native);
    expect(normalized.id).toBe("req_native_1");
    expect(normalized.to).toBe("5511888887777@c.us");
    expect(normalized.content.type).toBe("image");
    expect(normalized.content.media?.digest).toBe("abcd1234digest");
  });
});

describe("RedisOutboundWorker & Failover Backpressure", () => {
  it("consumes priority queue items and pauses during orchestrator failover transitions", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      blpopTimeoutSeconds: 0.1, // short timeout for quick test iterations
      pauseCheckIntervalMs: 50,
    });

    worker.start();

    // Push canonical outbound message to Redis queue
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        phone_number: "5511999998888@c.us",
        content: "Message 1",
      }),
    );

    // Wait briefly for worker to consume
    await new Promise((r) => setTimeout(r, 150));

    expect(primaryDriver.sentMessages).toHaveLength(1);
    expect(primaryDriver.sentMessages[0]?.to).toBe("5511999998888@c.us");
    expect(primaryDriver.sentMessages[0]?.content.text).toBe("Message 1");
    expect(worker.getMetrics().processedCount).toBe(1);

    // Setup standby cold-start suspension to test backpressure while in COLD_START_STANDBY
    let resolveStandbyConnect: (() => void) | undefined;
    const standbyConnectPromise = new Promise<void>((resolve) => {
      resolveStandbyConnect = resolve;
    });
    standbyDriver.connect = vi.fn().mockImplementation(async () => {
      await standbyConnectPromise;
    });

    // Trigger failover transition into FENCING -> COLD_START_STANDBY
    void orchestrator.triggerFailover("Primary socket degraded/disconnected");

    // Wait briefly for transition to reach COLD_START_STANDBY and let previous blPop timeout finish
    await new Promise((r) => setTimeout(r, 120));
    expect(orchestrator.getState()).toBe("COLD_START_STANDBY");
    expect(worker.getMetrics().isPaused).toBe(true);

    // Push new message to Redis while worker is paused in transition
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        phone_number: "5511999998888@c.us",
        content: "Buffered Message 2",
      }),
    );

    // Verify message remains buffered in Redis queue (not popped by paused worker)
    expect(client.listStore.get("whatsapp:send:priority")).toHaveLength(1);
    expect(primaryDriver.sentMessages).toHaveLength(1);
    expect(standbyDriver.sentMessages).toHaveLength(0);

    // Resolve standby cold start -> orchestrator transitions to FALLBACK_ACTIVE
    resolveStandbyConnect?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Worker should wake up, consume buffered message, and dispatch via standby
    await new Promise((r) => setTimeout(r, 150));

    expect(standbyDriver.sentMessages).toHaveLength(1);
    expect(standbyDriver.sentMessages[0]?.content.text).toBe("Buffered Message 2");
    expect(client.listStore.get("whatsapp:send:priority")).toHaveLength(0);
    expect(worker.getMetrics().processedCount).toBe(2);

    await worker.stop();
    await orchestrator.shutdown();
  });

  it("handles malformed JSON and schema failures gracefully without crashing", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      blpopTimeoutSeconds: 0.1,
    });

    worker.start();

    // Push non-JSON string
    await client.lPush("whatsapp:send:priority", "invalid-json-string{{{");

    // Push invalid schema
    await client.lPush("whatsapp:send:priority", JSON.stringify({ invalid_prop: 123 }));

    await new Promise((r) => setTimeout(r, 150));

    expect(worker.getMetrics().errorCount).toBe(2);
    expect(worker.getMetrics().processedCount).toBe(0);
    expect(worker.getMetrics().dlqCount).toBe(2);

    const dlqList = client.listStore.get("whatsapp:send:dlq") ?? [];
    expect(dlqList.length).toBe(2);

    await worker.stop();
    await orchestrator.shutdown();
  });

  it("re-queues failed outbound messages up to maxSendRetries then pushes to DLQ on exhaustion", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    primaryDriver.shouldFailSend = true;

    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
      circuitBreakerOptions: { failureThreshold: 10 },
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      dlqQueueKey: "whatsapp:send:dlq",
      maxSendRetries: 3,
      blpopTimeoutSeconds: 0.05,
    });

    worker.start();

    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        to: "5511999998888@c.us",
        type: "text",
        text: "Will fail and retry",
      }),
    );

    await vi.waitFor(
      () => {
        expect(worker.getMetrics().dlqCount).toBe(1);
      },
      { timeout: 1500, interval: 20 },
    );

    expect(worker.getMetrics().requeuedCount).toBe(2);
    expect(worker.getMetrics().dlqCount).toBe(1);

    const dlqList = client.listStore.get("whatsapp:send:dlq") ?? [];
    expect(dlqList.length).toBe(1);
    const dlqRaw = dlqList[0];
    expect(dlqRaw).toBeDefined();
    const dlqItem = JSON.parse(String(dlqRaw));
    expect(dlqItem.retryCount).toBe(3);
    expect(dlqItem.dlqReason).toContain("Max send retries (3) exceeded");

    await worker.stop();
    await orchestrator.shutdown();
  });

  it("re-queues in-flight outbound message without exhausting retries or DLQ on shutdown cancellation", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");

    // Make primary driver sendMessage simulate an in-flight send that aborts on shutdown
    let rejectSend: ((err: Error) => void) | undefined;
    primaryDriver.sendMessage = vi.fn().mockImplementation(() => {
      return new Promise<MessageReceipt>((_resolve, reject) => {
        rejectSend = reject;
      });
    });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      dlqQueueKey: "whatsapp:send:dlq",
      maxSendRetries: 3,
      blpopTimeoutSeconds: 0.05,
    });

    worker.start();

    // Push message to queue
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        to: "5511999998888@c.us",
        type: "text",
        text: "In-flight during shutdown",
        retryCount: 1,
      }),
    );

    // Wait for worker to pop and start dispatching
    await vi.waitFor(() => {
      expect(primaryDriver.sendMessage).toHaveBeenCalled();
    });

    // Shutdown occurs while send is in-flight: abort send with shutdown error
    rejectSend?.(new Error("FailoverOrchestrator is shutting down"));

    // Worker stops cleanly without hanging
    await worker.stop();
    await orchestrator.shutdown();

    // DLQ must be empty (shutdown must NOT count as a failed retry to DLQ)
    const dlqList = client.listStore.get("whatsapp:send:dlq") ?? [];
    expect(dlqList).toHaveLength(0);

    // Message must be safely preserved in priority queue with original retryCount 1
    const requeuedList = client.listStore.get("whatsapp:send:priority") ?? [];
    expect(requeuedList).toHaveLength(1);
    const requeuedItem = JSON.parse(String(requeuedList[0]));
    expect(requeuedItem.retryCount).toBe(1);
    expect(requeuedItem.lastError).toContain("FailoverOrchestrator is shutting down");
  });

  it("drains priority queue (whatsapp:send:priority) strictly before low-priority queue (whatsapp:send:low)", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();

    // Enqueue 2 low-priority items first, then 2 priority items before starting worker
    await client.lPush(
      "whatsapp:send:low",
      JSON.stringify({ phone_number: "5511999990001@c.us", content: "Low 1" }),
    );
    await client.lPush(
      "whatsapp:send:low",
      JSON.stringify({ phone_number: "5511999990002@c.us", content: "Low 2" }),
    );
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({ phone_number: "5511999990003@c.us", content: "Priority 1" }),
    );
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({ phone_number: "5511999990004@c.us", content: "Priority 2" }),
    );

    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      lowPriorityOutboundQueueKey: "whatsapp:send:low",
      blpopTimeoutSeconds: 0.05,
    });

    worker.start();

    await vi.waitFor(
      () => {
        expect(primaryDriver.sentMessages).toHaveLength(4);
      },
      { timeout: 1500, interval: 20 },
    );

    const sentTexts = primaryDriver.sentMessages.map((m) => m.content.text);
    expect(sentTexts).toEqual(["Priority 1", "Priority 2", "Low 1", "Low 2"]);

    await worker.stop();
    await orchestrator.shutdown();
  });

  it("enforces randomized jitter delays per priority tier (urgent, normal, low) and dispatches composing presence", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      lowPriorityOutboundQueueKey: "whatsapp:send:low",
      blpopTimeoutSeconds: 0.05,
      enableTypingPresence: true,
      delayConfig: {
        urgent: { minMs: 30, maxMs: 50 },
        normal: { minMs: 70, maxMs: 100 },
        low: { minMs: 130, maxMs: 160 },
      },
    });

    worker.start();

    // 1. Urgent priority message
    const startUrgent = Date.now();
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        phone_number: "5511999991111@c.us",
        content: "Urgent message",
        priority: "urgent",
      }),
    );

    await vi.waitFor(
      () => {
        expect(primaryDriver.sentMessages).toHaveLength(1);
      },
      { timeout: 1000, interval: 10 },
    );
    const urgentElapsed = Date.now() - startUrgent;
    expect(urgentElapsed).toBeGreaterThanOrEqual(25);
    expect(primaryDriver.sentPresences).toHaveLength(1);
    expect(primaryDriver.sentPresences[0]?.state).toBe("composing");
    expect(primaryDriver.sentPresences[0]?.to).toBe("5511999991111@c.us");

    // 2. Normal priority message (default on priority queue)
    const startNormal = Date.now();
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        phone_number: "5511999992222@c.us",
        content: "Normal message",
      }),
    );

    await vi.waitFor(
      () => {
        expect(primaryDriver.sentMessages).toHaveLength(2);
      },
      { timeout: 1000, interval: 10 },
    );
    const normalElapsed = Date.now() - startNormal;
    expect(normalElapsed).toBeGreaterThanOrEqual(65);
    expect(primaryDriver.sentPresences).toHaveLength(2);
    expect(primaryDriver.sentPresences[1]?.to).toBe("5511999992222@c.us");

    // 3. Low priority message (via whatsapp:send:low queue)
    const startLow = Date.now();
    await client.lPush(
      "whatsapp:send:low",
      JSON.stringify({
        phone_number: "5511999993333@c.us",
        content: "Low priority newsletter",
      }),
    );

    await vi.waitFor(
      () => {
        expect(primaryDriver.sentMessages).toHaveLength(3);
      },
      { timeout: 1000, interval: 10 },
    );
    const lowElapsed = Date.now() - startLow;
    expect(lowElapsed).toBeGreaterThanOrEqual(120);
    expect(primaryDriver.sentPresences).toHaveLength(3);
    expect(primaryDriver.sentPresences[2]?.to).toBe("5511999993333@c.us");

    await worker.stop();
    await orchestrator.shutdown();
  });

  it("re-queues transient failures from low-priority queue back to whatsapp:send:low", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    let attempts = 0;
    primaryDriver.sendMessage = vi.fn().mockImplementation(async (to, content) => {
      attempts++;
      if (attempts === 1) {
        throw new Error("Transient low-priority send error");
      }
      primaryDriver.sentMessages.push({ to, content });
      return {
        id: `rcpt_${Date.now()}`,
        to,
        timestamp: Date.now(),
        status: "SENT",
      };
    });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
      circuitBreakerOptions: { failureThreshold: 10 },
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const worker = new RedisOutboundWorker({
      client,
      orchestrator,
      outboundQueueKey: "whatsapp:send:priority",
      lowPriorityOutboundQueueKey: "whatsapp:send:low",
      maxSendRetries: 3,
      blpopTimeoutSeconds: 0.05,
    });

    worker.start();

    await client.lPush(
      "whatsapp:send:low",
      JSON.stringify({
        phone_number: "5511999994444@c.us",
        content: "Retry in low queue",
      }),
    );

    await vi.waitFor(
      () => {
        expect(primaryDriver.sentMessages).toHaveLength(1);
      },
      { timeout: 1500, interval: 20 },
    );

    expect(worker.getMetrics().requeuedCount).toBe(1);
    expect(worker.getMetrics().processedCount).toBe(1);
    expect(client.listStore.get("whatsapp:send:priority") ?? []).toHaveLength(0);
    expect(client.listStore.get("whatsapp:send:low") ?? []).toHaveLength(0);

    await worker.stop();
    await orchestrator.shutdown();
  });
});

describe("RedisQueueManager", () => {
  it("starts and coordinates inbound publishing and outbound consumption end-to-end", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });
    await orchestrator.start();

    const client = new MockRedisClient();
    const queueManager = new RedisQueueManager({
      client,
      orchestrator,
      inboxQueueKey: "whatsapp:receive:inbox",
      outboundQueueKey: "whatsapp:send:priority",
      blpopTimeoutSeconds: 0.1,
    });

    await queueManager.start();

    const statusBefore = queueManager.getStatus();
    expect(statusBefore.isOpen).toBe(true);
    expect(statusBefore.worker.isRunning).toBe(true);

    // Simulate inbound message received by driver
    const inboundMsg: InboundMessage = {
      id: "inbound_e2e_1",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000000,
      type: "text",
      textBody: "Incoming test",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000000,
        textBody: "Incoming test",
      }),
    };

    await primaryDriver.emitInboundMessage(inboundMsg);

    // Verify pushed to inbox
    const inboxItems = client.listStore.get("whatsapp:receive:inbox");
    expect(inboxItems).toBeDefined();
    expect(inboxItems).toHaveLength(1);
    const firstInboxItem = inboxItems?.[0];
    expect(firstInboxItem).toBeDefined();
    if (firstInboxItem) {
      expect(JSON.parse(firstInboxItem).id).toBe("inbound_e2e_1");
    }

    // Push outbound request to priority queue
    await client.lPush(
      "whatsapp:send:priority",
      JSON.stringify({
        phone_number: "5511999998888@c.us",
        content: "Outgoing reply",
      }),
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(primaryDriver.sentMessages).toHaveLength(1);
    expect(primaryDriver.sentMessages[0]?.content.text).toBe("Outgoing reply");

    // Clean stop
    await queueManager.stop();
    await orchestrator.shutdown();
  });
});
