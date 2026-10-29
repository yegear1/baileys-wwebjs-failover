import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayApplication, loadGatewayConfig } from "../src/bootstrap/index.js";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import type { IRedisClient } from "../src/queues/types.js";
import { calculateDedupHash } from "../src/utils/dedup.js";

class MockWhatsAppDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

  public sentMessages: Array<{ to: string; content: OutboundMessage }> = [];
  public connected = false;

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
    this.sentMessages.push({ to, content });
    return {
      id: `rcpt_${Date.now()}`,
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
  public readonly kvStore: Map<string, string>;
  public readonly listStore: Map<string, string[]>;
  public readonly waiters: Array<{
    key: string;
    resolve: (item: { key: string; element: string } | null) => void;
  }>;

  constructor(
    sharedKv?: Map<string, string>,
    sharedList?: Map<string, string[]>,
    sharedWaiters?: Array<{
      key: string;
      resolve: (item: { key: string; element: string } | null) => void;
    }>,
  ) {
    this.kvStore = sharedKv ?? new Map();
    this.listStore = sharedList ?? new Map();
    this.waiters = sharedWaiters ?? [];
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
      const waiterIdx = this.waiters.findIndex((w) => w.key === key);
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

    if (timeoutSeconds <= 0) {
      return null;
    }

    const targetKey = keys[0];
    if (!targetKey) {
      return null;
    }

    return new Promise<{ key: string; element: string } | null>((resolve) => {
      const waiter = { key: targetKey, resolve };
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
    _script: string,
    options?: { keys?: string[] | undefined; arguments?: string[] | undefined },
  ): Promise<unknown> {
    const key = options?.keys?.[0];
    const expectedValue = options?.arguments?.[0];
    if (key && expectedValue && this.kvStore.get(key) === expectedValue) {
      this.kvStore.delete(key);
      return 1;
    }
    return 0;
  }

  duplicate(): IRedisClient {
    return new MockRedisClient(this.kvStore, this.listStore, this.waiters);
  }
}

describe("GatewayConfig", () => {
  it("loads default gateway configuration cleanly", () => {
    const config = loadGatewayConfig({});
    expect(config.port).toBe(3000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
    expect(config.authDirBaileys).toBe("/data/auth/baileys");
    expect(config.authDirWWebJS).toBe("/data/auth/wwebjs");
    expect(config.failoverErrorThreshold).toBe(3);
    expect(config.probeStabilityWindowSec).toBe(300);
    expect(config.keepaliveIntervalDaysMin).toBe(3);
    expect(config.keepaliveIntervalDaysMax).toBe(5);
    expect(config.inboxQueueKey).toBe("whatsapp:receive:inbox");
    expect(config.outboundQueueKey).toBe("whatsapp:send:priority");
    expect(config.fencingLockKey).toBe("gateway:active_engine");
    expect(config.shutdownTimeoutMs).toBe(10000);
  });

  it("loads custom environment variable overrides correctly", () => {
    const config = loadGatewayConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      REDIS_URL: "redis://cache.local:6380",
      FAILOVER_ERROR_THRESHOLD: "5",
      PROBE_STABILITY_WINDOW_SEC: "120",
      KEEPALIVE_INTERVAL_DAYS_MIN: "2",
      KEEPALIVE_INTERVAL_DAYS_MAX: "4",
      SELF_CHAT_JID: "5511999998888@c.us",
      INBOX_QUEUE_KEY: "custom:inbox",
      OUTBOUND_QUEUE_KEY: "custom:outbound",
      SHUTDOWN_TIMEOUT_MS: "5000",
    });

    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.redisUrl).toBe("redis://cache.local:6380");
    expect(config.failoverErrorThreshold).toBe(5);
    expect(config.probeStabilityWindowSec).toBe(120);
    expect(config.keepaliveIntervalDaysMin).toBe(2);
    expect(config.keepaliveIntervalDaysMax).toBe(4);
    expect(config.selfChatJid).toBe("5511999998888@c.us");
    expect(config.inboxQueueKey).toBe("custom:inbox");
    expect(config.outboundQueueKey).toBe("custom:outbound");
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it("throws validation error when keepalive min days exceeds max days", () => {
    expect(() =>
      loadGatewayConfig({
        KEEPALIVE_INTERVAL_DAYS_MIN: "6",
        KEEPALIVE_INTERVAL_DAYS_MAX: "3",
      }),
    ).toThrow();
  });

  it("throws validation error for invalid port ranges", () => {
    expect(() => loadGatewayConfig({ PORT: "70000" })).toThrow();
    expect(() => loadGatewayConfig({ PORT: "-1" })).toThrow();
  });
});

describe("GatewayApplication Lifecycle Integration", () => {
  let tempBaseDir: string;
  let authDirBaileys: string;
  let authDirWWebJS: string;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-app-test-"));
    authDirBaileys = path.join(tempBaseDir, "baileys");
    authDirWWebJS = path.join(tempBaseDir, "wwebjs");
  });

  afterEach(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  it("bootstraps all services, serves HTTP observability, processes inbound and outbound queues, and tears down cleanly", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const redisClient = new MockRedisClient();

    const config = loadGatewayConfig({
      PORT: "0", // dynamic ephemeral port
      HOST: "127.0.0.1",
      AUTH_DIR_BAILEYS: authDirBaileys,
      AUTH_DIR_WWEBJS: authDirWWebJS,
      INBOX_QUEUE_KEY: "test:inbox",
      OUTBOUND_QUEUE_KEY: "test:outbound",
      BLPOP_TIMEOUT_SECONDS: "0.05",
    });

    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      disableBackgroundProbeTimer: true,
    });

    expect(app.isRunning()).toBe(false);

    // 1. Start application
    await app.start();
    expect(app.isRunning()).toBe(true);
    expect(primaryDriver.connected).toBe(true);

    const port = app.getHttpServer().getPort();
    expect(port).toBeDefined();
    expect(typeof port).toBe("number");

    // 2. HTTP Health Probe
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      status: string;
      active_engine: string;
      primary: { state: string };
      standby: { state: string };
    };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.active_engine).toBe("baileys");
    expect(healthBody.primary.state).toBe("CONNECTED");

    // 3. QR Endpoints
    const qrBaileysRes = await fetch(`http://127.0.0.1:${port}/qr/baileys`);
    expect(qrBaileysRes.status).toBe(200);
    const qrBaileysBody = (await qrBaileysRes.json()) as {
      engine: string;
      status: string;
    };
    expect(qrBaileysBody.engine).toBe("baileys");

    // 4. Inbound Message Pipeline (Driver -> Orchestrator -> Redis Inbox Queue)
    const inboundMsg: InboundMessage = {
      id: "inbound_boot_1",
      remoteJid: "5511999998888@c.us",
      senderJid: "5511999998888@c.us",
      fromMe: false,
      timestamp: 1700000000,
      type: "text",
      textBody: "Hello from user",
      dedupHash: calculateDedupHash({
        remoteJid: "5511999998888@c.us",
        senderJid: "5511999998888@c.us",
        timestamp: 1700000000,
        textBody: "Hello from user",
      }),
    };

    await primaryDriver.emitInboundMessage(inboundMsg);

    const inboxItems = redisClient.listStore.get("test:inbox");
    expect(inboxItems).toBeDefined();
    expect(inboxItems).toHaveLength(1);
    expect(JSON.parse(inboxItems?.[0] ?? "{}").id).toBe("inbound_boot_1");

    // 5. Outbound Message Pipeline (Redis Outbound Queue -> Outbound Worker -> Driver)
    await redisClient.lPush(
      "test:outbound",
      JSON.stringify({
        phone_number: "5511999998888@c.us",
        content: "Hello from gateway",
      }),
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(primaryDriver.sentMessages).toHaveLength(1);
    expect(primaryDriver.sentMessages[0]?.to).toBe("5511999998888@c.us");
    expect(primaryDriver.sentMessages[0]?.content.text).toBe("Hello from gateway");

    // 6. Graceful Teardown
    await app.stop();
    expect(app.isRunning()).toBe(false);

    // Verify double stop is idempotent
    await app.stop();
    expect(app.isRunning()).toBe(false);

    // Verify double start guard
    const app2 = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      disableBackgroundProbeTimer: true,
    });
    await app2.start();
    await app2.start(); // Should not throw
    expect(app2.isRunning()).toBe(true);
    await app2.stop();
  });

  it("handles process signal registration and invokes graceful exit callback", async () => {
    const primaryDriver = new MockWhatsAppDriver("baileys");
    const standbyDriver = new MockWhatsAppDriver("wwebjs");
    const redisClient = new MockRedisClient();

    const exitCodes: number[] = [];
    const onExit = (code: number) => {
      exitCodes.push(code);
    };

    const config = loadGatewayConfig({
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_DIR_BAILEYS: authDirBaileys,
      AUTH_DIR_WWEBJS: authDirWWebJS,
      BLPOP_TIMEOUT_SECONDS: "0.05",
      SHUTDOWN_TIMEOUT_MS: "2000",
    });

    const app = new GatewayApplication({
      config,
      primaryDriver,
      standbyDriver,
      redisClient,
      disableBackgroundProbeTimer: true,
      onExit,
    });

    await app.start();
    expect(app.isRunning()).toBe(true);

    app.setupSignalHandlers();

    // Verify calling setupSignalHandlers twice is safe
    app.setupSignalHandlers();

    // Emit SIGTERM on process
    process.emit("SIGTERM");

    // Wait for async stop to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(app.isRunning()).toBe(false);
    expect(exitCodes).toContain(0);

    // Cleanup listeners
    app.removeSignalHandlers();
  });
});
