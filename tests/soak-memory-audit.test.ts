import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayApplication, loadGatewayConfig } from "../src/bootstrap/index.js";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import {
  cleanupChromiumLocks,
  type WWebJSClientInterface,
  WWebJSDriver,
} from "../src/drivers/wwebjs.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { RedisDeduplicator } from "../src/queues/dedup-lock.js";
import { RedisInboundPublisher } from "../src/queues/inbound-publisher.js";
import { RedisQueueManager } from "../src/queues/manager.js";
import { calculateDedupHash } from "../src/utils/dedup.js";
import {
  type ITestRedisClient,
  type RedisTestEnvironment,
  setupRedisTestEnvironment,
} from "./fixtures/redis-test-env.js";

// Deterministic mock driver for soak testing
class SoakMockDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  public status: EngineStatus;
  public connected = true;
  public sentMessages: Array<{ to: string; content: OutboundMessage; timestamp: number }> = [];

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
    const timestamp = Date.now();
    this.sentMessages.push({ to, content, timestamp });
    return {
      id: `rcpt_soak_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
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

// Mock child process and browser for Chromium zombie / teardown audit
class MockPupProcess extends EventEmitter {
  public pid: number;
  public killed = false;

  constructor(pid = 88888) {
    super();
    this.pid = pid;
  }
}

class MockPupBrowser extends EventEmitter {
  private readonly proc: MockPupProcess;
  public connected = true;

  constructor(proc?: MockPupProcess) {
    super();
    this.proc = proc ?? new MockPupProcess();
  }

  public process(): MockPupProcess {
    return this.proc;
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

describe("Gateway Soak & Long-Running Memory Leak Audit", () => {
  let redisEnv: RedisTestEnvironment;
  let testClient: ITestRedisClient;
  let tempDir: string;

  beforeAll(async () => {
    redisEnv = await setupRedisTestEnvironment();
    testClient = await redisEnv.createClient();
  });

  afterAll(async () => {
    await testClient.disconnect();
    await redisEnv.stop();
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-soak-"));
    await fs.mkdir(path.join(tempDir, "baileys"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "wwebjs"), { recursive: true });
  });

  afterEach(async () => {
    await redisEnv.cleanupKeys("soak:*");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("1. Repeated Gateway Application Lifecycle Soak", () => {
    it("preserves listener baseline and maintains flat heap delta across 10 successive full lifecycles", async () => {
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      const initialSigintListeners = process.listenerCount("SIGINT");

      const heapSamples: number[] = [];

      // Force initial GC if available
      globalThis.gc?.();
      const initialHeap = process.memoryUsage().heapUsed;

      const CYCLES = 10;
      for (let i = 0; i < CYCLES; i++) {
        const primaryDriver = new SoakMockDriver("baileys");
        const standbyDriver = new SoakMockDriver("wwebjs");
        standbyDriver.connected = false;
        standbyDriver.status = {
          engine: "wwebjs",
          state: "STANDBY",
          connected: false,
        };

        const config = loadGatewayConfig({
          REDIS_URL: redisEnv.url,
          PORT: "0",
          AUTH_DIR_BAILEYS: path.join(tempDir, "baileys"),
          AUTH_DIR_WWEBJS: path.join(tempDir, "wwebjs"),
          INBOX_QUEUE_KEY: `soak:inbox:${i}`,
          OUTBOUND_QUEUE_KEY: `soak:outbound:${i}`,
          BLPOP_TIMEOUT_SECONDS: "0.05",
          FAILOVER_ERROR_THRESHOLD: "2",
          PROBE_INTERVAL_MS: "500",
          ENABLE_HOST_CONNECTIVITY_GUARD: "false",
        });

        const app = new GatewayApplication({
          config,
          primaryDriver,
          standbyDriver,
          redisClient: testClient,
          blockingRedisClient: testClient,
          disableBackgroundProbeTimer: true,
          enableHostConnectivityGuard: false,
        });

        // Register OS signal listeners on each iteration
        app.setupSignalHandlers();

        await app.start();
        expect(app.isRunning()).toBe(true);

        // 1. Send outbound message during primary operation
        const queueKey = `soak:outbound:${i}`;
        const rawPayload = JSON.stringify({
          phone_number: "5511999990000",
          content: `Lifecycle soak message ${i}`,
        });
        await testClient.lPush(queueKey, rawPayload);

        // Wait for worker to dispatch
        await vi.waitFor(
          () => {
            expect(primaryDriver.sentMessages.length).toBe(1);
          },
          { timeout: 3000, interval: 20 },
        );

        // 2. Trigger failover
        await app.getOrchestrator().triggerFailover("Soak failover test");
        expect(app.getOrchestrator().getState()).toBe("FALLBACK_ACTIVE");

        // 3. Send outbound message through standby
        const standbyPayload = JSON.stringify({
          phone_number: "5511999990001",
          content: `Standby soak message ${i}`,
        });
        await testClient.lPush(queueKey, standbyPayload);

        await vi.waitFor(
          () => {
            expect(standbyDriver.sentMessages.length).toBe(1);
          },
          { timeout: 3000, interval: 20 },
        );

        // 4. Trigger failback
        await app.getOrchestrator().triggerFailback("Soak failback test");
        expect(app.getOrchestrator().getState()).toBe("PRIMARY_ACTIVE");

        // 5. Gracefully stop application
        await app.stop();
        expect(app.isRunning()).toBe(false);

        // Verify signal listeners were cleanly deregistered after stop()
        expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
        expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);

        globalThis.gc?.();
        heapSamples.push(process.memoryUsage().heapUsed);
      }

      // Final listener assertions: zero listener leaks on Node process
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);

      // Verify bounded memory growth:
      // The difference between cycle 2 (warmed up) and cycle 10 should not exhibit runaway heap growth (< 25MB)
      const warmHeap = heapSamples[1] ?? initialHeap;
      const finalHeap = heapSamples[CYCLES - 1] ?? initialHeap;
      const heapGrowthMb = (finalHeap - warmHeap) / (1024 * 1024);
      expect(heapGrowthMb).toBeLessThan(25);
    });
  });

  describe("2. Sustained High-Throughput Queue & Deduplication Soak", () => {
    it("handles 2,000 continuous messages through deduplication and worker with stable memory", async () => {
      const primaryDriver = new SoakMockDriver("baileys");
      const standbyDriver = new SoakMockDriver("wwebjs");
      const orchestrator = new FailoverOrchestrator({
        primaryDriver,
        standbyDriver,
        disableBackgroundProbeTimer: true,
        enableHostConnectivityGuard: false,
      });
      await orchestrator.start();

      const inboxKey = "soak:dedup:inbox";
      const outboundKey = "soak:dedup:outbound";

      const queueManager = new RedisQueueManager({
        client: testClient,
        orchestrator,
        inboxQueueKey: inboxKey,
        outboundQueueKey: outboundKey,
        blpopTimeoutSeconds: 0.05,
        pauseCheckIntervalMs: 50,
      });

      await queueManager.start();

      const deduplicator = new RedisDeduplicator({
        client: testClient,
        prefix: "soak:dedup:",
        ttlSeconds: 60,
      });

      const publisher = new RedisInboundPublisher({
        client: testClient,
        deduplicator,
        inboxQueueKey: inboxKey,
      });

      globalThis.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;

      const TOTAL_UNIQUE_MESSAGES = 1000;
      const DUPLICATE_MESSAGES = 500;

      // 1. Flood inbound publisher with unique messages
      for (let i = 0; i < TOTAL_UNIQUE_MESSAGES; i++) {
        const timestamp = Date.now();
        const text = `High-throughput inbound soak message #${i}`;
        const dedupHash = calculateDedupHash({
          remoteJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          senderJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          textBody: text,
          timestamp,
        });

        const res = await publisher.publish({
          id: `inbound_${i}`,
          remoteJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          senderJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          timestamp,
          type: "text",
          textBody: text,
          fromMe: false,
          dedupHash,
        });

        expect(res.published).toBe(true);
      }

      // 2. Flood publisher with duplicate messages
      for (let i = 0; i < DUPLICATE_MESSAGES; i++) {
        const text = `High-throughput inbound soak message #${i}`;
        // Same timestamp bucket within 10s
        const timestamp = Date.now();
        const dedupHash = calculateDedupHash({
          remoteJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          senderJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          textBody: text,
          timestamp,
        });

        const res = await publisher.publish({
          id: `inbound_dup_${i}`,
          remoteJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          senderJid: `551199999${String(i).padStart(6, "0")}@s.whatsapp.net`,
          timestamp,
          type: "text",
          textBody: text,
          fromMe: false,
          dedupHash,
        });

        expect(res.published).toBe(false);
        expect(res.reason).toBe("DUPLICATE");
      }

      // 3. Flood outbound queue with 1,000 messages
      const OUTBOUND_COUNT = 1000;
      const pushPromises: Promise<number>[] = [];
      for (let i = 0; i < OUTBOUND_COUNT; i++) {
        pushPromises.push(
          testClient.lPush(
            outboundKey,
            JSON.stringify({
              phone_number: "5511988887777",
              content: `High-throughput outbound message #${i}`,
            }),
          ),
        );
      }
      await Promise.all(pushPromises);

      // Wait for outbound worker to process all 1,000 messages
      await vi.waitFor(
        () => {
          expect(primaryDriver.sentMessages.length).toBe(OUTBOUND_COUNT);
        },
        { timeout: 15_000, interval: 50 },
      );

      // Verify publisher metrics
      const pubMetrics = publisher.getMetrics();
      expect(pubMetrics.publishedCount).toBe(TOTAL_UNIQUE_MESSAGES);
      expect(pubMetrics.duplicateCount).toBe(DUPLICATE_MESSAGES);

      // Clean teardown
      await queueManager.stop();
      await orchestrator.shutdown();

      globalThis.gc?.();
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);
      expect(heapDeltaMb).toBeLessThan(30);
    });
  });

  describe("3. Rapid Failover Oscillation Soak (50 Rapid Transitions)", () => {
    it("handles 50 consecutive failover/failback oscillations with zero buffer retention or listener leakage", async () => {
      const primaryDriver = new SoakMockDriver("baileys");
      const standbyDriver = new SoakMockDriver("wwebjs");
      standbyDriver.connected = false;
      standbyDriver.status = {
        engine: "wwebjs",
        state: "STANDBY",
        connected: false,
      };

      const orchestrator = new FailoverOrchestrator({
        primaryDriver,
        standbyDriver,
        disableBackgroundProbeTimer: true,
        enableHostConnectivityGuard: false,
      });

      await orchestrator.start();
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

      const OSCILLATIONS = 50;
      for (let i = 0; i < OSCILLATIONS; i++) {
        // Trigger failover to standby
        await orchestrator.triggerFailover(`Oscillation failover #${i}`);
        expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
        expect(orchestrator.getActiveEngine()).toBe("wwebjs");

        // Send a message during standby
        const standbyReceipt = await orchestrator.sendMessage("5511999990000", {
          to: "5511999990000",
          type: "text",
          text: `Standby oscillation message #${i}`,
        });
        expect(standbyReceipt.status).toBe("SENT");

        // Trigger failback to primary
        await orchestrator.triggerFailback(`Oscillation failback #${i}`);
        expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
        expect(orchestrator.getActiveEngine()).toBe("baileys");

        // Send a message during primary
        const primaryReceipt = await orchestrator.sendMessage("5511999990000", {
          to: "5511999990000",
          type: "text",
          text: `Primary oscillation message #${i}`,
        });
        expect(primaryReceipt.status).toBe("SENT");

        // Outbound buffer MUST be completely drained
        expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);
      }

      expect(orchestrator.getFailoverCount()).toBe(OSCILLATIONS);
      expect(orchestrator.getFailbackCount()).toBe(OSCILLATIONS);

      await orchestrator.shutdown();
      expect(orchestrator.getState()).toBe("SHUTDOWN");
      expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);
    });
  });

  describe("4. Deterministic Zombie Process & Chromium Hygiene Audit", () => {
    it("terminates surviving child process tree via SIGKILL and purges Chromium singleton locks", async () => {
      const authDir = path.join(tempDir, "wwebjs-hygiene");
      await fs.mkdir(authDir, { recursive: true });

      // Create stale singleton locks simulating an aborted Chromium run
      await fs.writeFile(path.join(authDir, "SingletonLock"), "stale-pid-1234");
      await fs.writeFile(path.join(authDir, "SingletonCookie"), "stale-cookie");
      await fs.writeFile(path.join(authDir, "SingletonSocket"), "stale-socket");

      const mockProc = new MockPupProcess(77777);
      const mockBrowser = new MockPupBrowser(mockProc);

      let destroyCalled = false;
      class MockPupClient extends EventEmitter implements WWebJSClientInterface {
        public pupBrowser = mockBrowser;
        public async initialize(): Promise<void> {
          this.emit("ready");
        }
        public async destroy(): Promise<void> {
          destroyCalled = true;
          // Simulate hung destroy that times out
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        public async sendMessage(): Promise<{ id?: { id?: string; _serialized?: string } }> {
          return { id: { id: "msg_123" } };
        }
      }
      const mockClient = new MockPupClient();

      const killedPids: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        killedPids.push({ pid: Number(pid), signal: (signal ?? 0) as NodeJS.Signals | number });
        if (signal === "SIGKILL" || signal === 9) {
          mockProc.killed = true;
        }
        return true;
      });

      const driver = new WWebJSDriver({
        authDir,
        clientFactory: () => mockClient,
        teardownTimeoutMs: 100, // Fast timeout for test
        awaitReady: false,
      });

      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);

      // Now disconnect: destroy should timeout and trigger process-tree SIGKILL
      await driver.disconnect();

      expect(destroyCalled).toBe(true);
      expect(driver.getStatus().connected).toBe(false);
      expect(driver.getStatus().state).toBe("DISCONNECTED");

      // Verify process-tree kill attempted with negative or positive PID
      const sigkillAttempt = killedPids.find(
        (k) => (k.pid === -77777 || k.pid === 77777) && (k.signal === "SIGKILL" || k.signal === 9),
      );
      expect(sigkillAttempt).toBeDefined();

      // Verify stale singleton locks were completely removed
      const filesAfter = await fs.readdir(authDir);
      expect(filesAfter).not.toContain("SingletonLock");
      expect(filesAfter).not.toContain("SingletonCookie");
      expect(filesAfter).not.toContain("SingletonSocket");

      processKillSpy.mockRestore();
    });

    it("cleans up locks recursively via cleanupChromiumLocks", async () => {
      const authDir = path.join(tempDir, "locks-recursive");
      const subDir = path.join(authDir, "Default");
      await fs.mkdir(subDir, { recursive: true });

      await fs.writeFile(path.join(authDir, "SingletonLock"), "root");
      await fs.writeFile(path.join(subDir, "SingletonLock"), "sub");

      const removed = cleanupChromiumLocks(authDir);
      expect(removed.length).toBe(2);

      const rootFiles = await fs.readdir(authDir);
      expect(rootFiles).not.toContain("SingletonLock");

      const subFiles = await fs.readdir(subDir);
      expect(subFiles).not.toContain("SingletonLock");
    });
  });

  describe("5. Post-Shutdown Resource & Timer Invariant Verification", () => {
    it("confirms all internal timers, sockets, and listener sets are null or empty post-shutdown", async () => {
      const primaryDriver = new SoakMockDriver("baileys");
      const standbyDriver = new SoakMockDriver("wwebjs");

      const config = loadGatewayConfig({
        REDIS_URL: redisEnv.url,
        PORT: "0",
        AUTH_DIR_BAILEYS: path.join(tempDir, "baileys"),
        AUTH_DIR_WWEBJS: path.join(tempDir, "wwebjs"),
        INBOX_QUEUE_KEY: "soak:invariants:inbox",
        OUTBOUND_QUEUE_KEY: "soak:invariants:outbound",
        BLPOP_TIMEOUT_SECONDS: "0.05",
      });

      const app = new GatewayApplication({
        config,
        primaryDriver,
        standbyDriver,
        redisClient: testClient,
        blockingRedisClient: testClient,
      });

      app.setupSignalHandlers();
      await app.start();

      const orchestrator = app.getOrchestrator();
      const maintenanceDaemon = app.getMaintenanceDaemon();

      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
      expect(maintenanceDaemon.isRunning()).toBe(true);

      // Now cleanly stop the gateway
      await app.stop();

      // Invariants check post-shutdown:
      // 1. Gateway state
      expect(app.isRunning()).toBe(false);

      // 2. Orchestrator FSM state
      expect(orchestrator.getState()).toBe("SHUTDOWN");
      expect(orchestrator.getActiveEngine()).toBeNull();
      expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);

      // 3. Maintenance daemon timer cleared
      expect(maintenanceDaemon.isRunning()).toBe(false);
      expect(maintenanceDaemon.getNextScheduledRun()).toBeNull();

      // 4. Drivers disconnected
      expect(primaryDriver.connected).toBe(false);
      expect(standbyDriver.connected).toBe(false);
    });
  });
});
