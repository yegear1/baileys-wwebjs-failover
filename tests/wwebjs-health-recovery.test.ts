import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import {
  cleanupChromiumLocks,
  isProcessAlive,
  isProcessZombie,
  type WWebJSClientInterface,
  WWebJSDriver,
} from "../src/drivers/wwebjs.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { MetricsService } from "../src/http/metrics-service.js";

class MockPupProcess extends EventEmitter {
  public pid: number | undefined;
  public killed = false;

  constructor(pid = 99999) {
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

class MockPupPage extends EventEmitter {
  public closed = false;
  public shouldEvaluateHang = false;
  public shouldEvaluateThrow = false;

  public isClosed(): boolean {
    return this.closed;
  }

  public async evaluate<T>(_fn: () => T | Promise<T>): Promise<T> {
    if (this.shouldEvaluateHang) {
      return new Promise<never>(() => {});
    }
    if (this.shouldEvaluateThrow) {
      throw new Error("Page context destroyed");
    }
    return 1 as unknown as T;
  }
}

class ControllableMockClient extends EventEmitter implements WWebJSClientInterface {
  public info = {
    wid: {
      _serialized: "bot@c.us",
    },
  };

  public pupProcess: MockPupProcess;
  public pupBrowser: MockPupBrowser;
  public pupPage: MockPupPage;

  public initializeMock = vi.fn().mockResolvedValue(undefined);
  public destroyMock = vi.fn().mockImplementation(async () => {
    this.pupProcess.killed = true;
  });
  public sendMessageMock = vi.fn().mockResolvedValue({
    id: { id: "mock-receipt-id", _serialized: "false_target@c.us_mock-receipt-id" },
  });

  public autoReady = true;

  constructor(pid = 88888) {
    super();
    this.pupProcess = new MockPupProcess(pid);
    this.pupBrowser = new MockPupBrowser(this.pupProcess);
    this.pupPage = new MockPupPage();
  }

  public async initialize(): Promise<void> {
    await this.initializeMock();
    if (this.autoReady) {
      queueMicrotask(() => this.emit("ready"));
    }
  }

  public async destroy(): Promise<void> {
    await this.destroyMock();
  }

  public async sendMessage(
    chatId: string,
    content: unknown,
    options?: unknown,
  ): Promise<{ id?: { id?: string; _serialized?: string } }> {
    return this.sendMessageMock(chatId, content, options);
  }
}

function createHealthDriver(
  options: {
    authDir?: string;
    client?: ControllableMockClient;
    maxRestartRetries?: number;
    restartBackoffMs?: number;
    healthCheckIntervalMs?: number;
    pageProbeTimeoutMs?: number;
    enableAutoRecovery?: boolean;
  } = {},
): {
  driver: WWebJSDriver;
  getClient: () => ControllableMockClient;
  cleanup: () => void;
  authDir: string;
} {
  const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-health-test-"));
  const authDir = options.authDir ?? join(tempParent, "auth");
  mkdirSync(authDir, { recursive: true });
  const currentClient = options.client ?? new ControllableMockClient();

  const driver = new WWebJSDriver({
    authDir,
    clientFactory: () => {
      // Return existing client first time, new client on subsequent calls (e.g. restart recovery)
      const c = currentClient;
      return c;
    },
    maxRestartRetries: options.maxRestartRetries ?? 3,
    restartBackoffMs: options.restartBackoffMs ?? 10,
    healthCheckIntervalMs: options.healthCheckIntervalMs ?? 0,
    pageProbeTimeoutMs: options.pageProbeTimeoutMs ?? 50,
    enableAutoRecovery: options.enableAutoRecovery ?? true,
    awaitReady: true,
  });

  const cleanup = () => {
    rmSync(tempParent, { recursive: true, force: true });
  };

  return {
    driver,
    getClient: () => currentClient,
    cleanup,
    authDir,
  };
}

describe("Process Liveness & Zombie Inspection Utilities", () => {
  it("correctly determines that current process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("correctly determines that negative, zero or non-existent PID is not alive", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(3999999)).toBe(false);
  });

  it("safely checks zombie status on non-existent process without throwing", () => {
    expect(isProcessZombie(3999999)).toBe(false);
    expect(isProcessZombie(process.pid)).toBe(false);
  });

  it("detects and unlinks stale Chromium Singleton lockfiles", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "singleton-locks-"));
    const lock1 = join(tempDir, "SingletonLock");
    const lock2 = join(tempDir, "SingletonCookie");
    const lock3 = join(tempDir, "SingletonSocket");
    const normalFile = join(tempDir, "session.json");

    writeFileSync(lock1, "ETIPI-0004-9999");
    writeFileSync(lock2, "cookie-data");
    writeFileSync(lock3, "socket-data");
    writeFileSync(normalFile, '{"creds":true}');

    const removed = cleanupChromiumLocks(tempDir);
    expect(removed).toHaveLength(3);
    expect(removed).toContain(lock1);
    expect(removed).toContain(lock2);
    expect(removed).toContain(lock3);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("Dynamic Chromium Health Probing", () => {
  it("reports healthy when driver is dormant and disconnected", async () => {
    const { driver, cleanup } = createHealthDriver();
    try {
      const health = await driver.checkHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.browserConnected).toBe(false);
      expect(health.zombieDetected).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reports healthy when client is fully connected and page is responsive", async () => {
    const client = new ControllableMockClient(process.pid);
    const { driver, cleanup } = createHealthDriver({ client });
    try {
      await driver.connect();
      const health = await driver.checkHealth();

      expect(health.isHealthy).toBe(true);
      expect(health.browserConnected).toBe(true);
      expect(health.pageResponsive).toBe(true);
      expect(health.zombieDetected).toBe(false);
      expect(health.pid).toBe(process.pid);
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("reports unhealthy when browser CDP connection is dropped", async () => {
    const client = new ControllableMockClient(process.pid);
    const { driver, cleanup } = createHealthDriver({ client });
    try {
      await driver.connect();
      client.pupBrowser.connected = false;

      const health = await driver.checkHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.browserConnected).toBe(false);
      expect(health.error).toContain("CDP browser connection disconnected");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("reports unhealthy when page evaluation times out (frozen/hung page)", async () => {
    const client = new ControllableMockClient(process.pid);
    client.pupPage.shouldEvaluateHang = true;
    const { driver, cleanup } = createHealthDriver({
      client,
      pageProbeTimeoutMs: 20,
    });

    try {
      await driver.connect();
      const health = await driver.checkHealth();

      expect(health.isHealthy).toBe(false);
      expect(health.pageResponsive).toBe(false);
      expect(health.error).toContain("page execution is unresponsive");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("reports unhealthy when browser process is dead/terminated", async () => {
    const nonExistentPid = 3999999;
    const client = new ControllableMockClient(nonExistentPid);
    const { driver, cleanup } = createHealthDriver({ client });

    try {
      await driver.connect();
      const health = await driver.checkHealth();

      expect(health.isHealthy).toBe(false);
      expect(health.error).toContain("Chromium process terminated unexpectedly");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });
});

describe("Standby Puppeteer Restart Recovery", () => {
  it("automatically recovers when browser process emits 'exit' event", async () => {
    let clientCount = 0;
    const client1 = new ControllableMockClient(process.pid);
    const client2 = new ControllableMockClient(process.pid);

    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-restart-"));
    const authDir = join(tempParent, "auth");

    const statuses: EngineStatus[] = [];
    const driver = new WWebJSDriver({
      authDir,
      clientFactory: () => {
        clientCount++;
        return clientCount === 1 ? client1 : client2;
      },
      restartBackoffMs: 10,
      enableAutoRecovery: true,
      readyTimeoutMs: 1000,
    });

    driver.onStatusChange((s) => statuses.push({ ...s }));

    try {
      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);

      // Trigger unexpected exit on client 1 process
      client1.pupProcess.emit("exit", 1, "SIGTERM");

      // Await recovery
      await vi.waitFor(
        () => {
          expect(driver.getStatus().connected).toBe(true);
        },
        { timeout: 2000 },
      );

      expect(driver.getRestartCount()).toBe(1);
      expect(driver.getTotalRestarts()).toBe(1);

      // Verify intermediate status transitions
      const stateNames = statuses.map((s) => s.state);
      expect(stateNames).toContain("DEGRADED");
      expect(stateNames[stateNames.length - 1]).toBe("CONNECTED");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("automatically recovers when pupBrowser emits 'disconnected' event", async () => {
    let clientCount = 0;
    const client1 = new ControllableMockClient(process.pid);
    const client2 = new ControllableMockClient(process.pid);

    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-cdp-disc-"));
    const authDir = join(tempParent, "auth");

    const driver = new WWebJSDriver({
      authDir,
      clientFactory: () => {
        clientCount++;
        return clientCount === 1 ? client1 : client2;
      },
      restartBackoffMs: 10,
      enableAutoRecovery: true,
      readyTimeoutMs: 1000,
    });

    try {
      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);

      // Simulate CDP disconnect
      client1.pupBrowser.emit("disconnected");

      await vi.waitFor(
        () => {
          expect(driver.getStatus().connected).toBe(true);
        },
        { timeout: 2000 },
      );

      expect(driver.getRestartCount()).toBe(1);
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("transitions to ERROR state when restart attempts exceed maxRestartRetries", async () => {
    const client1 = new ControllableMockClient(process.pid);
    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-max-retries-"));
    const authDir = join(tempParent, "auth");

    let factoryCalls = 0;
    const driver = new WWebJSDriver({
      authDir,
      clientFactory: () => {
        factoryCalls++;
        if (factoryCalls > 1) {
          // Fail future initialize attempts
          const badClient = new ControllableMockClient(process.pid);
          badClient.initializeMock = vi.fn().mockRejectedValue(new Error("Relaunch crash"));
          return badClient;
        }
        return client1;
      },
      maxRestartRetries: 2,
      restartBackoffMs: 10,
      enableAutoRecovery: true,
    });

    try {
      await driver.connect();
      expect(driver.getStatus().connected).toBe(true);

      // Simulate crash
      client1.pupProcess.emit("exit", 137, "SIGKILL");

      await vi.waitFor(
        () => {
          expect(driver.getStatus().state).toBe("ERROR");
        },
        { timeout: 3000 },
      );

      expect(driver.getStatus().connected).toBe(false);
      expect(driver.getStatus().error).toContain("Exceeded max restart retries");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});

describe("Standby Hygiene & Lock Cleanup", () => {
  it("cleans up stale lockfiles and lingering processes during cleanupStandbyHygiene", () => {
    const { driver, authDir, cleanup } = createHealthDriver();
    try {
      const lockPath = join(authDir, "SingletonLock");
      writeFileSync(lockPath, "orphan-pid");

      const result = driver.cleanupStandbyHygiene();
      expect(result.locksRemoved).toContain(lockPath);
    } finally {
      cleanup();
    }
  });

  it("guarantees clean disconnect and standby hygiene after disconnect()", async () => {
    const client = new ControllableMockClient(process.pid);
    const { driver, authDir, cleanup } = createHealthDriver({ client });

    try {
      await driver.connect();
      writeFileSync(join(authDir, "SingletonCookie"), "stale-cookie");

      await driver.disconnect();
      expect(driver.getStatus().state).toBe("DISCONNECTED");
      expect(driver.getStatus().connected).toBe(false);
      expect(client.destroyMock).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe("Orchestrator Integration: Outbound Buffer Preservation During Recovery", () => {
  it("buffers outbound messages during standby DEGRADED state and flushes on recovery", async () => {
    let clientCount = 0;
    const client1 = new ControllableMockClient(process.pid);
    const client2 = new ControllableMockClient(process.pid);

    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-orch-recovery-"));
    const authDir = join(tempParent, "auth");

    const standbyDriver = new WWebJSDriver({
      authDir,
      clientFactory: () => {
        clientCount++;
        return clientCount === 1 ? client1 : client2;
      },
      restartBackoffMs: 20,
      enableAutoRecovery: true,
    });

    const mockPrimary: IWhatsAppDriver = {
      name: "baileys",
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockRejectedValue(new Error("Primary dead")),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
      getStatus: () => ({ engine: "baileys", state: "ERROR", connected: false }),
    };

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: mockPrimary,
      standbyDriver,
      disableBackgroundProbeTimer: true,
      circuitBreakerOptions: { failureThreshold: 1 },
    });

    try {
      // Force orchestrator into FALLBACK_ACTIVE
      await orchestrator.triggerFailover("Primary crashed");
      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
      expect(orchestrator.getActiveEngine()).toBe("wwebjs");

      // Trigger unexpected exit on standby client1
      client1.pupProcess.emit("exit", 1, "SIGTERM");

      // Immediately verify standby is in DEGRADED
      await vi.waitFor(() => {
        expect(standbyDriver.getStatus().state).toBe("DEGRADED");
      });

      // Send outbound message during DEGRADED recovery
      const sendPromise = orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
        type: "text",
        to: "5511999999999@s.whatsapp.net",
        text: "Message sent during standby recovery",
      });

      // Verify message is buffered in memory
      expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(1);

      // Wait for recovery to complete
      const receipt = await sendPromise;
      expect(receipt.id).toBe("mock-receipt-id");
      expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);
      expect(standbyDriver.getStatus().connected).toBe(true);
    } finally {
      await orchestrator.shutdown();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});

describe("Prometheus Metrics: chromium_restarts_total", () => {
  it("exports chromium_restarts_total when restarts occur on standby driver", async () => {
    let clientCount = 0;
    const client1 = new ControllableMockClient(process.pid);
    const client2 = new ControllableMockClient(process.pid);

    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-metrics-test-"));
    const authDir = join(tempParent, "auth");

    const standbyDriver = new WWebJSDriver({
      authDir,
      clientFactory: () => {
        clientCount++;
        return clientCount === 1 ? client1 : client2;
      },
      restartBackoffMs: 10,
      enableAutoRecovery: true,
    });

    const mockPrimary: IWhatsAppDriver = {
      name: "baileys",
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({
        id: "msg-p",
        to: "x",
        timestamp: Date.now(),
        status: "SENT",
      }),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
      getStatus: () => ({ engine: "baileys", state: "CONNECTED", connected: true }),
    };

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: mockPrimary,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });

    const metricsService = new MetricsService({
      orchestrator,
      primaryDriver: mockPrimary,
      standbyDriver,
    });

    try {
      await standbyDriver.connect();
      client1.pupProcess.emit("exit", 1, "SIGTERM");

      await vi.waitFor(
        () => {
          expect(standbyDriver.getRestartCount()).toBe(1);
        },
        { timeout: 2000 },
      );

      const metrics = await metricsService.getMetrics();
      expect(metrics).toContain("# HELP chromium_restarts_total");
      expect(metrics).toContain("chromium_restarts_total 1");
    } finally {
      await standbyDriver.disconnect();
      await orchestrator.shutdown();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});
