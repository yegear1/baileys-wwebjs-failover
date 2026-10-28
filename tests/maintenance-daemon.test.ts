import { describe, expect, it } from "vitest";
import type {
  EngineName,
  EngineStatus,
  IWhatsAppDriver,
  PresenceState,
} from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { StandbyMaintenanceDaemon } from "../src/maintenance/daemon.js";
import { calculateNextMaintenanceWindow, calculateTypingDelay } from "../src/maintenance/jitter.js";
import { generateDynamicKeepalivePayload } from "../src/maintenance/payload.js";

class MockTestDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

  public connectCalls = 0;
  public disconnectCalls = 0;
  public sentMessages: Array<{ to: string; content: OutboundMessage }> = [];
  public presenceUpdates: Array<{ to: string; state: PresenceState }> = [];
  public selfJid: string | undefined = "5511999998888@c.us";
  public shouldFailSend = false;

  constructor(name: EngineName, initialStatus?: Partial<EngineStatus>) {
    this.name = name;
    this.status = {
      engine: name,
      state: initialStatus?.state ?? "CONNECTED",
      connected: initialStatus?.connected ?? true,
      ...initialStatus,
    };
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = { ...this.status, state: "CONNECTED", connected: true };
    this.notifyStatus(this.status);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.status = { ...this.status, state: "DISCONNECTED", connected: false };
    this.notifyStatus(this.status);
  }

  async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (this.shouldFailSend) {
      throw new Error("Standby driver simulated send failure");
    }
    this.sentMessages.push({ to, content });
    return {
      id: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      to,
      timestamp: Date.now(),
      status: "SENT",
    };
  }

  async sendPresence(to: string, state: PresenceState): Promise<void> {
    this.presenceUpdates.push({ to, state });
  }

  getSelfJid(): string | undefined {
    return this.selfJid;
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

  private notifyStatus(status: EngineStatus): void {
    for (const h of this.statusHandlers) {
      h(status);
    }
  }
}

describe("Jitter & Quiet Hours Scheduling", () => {
  it("should schedule next window strictly between 3 and 5 days in the future", () => {
    const baseNow = new Date("2026-10-28T12:00:00.000Z");

    for (let i = 0; i < 100; i++) {
      const scheduled = calculateNextMaintenanceWindow(baseNow);
      const diffMs = scheduled.getTime() - baseNow.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      // Must be between ~2.5 days and ~5.5 days
      expect(diffDays).toBeGreaterThanOrEqual(2.5);
      expect(diffDays).toBeLessThanOrEqual(5.5);
    }
  });

  it("should land strictly inside quiet hours (02:30 to 05:40 local time)", () => {
    const baseNow = new Date();

    for (let i = 0; i < 200; i++) {
      const scheduled = calculateNextMaintenanceWindow(baseNow);
      const hour = scheduled.getHours();
      const minute = scheduled.getMinutes();
      const minuteOfDay = hour * 60 + minute;

      // 02:30 is 150 minutes; 05:40 is 340 minutes
      expect(minuteOfDay).toBeGreaterThanOrEqual(150);
      expect(minuteOfDay).toBeLessThanOrEqual(340);
    }
  });

  it("should respect custom schedule config overrides", () => {
    const baseNow = new Date("2026-10-28T12:00:00.000Z");
    const customConfig = {
      minDays: 1,
      maxDays: 1,
      windowStartHour: 3,
      windowStartMinute: 0,
      windowEndHour: 3,
      windowEndMinute: 30,
    };

    const scheduled = calculateNextMaintenanceWindow(baseNow, customConfig, () => 0.5);
    const hour = scheduled.getHours();
    const minute = scheduled.getMinutes();

    expect(hour).toBe(3);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThanOrEqual(30);
  });

  it("should compute typing delay within configured bounds (3000 to 5000 ms)", () => {
    for (let i = 0; i < 50; i++) {
      const delay = calculateTypingDelay(3000, 5000);
      expect(delay).toBeGreaterThanOrEqual(3000);
      expect(delay).toBeLessThanOrEqual(5000);
    }

    const minBound = calculateTypingDelay(3000, 5000, () => 0);
    expect(minBound).toBe(3000);

    const maxBound = calculateTypingDelay(3000, 5000, () => 1);
    expect(maxBound).toBe(5000);
  });
});

describe("Dynamic Non-Repeating Payload Generator", () => {
  it("should generate dynamic OutboundMessage with varied text and nonces", () => {
    const p1 = generateDynamicKeepalivePayload("5511999998888@c.us", 1);
    const p2 = generateDynamicKeepalivePayload("5511999998888@c.us", 2);
    const p3 = generateDynamicKeepalivePayload("5511999998888@c.us", 3);

    expect(p1.to).toBe("5511999998888@c.us");
    expect(p1.type).toBe("text");
    expect(p2.type).toBe("text");
    expect(p3.type).toBe("text");

    expect(p1.text).not.toEqual(p2.text);
    expect(p2.text).not.toEqual(p3.text);

    expect(p1.text).toContain("seq=1");
    expect(p2.text).toContain("seq=2");
    expect(p3.text).toContain("seq=3");
  });
});

