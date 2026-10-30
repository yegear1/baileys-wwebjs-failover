import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayApplication, loadGatewayConfig } from "../src/bootstrap/index.js";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { calculateDedupHash } from "../src/utils/dedup.js";
import { type RedisTestEnvironment, setupRedisTestEnvironment } from "./fixtures/redis-test-env.js";

class ControllableMockDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  public status: EngineStatus;
  public connected = true;
  public sentMessages: Array<{ to: string; content: OutboundMessage }> = [];
  public shouldFailSend = false;
  public connectDelayMs = 0;

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
    if (this.shouldFailSend) {
      throw new Error(`Simulated send failure for driver ${this.name}`);
    }
    this.sentMessages.push({ to, content });
    return {
      id: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      to,
      timestamp: Date.now(),
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

describe("E2E Smoke & Resilience Verification (Real Redis)", () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-gateway-resilience-"));
    authBaileys = path.join(tmpDir, "baileys");
    authWWebJS = path.join(tmpDir, "wwebjs");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("boots and connects against live or containerized Redis service", async () => {
    expect(redisEnv.url).toBeDefined();
    expect(redisEnv.url.length).toBeGreaterThan(0);

    const client = await redisEnv.createClient();
    try {
      const pong = await client.set("e2e:health:probe", "active", { EX: 10 });
      expect(pong).toBe("OK");
      const val = await client.get("e2e:health:probe");
      expect(val).toBe("active");
    } finally {
      await client.disconnect();
    }
  });

  it("orchestrates full failover cycle under synthetic socket failure and failback recovery swap", async () => {
    const testId = `cycle_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;

    const primaryDriver = new ControllableMockDriver("baileys");
    const standbyDriver = new ControllableMockDriver("wwebjs");
    standbyDriver.connected = false;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      FAILOVER_ERROR_THRESHOLD: "2",
      PROBE_STABILITY_WINDOW_SEC: "1",
      PROBE_INTERVAL_MS: "500",
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      FENCING_LOCK_KEY: fencingKey,
      ENABLE_HOST_CONNECTIVITY_GUARD: "false",
      URGENT_DELAY_MIN_MS: "0",
      URGENT_DELAY_MAX_MS: "0",
      NORMAL_DELAY_MIN_MS: "0",
      NORMAL_DELAY_MAX_MS: "0",
      LOW_DELAY_MIN_MS: "0",
      LOW_DELAY_MAX_MS: "0",
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

    try {
      const orchestrator = app.getOrchestrator();

      // 1. Initial State: Steady-state PRIMARY_ACTIVE
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
      expect(orchestrator.getActiveEngine()).toBe("baileys");
      const initialFencing = await directClient.get(fencingKey);
      expect(initialFencing).toBe("baileys");

      // Verify outbound message via primary
      await directClient.lPush(
        outboundKey,
        JSON.stringify({
          phone_number: "5511999990001",
          content: "Message via primary",
        }),
      );

      // Wait for outbound worker loop to consume
      await new Promise((r) => setTimeout(r, 150));
      expect(primaryDriver.sentMessages.length).toBe(1);
      expect(primaryDriver.sentMessages[0]?.content.text).toBe("Message via primary");
      expect(standbyDriver.sentMessages.length).toBe(0);

      // 2. Synthetic Fault: Primary socket drops; triggers circuit breaker
      primaryDriver.notifyStatus({
        engine: "baileys",
        state: "DISCONNECTED",
        connected: false,
        error: "Synthetic network disconnect",
      });
      primaryDriver.notifyStatus({
        engine: "baileys",
        state: "ERROR",
        connected: false,
        error: "Synthetic socket error",
      });

      // Allow FSM transitions to execute (FENCING -> COLD_START_STANDBY -> FALLBACK_ACTIVE)
      await new Promise((r) => setTimeout(r, 200));

      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
      expect(orchestrator.getActiveEngine()).toBe("wwebjs");

      // Fencing lock in Redis atomically points to wwebjs
      const failoverFencing = await directClient.get(fencingKey);
      expect(failoverFencing).toBe("wwebjs");

      // 3. Outbound dispatch in FALLBACK_ACTIVE via standby driver
      await directClient.lPush(
        outboundKey,
        JSON.stringify({
          phone_number: "5511999990002",
          content: "Message via standby",
        }),
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(standbyDriver.sentMessages.length).toBe(1);
      expect(standbyDriver.sentMessages[0]?.content.text).toBe("Message via standby");

      // 4. Recovery: Primary reconnects; silent probe verifies stability
      primaryDriver.connected = true;
      primaryDriver.status = {
        engine: "baileys",
        state: "CONNECTED",
        connected: true,
        batteryLevel: 100,
      };

      // Probe 1: Success 1
      const probe1 = await orchestrator.executeSilentProbe();
      expect(probe1).toBe(true);

      // Probe 2: Success 2 (meets threshold = 2); triggers RECOVERY_SWAP -> PRIMARY_ACTIVE
      const probe2 = await orchestrator.executeSilentProbe();
      expect(probe2).toBe(true);

      await new Promise((r) => setTimeout(r, 200));

      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
      expect(orchestrator.getActiveEngine()).toBe("baileys");

      // Fencing lock restored to baileys
      const restoredFencing = await directClient.get(fencingKey);
      expect(restoredFencing).toBe("baileys");

      // Standby driver Chromium cleanly torn down and disconnected
      expect(standbyDriver.connected).toBe(false);

      // Outbound dispatch restored to primary driver
      await directClient.lPush(
        outboundKey,
        JSON.stringify({
          phone_number: "5511999990003",
          content: "Message after recovery swap",
        }),
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(primaryDriver.sentMessages.length).toBe(2);
      expect(primaryDriver.sentMessages[1]?.content.text).toBe("Message after recovery swap");
    } finally {
      await directClient.quit?.();
      await app.stop();
    }
  });

  it("buffers outbound messages during transition states with zero data loss under queue backpressure", async () => {
    const testId = `backpressure_${Date.now()}`;
    const fencingKey = `gateway:active_engine:${testId}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;

    const primaryDriver = new ControllableMockDriver("baileys");
    const standbyDriver = new ControllableMockDriver("wwebjs");
    standbyDriver.connected = false;
    // Simulate Puppeteer cold start delay (150ms)
    standbyDriver.connectDelayMs = 150;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      FAILOVER_ERROR_THRESHOLD: "1",
      PROBE_STABILITY_WINDOW_SEC: "1",
      BLPOP_TIMEOUT_SECONDS: "0.05",
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      FENCING_LOCK_KEY: fencingKey,
      ENABLE_HOST_CONNECTIVITY_GUARD: "false",
      URGENT_DELAY_MIN_MS: "0",
      URGENT_DELAY_MAX_MS: "0",
      NORMAL_DELAY_MIN_MS: "0",
      NORMAL_DELAY_MAX_MS: "0",
      LOW_DELAY_MIN_MS: "0",
      LOW_DELAY_MAX_MS: "0",
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

    try {
      const orchestrator = app.getOrchestrator();

      // Trigger failover into transitional states
      const failoverPromise = orchestrator.triggerFailover("Backpressure test trip");

      // Give event loop tick to enter FENCING or COLD_START_STANDBY
      await vi.waitFor(() => {
        const midState = orchestrator.getState();
        expect(["FENCING", "COLD_START_STANDBY"]).toContain(midState);
      });

      // Inject 3 priority messages during transitional delay
      await directClient.lPush(
        outboundKey,
        JSON.stringify({ phone_number: "5511999991001", content: "Buffered 1" }),
      );
      await directClient.lPush(
        outboundKey,
        JSON.stringify({ phone_number: "5511999991002", content: "Buffered 2" }),
      );
      await directClient.lPush(
        outboundKey,
        JSON.stringify({ phone_number: "5511999991003", content: "Buffered 3" }),
      );

      // Confirm messages exist safely in Redis queue buffer
      const pendingCount = await directClient.lLen(outboundKey);
      expect(pendingCount).toBeGreaterThanOrEqual(1);

      // Await standby cold-start completion and promotion to FALLBACK_ACTIVE
      await failoverPromise;
      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

      // Wait for backpressure to release and queue to drain through standby driver
      let attempts = 0;
      while (standbyDriver.sentMessages.length < 3 && attempts < 20) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      expect(standbyDriver.sentMessages.length).toBe(3);
      // Verify FIFO ordering: since lPush pushes to head, earlier items popped first
      const texts = standbyDriver.sentMessages.map((m) => m.content.text);
      expect(texts).toContain("Buffered 1");
      expect(texts).toContain("Buffered 2");
      expect(texts).toContain("Buffered 3");
    } finally {
      await directClient.quit?.();
      await app.stop();
    }
  });

  it("enforces distributed inbound deduplication filter in real Redis with 300s TTL lock", async () => {
    const testId = `dedup_${Date.now()}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const fencingKey = `gateway:active_engine:${testId}`;

    const primaryDriver = new ControllableMockDriver("baileys");
    const standbyDriver = new ControllableMockDriver("wwebjs");

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      FENCING_LOCK_KEY: fencingKey,
      ENABLE_HOST_CONNECTIVITY_GUARD: "false",
      URGENT_DELAY_MIN_MS: "0",
      URGENT_DELAY_MAX_MS: "0",
      NORMAL_DELAY_MIN_MS: "0",
      NORMAL_DELAY_MAX_MS: "0",
      LOW_DELAY_MIN_MS: "0",
      LOW_DELAY_MAX_MS: "0",
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

    try {
      const queueManager = app.getQueueManager();
      const publisher = queueManager.getPublisher();

      const rawMsg = {
        id: "msg_live_dedup_001",
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000000,
        fromMe: false,
        type: "text" as const,
        textBody: "Real Redis deduplication test message",
      };

      const hash = calculateDedupHash(rawMsg);
      const inboundMsg: InboundMessage = {
        ...rawMsg,
        dedupHash: hash,
      };

      const dedupKey = `dedupe:msg:${hash}`;

      // First publish: Should succeed and push to inbox
      const firstPublish = await publisher.publish(inboundMsg);
      expect(firstPublish.published).toBe(true);

      // Verify dedup lock key exists in Redis with TTL
      const dedupValue = await directClient.get(dedupKey);
      expect(dedupValue).toBe("1");
      const ttl = await directClient.ttl(dedupKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);

      // Second publish with identical message: Should be discarded by Redis deduplicator
      const secondPublish = await publisher.publish(inboundMsg);
      expect(secondPublish.published).toBe(false);
      expect(secondPublish.reason).toBe("DUPLICATE");

      // Verify inbox queue in Redis received exactly 1 message
      const queueLength = await directClient.lLen(inboxKey);
      expect(queueLength).toBe(1);

      const popped = await directClient.rPop(inboxKey);
      expect(popped).not.toBeNull();
      if (popped) {
        const parsed = JSON.parse(popped);
        expect(parsed.id).toBe("msg_live_dedup_001");
        expect(parsed.textBody).toBe("Real Redis deduplication test message");
      }
    } finally {
      await directClient.quit?.();
      await app.stop();
    }
  });

  it("re-queues outbound messages on driver send failure and routes to DLQ on max retries in real Redis", async () => {
    const testId = `dlq_${Date.now()}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const dlqKey = `whatsapp:send:dlq:${testId}`;
    const fencingKey = `gateway:active_engine:${testId}`;

    const primaryDriver = new ControllableMockDriver("baileys");
    const standbyDriver = new ControllableMockDriver("wwebjs");
    primaryDriver.shouldFailSend = true;

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      DLQ_QUEUE_KEY: dlqKey,
      FENCING_LOCK_KEY: fencingKey,
      MAX_SEND_RETRIES: "3",
      BLPOP_TIMEOUT_SECONDS: "0.1",
      FAILOVER_ERROR_THRESHOLD: "10",
      URGENT_DELAY_MIN_MS: "0",
      URGENT_DELAY_MAX_MS: "0",
      NORMAL_DELAY_MIN_MS: "0",
      NORMAL_DELAY_MAX_MS: "0",
      LOW_DELAY_MIN_MS: "0",
      LOW_DELAY_MAX_MS: "0",
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

    try {
      await directClient.lPush(
        outboundKey,
        JSON.stringify({
          to: "5511999998888@c.us",
          type: "text",
          text: "E2E DLQ Resilience Test",
        }),
      );

      let dlqLength = 0;
      let attempts = 0;
      while (dlqLength === 0 && attempts < 30) {
        await new Promise((r) => setTimeout(r, 100));
        dlqLength = await directClient.lLen(dlqKey);
        attempts++;
      }

      expect(dlqLength).toBe(1);

      const dlqRaw = await directClient.rPop(dlqKey);
      expect(dlqRaw).not.toBeNull();
      if (dlqRaw) {
        const parsed = JSON.parse(dlqRaw);
        expect(parsed.retryCount).toBe(3);
        expect(parsed.dlqReason).toContain("Max send retries (3) exceeded");
        expect(parsed.to).toBe("5511999998888@c.us");
      }
    } finally {
      await directClient.quit?.();
      await app.stop();
    }
  });

  it("processes multi-tier priority and low-priority queues with jitter delays in real Redis", async () => {
    const testId = `multitier_${Date.now()}`;
    const inboxKey = `whatsapp:receive:inbox:${testId}`;
    const outboundKey = `whatsapp:send:priority:${testId}`;
    const lowOutboundKey = `whatsapp:send:low:${testId}`;
    const dlqKey = `whatsapp:send:dlq:${testId}`;
    const fencingKey = `gateway:active_engine:${testId}`;

    const primaryDriver = new ControllableMockDriver("baileys");
    const standbyDriver = new ControllableMockDriver("wwebjs");

    const config = loadGatewayConfig({
      PORT: "0",
      REDIS_URL: redisEnv.url,
      AUTH_DIR_BAILEYS: authBaileys,
      AUTH_DIR_WWEBJS: authWWebJS,
      INBOX_QUEUE_KEY: inboxKey,
      OUTBOUND_QUEUE_KEY: outboundKey,
      LOW_PRIORITY_OUTBOUND_QUEUE_KEY: lowOutboundKey,
      DLQ_QUEUE_KEY: dlqKey,
      FENCING_LOCK_KEY: fencingKey,
      BLPOP_TIMEOUT_SECONDS: "0.05",
      URGENT_DELAY_MIN_MS: "10",
      URGENT_DELAY_MAX_MS: "20",
      NORMAL_DELAY_MIN_MS: "30",
      NORMAL_DELAY_MAX_MS: "40",
      LOW_DELAY_MIN_MS: "60",
      LOW_DELAY_MAX_MS: "80",
      ENABLE_TYPING_PRESENCE: "true",
    });

    const directClient = await redisEnv.createClient();

    // Pre-populate low-priority queue and priority queue before app start
    await directClient.lPush(
      lowOutboundKey,
      JSON.stringify({ phone_number: "5511999990001", content: "Low priority item" }),
    );
    await directClient.lPush(
      outboundKey,
      JSON.stringify({
        phone_number: "5511999990002",
        content: "Urgent priority item",
        priority: "urgent",
      }),
    );

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

    try {
      await vi.waitFor(
        () => {
          expect(primaryDriver.sentMessages.length).toBe(2);
        },
        { timeout: 2500, interval: 25 },
      );

      expect(primaryDriver.sentMessages[0]?.content.text).toBe("Urgent priority item");
      expect(primaryDriver.sentMessages[1]?.content.text).toBe("Low priority item");
    } finally {
      await directClient.quit?.();
      await app.stop();
    }
  });
});
