import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayApplication, loadGatewayConfig } from "../src/bootstrap/index.js";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { calculateDedupHash } from "../src/utils/dedup.js";
import { type RedisTestEnvironment, setupRedisTestEnvironment } from "./fixtures/redis-test-env.js";

class LatencyAwareMockDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  public status: EngineStatus;
  public connected = true;
  public sentMessages: Array<{ to: string; content: OutboundMessage; timestamp: number }> = [];
  public shouldFailSend = false;
  public sendLatencyMs = 0;
  public connectDelayMs = 0;
  public failAfterCount?: number = undefined;

  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

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
    if (this.connectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.connectDelayMs));
    }
    this.connected = true;
    this.status = { ...this.status, state: "CONNECTED", connected: true };
    this.notifyStatus(this.status);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.status = { ...this.status, state: "DISCONNECTED", connected: false };
    this.notifyStatus(this.status);
  }

  async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (this.sendLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendLatencyMs));
    }

    if (this.failAfterCount !== undefined && this.sentMessages.length >= this.failAfterCount) {
      throw new Error(
        `Simulated send failure after ${this.failAfterCount} messages for ${this.name}`,
      );
    }

    if (this.shouldFailSend) {
      throw new Error(`Simulated send failure for driver ${this.name}`);
    }

    const timestamp = Date.now();
    this.sentMessages.push({ to, content, timestamp });
    return {
      id: `rcpt_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
      to,
      timestamp,
      status: "SENT",
    };
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
    for (const h of this.messageHandlers) {
      await h(msg);
    }
  }

  notifyStatus(status: EngineStatus): void {
    this.status = status;
    for (const h of this.statusHandlers) {
      h(status);
    }
  }
}

describe("End-to-End Load & Sustained Queue Concurrency Verification", () => {
  let redisEnv: RedisTestEnvironment;
  let tmpDir: string;
  let authBaileys: string;
  let authWWebJS: string;

  beforeAll(async () => {
    redisEnv = await setupRedisTestEnvironment();
  }, 15000);

  afterAll(async () => {
    if (redisEnv) {
      await redisEnv.stop();
    }
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "load-concurrency-"));
    authBaileys = path.join(tmpDir, "baileys");
    authWWebJS = path.join(tmpDir, "wwebjs");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handles high-volume concurrent outbound bursts with zero message drop under socket latency", async () => {
    const testId = `burst_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const dlqKey = `whatsapp:send:dlq:${testId}`;

    const primaryDriver = new LatencyAwareMockDriver("baileys");
    primaryDriver.sendLatencyMs = 2; // 2ms simulated network round-trip per message
    const standbyDriver = new LatencyAwareMockDriver("wwebjs");
    standbyDriver.connected = false;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      FAILOVER_ERROR_THRESHOLD: "5",
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      DLQ_QUEUE_KEY: dlqKey,
      FENCING_LOCK_KEY: fencingKey,
    });

    const redisClient = await redisEnv.createClient();
    const blockingRedisClient = await redisEnv.createClient();
    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      blockingRedisClient,
      disableBackgroundProbeTimer: true,
    });

    await app.start();

    const directClient = await redisEnv.createClient();
    const totalMessages = 200;

    try {
      // Push 200 outbound messages in parallel concurrent batches
      const pushPromises: Promise<number>[] = [];
      for (let i = 0; i < totalMessages; i++) {
        const payload = JSON.stringify({
          phone_number: `551199000${String(i).padStart(4, "0")}`,
          content: `Burst message ${i}`,
        });
        pushPromises.push(directClient.lPush(outboundKey, payload));
      }

      await Promise.all(pushPromises);

      // Verify messages are in queue
      const initialQueueLen = await directClient.lLen(outboundKey);
      expect(initialQueueLen).toBeGreaterThan(0);

      // Wait for outbound worker to process all messages
      const startTime = Date.now();
      const timeoutMs = 15000;
      while (
        primaryDriver.sentMessages.length < totalMessages &&
        Date.now() - startTime < timeoutMs
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(primaryDriver.sentMessages.length).toBe(totalMessages);

      // Verify priority queue has fully drained to 0
      const remainingQueueLen = await directClient.lLen(outboundKey);
      expect(remainingQueueLen).toBe(0);

      // Verify DLQ has 0 messages
      const dlqLen = await directClient.lLen(dlqKey);
      expect(dlqLen).toBe(0);

      // Verify all recipient phones were delivered accurately
      const deliveredPhones = new Set(primaryDriver.sentMessages.map((m) => m.to));
      expect(deliveredPhones.size).toBe(totalMessages);

      // Verify metrics consistency via HTTP server's metrics service
      const metricsService = app.getHttpServer().getMetricsService();
      const metricsText = await metricsService.getMetrics();
      expect(metricsText).toContain("outbound_buffer_depth 0");
      expect(metricsText).toContain("dlq_messages_total 0");
    } finally {
      await app.stop();
      await directClient.disconnect();
    }
  });

  it("sustains queue persistence across in-flight mid-burst failover with zero message loss", async () => {
    const testId = `failover_burst_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const dlqKey = `whatsapp:send:dlq:${testId}`;

    const primaryDriver = new LatencyAwareMockDriver("baileys");
    primaryDriver.sendLatencyMs = 2;
    primaryDriver.failAfterCount = 20; // Fails after delivering 20 messages

    const standbyDriver = new LatencyAwareMockDriver("wwebjs");
    standbyDriver.connected = false;
    standbyDriver.connectDelayMs = 50; // Simulated cold start delay

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      FAILOVER_ERROR_THRESHOLD: "2",
      PROBE_STABILITY_WINDOW_SEC: "1",
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      DLQ_QUEUE_KEY: dlqKey,
      FENCING_LOCK_KEY: fencingKey,
    });

    const redisClient = await redisEnv.createClient();
    const blockingRedisClient = await redisEnv.createClient();
    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      blockingRedisClient,
      disableBackgroundProbeTimer: true,
    });

    await app.start();

    const directClient = await redisEnv.createClient();
    const totalMessages = 80;

    try {
      const orchestrator = app.getOrchestrator();

      // Enqueue 80 messages
      const pushPromises: Promise<number>[] = [];
      for (let i = 0; i < totalMessages; i++) {
        const payload = JSON.stringify({
          phone_number: `551198000${String(i).padStart(4, "0")}`,
          content: `Failover test message ${i}`,
        });
        pushPromises.push(directClient.lPush(outboundKey, payload));
      }
      await Promise.all(pushPromises);

      // Wait until primary starts failing and circuit breaker trips into standby
      const startTime = Date.now();
      const timeoutMs = 15000;
      while (orchestrator.getState() !== "FALLBACK_ACTIVE" && Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
      expect(orchestrator.getActiveEngine()).toBe("wwebjs");

      // Verify standby continues consuming the remaining backlog
      while (
        primaryDriver.sentMessages.length + standbyDriver.sentMessages.length < totalMessages &&
        Date.now() - startTime < timeoutMs
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const totalDispatched = primaryDriver.sentMessages.length + standbyDriver.sentMessages.length;
      expect(totalDispatched).toBe(totalMessages);
      expect(primaryDriver.sentMessages.length).toBe(20);
      expect(standbyDriver.sentMessages.length).toBe(60);

      // Zero dropped messages, queue drained
      const remainingQueueLen = await directClient.lLen(outboundKey);
      expect(remainingQueueLen).toBe(0);

      // Zero DLQ escalation
      const dlqLen = await directClient.lLen(dlqKey);
      expect(dlqLen).toBe(0);

      // All unique messages were delivered
      const allDeliveredContents = new Set([
        ...primaryDriver.sentMessages.map((m) => m.content.text),
        ...standbyDriver.sentMessages.map((m) => m.content.text),
      ]);
      expect(allDeliveredContents.size).toBe(totalMessages);
    } finally {
      await app.stop();
      await directClient.disconnect();
    }
  });

  it("handles concurrent inbound storm with atomic Lua deduplication guaranteeing exactly-once inbox delivery", async () => {
    const testId = `dedup_storm_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;

    const primaryDriver = new LatencyAwareMockDriver("baileys");
    const standbyDriver = new LatencyAwareMockDriver("wwebjs");
    standbyDriver.connected = false;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      FENCING_LOCK_KEY: fencingKey,
    });

    const redisClient = await redisEnv.createClient();
    const blockingRedisClient = await redisEnv.createClient();
    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      blockingRedisClient,
      disableBackgroundProbeTimer: true,
    });

    await app.start();

    const directClient = await redisEnv.createClient();
    const uniqueCount = 25;
    const copiesPerMessage = 8; // 25 * 8 = 200 concurrent incoming events

    try {
      const fixedBaseTimestamp = 1700000000; // in seconds
      const concurrentEmits: Promise<void>[] = [];

      for (let u = 0; u < uniqueCount; u++) {
        const textBody = `Unique inbound payload #${u}`;
        const remoteJid = `551188888${String(u).padStart(4, "0")}@s.whatsapp.net`;
        const senderJid = remoteJid;
        const timestamp = fixedBaseTimestamp + u * 20;

        for (let c = 0; c < copiesPerMessage; c++) {
          const rawMsg = {
            id: `msg_inbound_${u}_copy_${c}`,
            remoteJid,
            senderJid,
            fromMe: false,
            timestamp,
            type: "text" as const,
            textBody,
          };
          const hash = calculateDedupHash(rawMsg);
          const inboundMsg: InboundMessage = {
            ...rawMsg,
            dedupHash: hash,
          };

          concurrentEmits.push(primaryDriver.emitInboundMessage(inboundMsg));
        }
      }

      // Execute all 200 inbound emits simultaneously
      await Promise.all(concurrentEmits);

      // Allow publisher async operations to complete
      await new Promise((r) => setTimeout(r, 200));

      // Inbox queue should contain EXACTLY uniqueCount (25) messages
      const inboxLen = await directClient.lLen(inboxKey);
      expect(inboxLen).toBe(uniqueCount);

      // Verify all popped items correspond to unique messages
      const receivedBodies = new Set<string>();
      for (let i = 0; i < uniqueCount; i++) {
        const itemStr = await directClient.rPop(inboxKey);
        expect(itemStr).not.toBeNull();
        if (itemStr) {
          const parsed = JSON.parse(itemStr);
          receivedBodies.add(parsed.textBody);
        }
      }

      expect(receivedBodies.size).toBe(uniqueCount);
    } finally {
      await app.stop();
      await directClient.disconnect();
    }
  });

  it("handles multi-stream bidirectional concurrency without event-loop starvation", async () => {
    const testId = `bidirectional_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;

    const primaryDriver = new LatencyAwareMockDriver("baileys");
    primaryDriver.sendLatencyMs = 1;
    const standbyDriver = new LatencyAwareMockDriver("wwebjs");
    standbyDriver.connected = false;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      FENCING_LOCK_KEY: fencingKey,
    });

    const redisClient = await redisEnv.createClient();
    const blockingRedisClient = await redisEnv.createClient();
    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      blockingRedisClient,
      disableBackgroundProbeTimer: true,
    });

    await app.start();

    const directClient = await redisEnv.createClient();
    const messageCount = 60;

    try {
      const operations: Promise<unknown>[] = [];

      // 1. Concurrent Outbound Push Stream
      for (let i = 0; i < messageCount; i++) {
        operations.push(
          directClient.lPush(
            outboundKey,
            JSON.stringify({
              phone_number: `551197777${String(i).padStart(4, "0")}`,
              content: `Bidirectional outbound ${i}`,
            }),
          ),
        );
      }

      // 2. Concurrent Inbound Message Stream
      for (let i = 0; i < messageCount; i++) {
        const rawMsg = {
          id: `bidi_in_${i}`,
          remoteJid: `551196666${String(i).padStart(4, "0")}@s.whatsapp.net`,
          senderJid: `551196666${String(i).padStart(4, "0")}@s.whatsapp.net`,
          timestamp: 1700000000 + i * 20,
          fromMe: false,
          type: "text" as const,
          textBody: `Bidirectional inbound ${i}`,
        };
        const hash = calculateDedupHash(rawMsg);
        operations.push(
          primaryDriver.emitInboundMessage({
            ...rawMsg,
            dedupHash: hash,
          }),
        );
      }

      // 3. Concurrent Health & Metrics Scrapes
      const metricsService = app.getHttpServer().getMetricsService();
      for (let i = 0; i < 10; i++) {
        operations.push(metricsService.getMetrics());
      }

      // Run all streams concurrently
      await Promise.all(operations);

      // Wait for outbound worker to finish processing
      const startTime = Date.now();
      const timeoutMs = 15000;
      while (
        primaryDriver.sentMessages.length < messageCount &&
        Date.now() - startTime < timeoutMs
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(primaryDriver.sentMessages.length).toBe(messageCount);

      // Verify inbox queue received all 60 unique messages
      const inboxLen = await directClient.lLen(inboxKey);
      expect(inboxLen).toBe(messageCount);

      // Outbound queue fully drained
      const outboundLen = await directClient.lLen(outboundKey);
      expect(outboundLen).toBe(0);
    } finally {
      await app.stop();
      await directClient.disconnect();
    }
  });

  it("safely drains and preserves unconsumed queue items during shutdown under heavy load", async () => {
    const testId = `shutdown_load_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const dlqKey = `whatsapp:send:dlq:${testId}`;

    const primaryDriver = new LatencyAwareMockDriver("baileys");
    primaryDriver.sendLatencyMs = 10; // Slow down dispatch to guarantee pending items during stop
    const standbyDriver = new LatencyAwareMockDriver("wwebjs");
    standbyDriver.connected = false;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      DLQ_QUEUE_KEY: dlqKey,
      FENCING_LOCK_KEY: fencingKey,
      SHUTDOWN_TIMEOUT_MS: "5000",
    });

    const redisClient = await redisEnv.createClient();
    const blockingRedisClient = await redisEnv.createClient();
    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      blockingRedisClient,
      disableBackgroundProbeTimer: true,
    });

    await app.start();

    const directClient = await redisEnv.createClient();
    const totalEnqueued = 50;

    try {
      // Enqueue 50 messages
      for (let i = 0; i < totalEnqueued; i++) {
        await directClient.lPush(
          outboundKey,
          JSON.stringify({
            phone_number: `551195555${String(i).padStart(4, "0")}`,
            content: `Shutdown load test message ${i}`,
          }),
        );
      }

      // Wait until driver has dispatched at least 3 messages
      while (primaryDriver.sentMessages.length < 3) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // Trigger shutdown while remaining messages are still queued
      await app.stop();

      const sentCount = primaryDriver.sentMessages.length;
      expect(sentCount).toBeGreaterThanOrEqual(3);
      expect(sentCount).toBeLessThan(totalEnqueued);

      // Remaining messages MUST be preserved in the Redis outbound queue
      const remainingLen = await directClient.lLen(outboundKey);
      expect(remainingLen).toBe(totalEnqueued - sentCount);

      // Zero DLQ escalation occurred
      const dlqLen = await directClient.lLen(dlqKey);
      expect(dlqLen).toBe(0);

      // Second instance restart resumes and consumes all remaining items
      const primaryDriver2 = new LatencyAwareMockDriver("baileys");
      primaryDriver2.sendLatencyMs = 0;
      const standbyDriver2 = new LatencyAwareMockDriver("wwebjs");
      standbyDriver2.connected = false;

      const redisClient2 = await redisEnv.createClient();
      const blockingRedisClient2 = await redisEnv.createClient();
      const app2 = new GatewayApplication({
        config,
        primaryDriver: primaryDriver2,
        standbyDriver: standbyDriver2,
        redisClient: redisClient2,
        blockingRedisClient: blockingRedisClient2,
        disableBackgroundProbeTimer: true,
      });

      await app2.start();

      // Wait until remaining items are drained by app2
      const startTime = Date.now();
      const timeoutMs = 10000;
      while (
        primaryDriver2.sentMessages.length < totalEnqueued - sentCount &&
        Date.now() - startTime < timeoutMs
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(primaryDriver2.sentMessages.length).toBe(totalEnqueued - sentCount);

      const finalQueueLen = await directClient.lLen(outboundKey);
      expect(finalQueueLen).toBe(0);

      await app2.stop();
    } finally {
      await directClient.disconnect();
    }
  });
});