describe("StandbyMaintenanceDaemon", () => {
  function createTestHarness() {
    const primaryDriver = new MockTestDriver("baileys", { state: "CONNECTED", connected: true });
    const standbyDriver = new MockTestDriver("wwebjs", { state: "DISCONNECTED", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      disableBackgroundProbeTimer: true,
    });

    return { primaryDriver, standbyDriver, orchestrator };
  }

  it("should initialize with correct default state and not run until started", () => {
    const { orchestrator, standbyDriver } = createTestHarness();

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
    });

    expect(daemon.isRunning()).toBe(false);
    expect(daemon.isCycleActive()).toBe(false);
    expect(daemon.getNextScheduledRun()).toBeNull();
    expect(daemon.getSequence()).toBe(0);
  });

  it("should manage scheduler lifecycle with start() and stop()", () => {
    const { orchestrator, standbyDriver } = createTestHarness();

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
    });

    daemon.start();
    expect(daemon.isRunning()).toBe(true);
    expect(daemon.getNextScheduledRun()).toBeInstanceOf(Date);

    daemon.stop();
    expect(daemon.isRunning()).toBe(false);
    expect(daemon.getNextScheduledRun()).toBeNull();
  });

  it("should execute a full maintenance keep-alive cycle cleanly", async () => {
    const { orchestrator, standbyDriver } = createTestHarness();
    await orchestrator.start();

    // Use fast typing delay config for testing
    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
      scheduleConfig: {
        typingDelayMinMs: 5,
        typingDelayMaxMs: 10,
      },
      selfChatJid: "5511999998888@c.us",
    });

    const result = await daemon.triggerCycleNow();

    expect(result.success).toBe(true);
    expect(result.targetJid).toBe("5511999998888@c.us");
    expect(result.messageReceiptId).toBeDefined();
    expect(daemon.getSequence()).toBe(1);

    // Verify presence sequencing: composing -> message sent -> paused
    expect(standbyDriver.presenceUpdates).toEqual([
      { to: "5511999998888@c.us", state: "composing" },
      { to: "5511999998888@c.us", state: "paused" },
    ]);

    // Verify self-chat message dispatch
    expect(standbyDriver.sentMessages).toHaveLength(1);
    expect(standbyDriver.sentMessages[0]?.to).toBe("5511999998888@c.us");
    expect(standbyDriver.sentMessages[0]?.content.type).toBe("text");

    // Verify orchestrator lifecycle returned to PRIMARY_ACTIVE
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

    // Verify standby Chromium is torn down and disconnected to free memory
    expect(standbyDriver.getStatus().connected).toBe(false);
    expect(standbyDriver.getStatus().state).toBe("DISCONNECTED");
  });

  it("should resolve self-chat JID dynamically from driver if not provided in options", async () => {
    const { orchestrator, standbyDriver } = createTestHarness();
    await orchestrator.start();

    standbyDriver.selfJid = "447700900000@c.us";

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
      scheduleConfig: { typingDelayMinMs: 1, typingDelayMaxMs: 2 },
    });

    const result = await daemon.triggerCycleNow();
    expect(result.targetJid).toBe("447700900000@c.us");
    expect(standbyDriver.sentMessages[0]?.to).toBe("447700900000@c.us");
  });

  it("should reject triggerCycleNow if another cycle is already active", async () => {
    const { orchestrator, standbyDriver } = createTestHarness();
    await orchestrator.start();

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
      scheduleConfig: { typingDelayMinMs: 200, typingDelayMaxMs: 200 },
    });

    const cycle1Promise = daemon.triggerCycleNow();
    await expect(daemon.triggerCycleNow()).rejects.toThrow(
      "Cannot trigger maintenance cycle: a cycle is already currently active",
    );

    await cycle1Promise;
  });

  it("should refuse to execute maintenance cycle if orchestrator is not in PRIMARY_ACTIVE", async () => {
    const { orchestrator, standbyDriver } = createTestHarness();
    await orchestrator.start();

    // Trigger failover to FALLBACK_ACTIVE
    await orchestrator.triggerFailover("Test failover");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
    });

    await expect(daemon.triggerCycleNow()).rejects.toThrow(
      "Cannot execute maintenance keepalive in orchestrator state FALLBACK_ACTIVE; primary is not active",
    );
  });

  it("should guarantee standby teardown if send fails during maintenance cycle", async () => {
    const { orchestrator, standbyDriver } = createTestHarness();
    await orchestrator.start();

    standbyDriver.shouldFailSend = true;

    const daemon = new StandbyMaintenanceDaemon({
      orchestrator,
      standbyDriver,
      scheduleConfig: { typingDelayMinMs: 1, typingDelayMaxMs: 2 },
    });

    await expect(daemon.triggerCycleNow()).rejects.toThrow("Standby driver simulated send failure");

    // Verify daemon reset cycle flag
    expect(daemon.isCycleActive()).toBe(false);

    // INVARIANT: Chromium standby must be torn down even on failure
    expect(standbyDriver.getStatus().connected).toBe(false);
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
  });
});
