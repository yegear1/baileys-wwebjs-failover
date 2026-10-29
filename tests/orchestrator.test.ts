import { describe, expect, it, vi } from "vitest";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { InMemoryFencingLock } from "../src/fsm/fencing.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import type { FailoverState } from "../src/fsm/types.js";

class MockWhatsAppDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

  public connectCalls = 0;
  public disconnectCalls = 0;
  public sentMessages: Array<{ to: string; content: OutboundMessage }> = [];
  public shouldFailSend = false;
  public sendErrorMessage = "Simulated driver send failure";

  constructor(name: EngineName, initialStatus?: Partial<EngineStatus>) {
    this.name = name;
    this.status = {
      engine: name,
      state: initialStatus?.state ?? "CONNECTED",
      connected: initialStatus?.connected ?? true,
      batteryLevel: 100,
      ...initialStatus,
    };
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = {
      ...this.status,
      state: "CONNECTED",
      connected: true,
    };
    this.notifyStatus(this.status);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.status = {
      ...this.status,
      state: "DISCONNECTED",
      connected: false,
    };
    this.notifyStatus(this.status);
  }

  async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (this.shouldFailSend) {
      throw new Error(this.sendErrorMessage);
    }
    this.sentMessages.push({ to, content });
    return {
      id: `mock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
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

  async simulateInboundMessage(msg: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(msg);
    }
  }

  simulateStatusChange(status: EngineStatus): void {
    this.status = status;
    this.notifyStatus(status);
  }

  private notifyStatus(status: EngineStatus): void {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}

function createSampleMessage(): InboundMessage {
  return {
    id: `inbound_${Date.now()}`,
    remoteJid: "5511999999999@s.whatsapp.net",
    senderJid: "5511999999999@s.whatsapp.net",
    fromMe: false,
    timestamp: Date.now(),
    type: "text",
    textBody: "Hello from test",
    dedupHash: `dedup_${Date.now()}`,
  };
}

describe("FailoverOrchestrator", () => {
  it("starts in PRIMARY_ACTIVE and routes messages through primary engine", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });
    const lock = new InMemoryFencingLock();

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      fencingLock: lock,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();

    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
    expect(orchestrator.getActiveEngine()).toBe("baileys");
    expect(await lock.getCurrentHolder()).toBe("baileys");

    const receipt = await orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Test ping",
    });

    expect(receipt.status).toBe("SENT");
    expect(primary.sentMessages).toHaveLength(1);
    expect(standby.sentMessages).toHaveLength(0);

    await orchestrator.shutdown();
  });

  it("routes inbound messages strictly from the active engine (split-brain protection)", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs");
    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    const receivedMessages: InboundMessage[] = [];
    orchestrator.onMessage(async (msg) => {
      receivedMessages.push(msg);
    });

    await orchestrator.start();

    // Primary message in PRIMARY_ACTIVE -> routed
    await primary.simulateInboundMessage(createSampleMessage());
    expect(receivedMessages).toHaveLength(1);

    // Standby message in PRIMARY_ACTIVE -> dropped
    await standby.simulateInboundMessage(createSampleMessage());
    expect(receivedMessages).toHaveLength(1);

    await orchestrator.shutdown();
  });

  it("trips circuit breaker on consecutive send failures and fails over cleanly", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });
    const lock = new InMemoryFencingLock();
    const transitions: FailoverState[] = [];

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      fencingLock: lock,
      circuitBreakerOptions: { failureThreshold: 3 },
      disableBackgroundProbeTimer: true,
    });

    orchestrator.onStateChange((_from, to) => {
      transitions.push(to);
    });

    await orchestrator.start();
    primary.shouldFailSend = true;

    // Fail 1
    await expect(
      orchestrator.sendMessage("5511000000001@s.whatsapp.net", {
        to: "5511000000001@s.whatsapp.net",
        type: "text",
        text: "1",
      }),
    ).rejects.toThrow();

    // Fail 2
    await expect(
      orchestrator.sendMessage("5511000000002@s.whatsapp.net", {
        to: "5511000000002@s.whatsapp.net",
        type: "text",
        text: "2",
      }),
    ).rejects.toThrow();

    // Fail 3 -> trips circuit breaker and triggers failover
    await expect(
      orchestrator.sendMessage("5511000000003@s.whatsapp.net", {
        to: "5511000000003@s.whatsapp.net",
        type: "text",
        text: "3",
      }),
    ).rejects.toThrow();

    // Allow async failover sequence to settle
    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
    });

    expect(transitions).toContain("FENCING");
    expect(transitions).toContain("COLD_START_STANDBY");
    expect(transitions).toContain("FALLBACK_ACTIVE");

    expect(orchestrator.getActiveEngine()).toBe("wwebjs");
    expect(primary.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(standby.connectCalls).toBeGreaterThanOrEqual(1);
    expect(await lock.getCurrentHolder()).toBe("wwebjs");

    await orchestrator.shutdown();
  });

  it("buffers outbound messages during transition and flushes them when standby connects", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    // Mock standby connect to take a moment so we can send during transition
    let resolveStandbyConnect: () => void = () => {};
    const standbyConnectPromise = new Promise<void>((resolve) => {
      resolveStandbyConnect = resolve;
    });

    vi.spyOn(standby, "connect").mockImplementation(async () => {
      await standbyConnectPromise;
    });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();

    // Trigger failover
    const failoverPromise = orchestrator.triggerFailover("Test buffering");

    // Wait until orchestrator is in COLD_START_STANDBY
    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("COLD_START_STANDBY");
    });

    // Send a message while cold-start is in progress
    const bufferedSendPromise = orchestrator.sendMessage("5511888888888@s.whatsapp.net", {
      to: "5511888888888@s.whatsapp.net",
      type: "text",
      text: "Buffered during cold start",
    });

    expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(1);

    // Complete standby startup
    resolveStandbyConnect();
    await failoverPromise;

    // The buffered send should have resolved through standby
    const receipt = await bufferedSendPromise;
    expect(receipt.status).toBe("SENT");
    expect(standby.sentMessages).toHaveLength(1);
    expect(standby.sentMessages[0]?.to).toBe("5511888888888@s.whatsapp.net");
    expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);

    await orchestrator.shutdown();
  });

  it("executes silent probe failback, draining and destroying standby (RECOVERY_SWAP)", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs");
    const lock = new InMemoryFencingLock();

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      fencingLock: lock,
      circuitBreakerOptions: { probeSuccessThreshold: 3 },
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    await orchestrator.triggerFailover("Initial failover");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Probes 1 and 2
    expect(await orchestrator.executeSilentProbe()).toBe(true);
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
    expect(await orchestrator.executeSilentProbe()).toBe(true);
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Probe 3 reaches probeSuccessThreshold and triggers failback
    expect(await orchestrator.executeSilentProbe()).toBe(true);

    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
    });

    expect(orchestrator.getActiveEngine()).toBe("baileys");
    expect(await lock.getCurrentHolder()).toBe("baileys");
    // INVARIANT: Standby disconnect must be invoked to destroy Chromium
    expect(standby.disconnectCalls).toBeGreaterThanOrEqual(1);

    await orchestrator.shutdown();
  });

  it("resets probe successes if a probe fails during silent probing", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs");

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      circuitBreakerOptions: { probeSuccessThreshold: 3 },
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    await orchestrator.triggerFailover("Initial failover");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // 1st successful probe
    expect(await orchestrator.executeSilentProbe()).toBe(true);

    // Primary drops connection and fails to reconnect during next probe
    await primary.disconnect();
    vi.spyOn(primary, "connect").mockRejectedValueOnce(new Error("Primary still unreachable"));
    expect(await orchestrator.executeSilentProbe()).toBe(false);
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    await orchestrator.shutdown();
  });

  it("supports entering and exiting standby maintenance keepalive", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

    await orchestrator.enterMaintenanceKeepalive();
    expect(orchestrator.getState()).toBe("MAINTENANCE_KEEPALIVE");
    expect(standby.connectCalls).toBe(1);

    // Primary still routes messages during maintenance keepalive
    await orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Normal traffic during maintenance",
    });
    expect(primary.sentMessages).toHaveLength(1);

    await orchestrator.exitMaintenanceKeepalive();
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
    expect(standby.disconnectCalls).toBe(1);

    await orchestrator.shutdown();
  });

  it("rejects invalid maintenance state transitions", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs");

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    await orchestrator.triggerFailover();

    // Cannot enter maintenance while in FALLBACK_ACTIVE
    await expect(orchestrator.enterMaintenanceKeepalive()).rejects.toThrow();

    await orchestrator.shutdown();
  });

  it("handles primary status changes to ERROR by triggering failover", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      circuitBreakerOptions: { failureThreshold: 2 },
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();

    // 1st error
    primary.simulateStatusChange({
      engine: "baileys",
      state: "ERROR",
      connected: false,
      error: "Socket dropped",
    });
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

    // 2nd error -> trips circuit breaker
    primary.simulateStatusChange({
      engine: "baileys",
      state: "ERROR",
      connected: false,
      error: "Socket closed permanently",
    });

    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
    });

    await orchestrator.shutdown();
  });

  it("rejects pending buffered messages on shutdown", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    // Keep standby connect hanging
    vi.spyOn(standby, "connect").mockImplementation(() => new Promise(() => {}));

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    void orchestrator.triggerFailover("Hanging standby");

    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("COLD_START_STANDBY");
    });

    const sendPromise = orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Buffered message",
    });

    await orchestrator.shutdown();
    expect(orchestrator.getState()).toBe("SHUTDOWN");
    await expect(sendPromise).rejects.toThrow("FailoverOrchestrator is shutting down");

    // Any send attempt after shutdown immediately rejects
    await expect(
      orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
        to: "5511999999999@s.whatsapp.net",
        type: "text",
        text: "Post-shutdown send",
      }),
    ).rejects.toThrow("FailoverOrchestrator is shutting down");
  });

  it("drains outbound buffer with custom reason on demand", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    // Keep standby connect hanging
    vi.spyOn(standby, "connect").mockImplementation(() => new Promise(() => {}));

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
    });

    await orchestrator.start();
    void orchestrator.triggerFailover("Hanging standby");

    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("COLD_START_STANDBY");
    });

    const sendPromise1 = orchestrator.sendMessage("5511111111111@s.whatsapp.net", {
      to: "5511111111111@s.whatsapp.net",
      type: "text",
      text: "Item 1",
    });
    const sendPromise2 = orchestrator.sendMessage("5511222222222@s.whatsapp.net", {
      to: "5511222222222@s.whatsapp.net",
      type: "text",
      text: "Item 2",
    });

    expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(2);

    const drainedCount = orchestrator.drainOutboundBuffer("Gateway shutting down preemptively");
    expect(drainedCount).toBe(2);
    expect(orchestrator.getSnapshot().bufferedMessagesCount).toBe(0);

    await expect(sendPromise1).rejects.toThrow("Gateway shutting down preemptively");
    await expect(sendPromise2).rejects.toThrow("Gateway shutting down preemptively");

    await orchestrator.shutdown();
  });

  it("suppresses failover to WWebJS standby when host connectivity probe reports offline", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });
    const hostProbe = vi.fn().mockResolvedValue(false);

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
      enableHostConnectivityGuard: true,
      hostConnectivityProbe: hostProbe,
    });

    await orchestrator.start();
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

    // Attempt to trigger failover (e.g. WAN outage dropped socket)
    await orchestrator.triggerFailover("Primary socket dropped during WAN outage");

    expect(hostProbe).toHaveBeenCalled();
    // Must remain PRIMARY_ACTIVE and not touch standby
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
    expect(orchestrator.getActiveEngine()).toBe("baileys");
    expect(standby.connectCalls).toBe(0);

    await orchestrator.shutdown();
  });

  it("allows failover to proceed when host connectivity probe reports online", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });
    const hostProbe = vi.fn().mockResolvedValue(true);

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
      enableHostConnectivityGuard: true,
      hostConnectivityProbe: hostProbe,
    });

    await orchestrator.start();
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

    await orchestrator.triggerFailover("Primary socket degraded while internet is active");

    expect(hostProbe).toHaveBeenCalled();
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
    expect(orchestrator.getActiveEngine()).toBe("wwebjs");
    expect(standby.connectCalls).toBe(1);

    await orchestrator.shutdown();
  });

  it("inspects existing primary connection state without calling connect() if already connected", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
      circuitBreakerOptions: { probeSuccessThreshold: 3 },
    });

    await orchestrator.start();
    await orchestrator.triggerFailover("Trigger failover for probe test");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Probe 1 connects primary
    expect(await orchestrator.executeSilentProbe()).toBe(true);
    const connectCallsAfterProbe1 = primary.connectCalls;

    // Probe 2 inspects existing connected state without calling connect() again
    expect(await orchestrator.executeSilentProbe()).toBe(true);
    expect(primary.connectCalls).toBe(connectCallsAfterProbe1);

    await orchestrator.shutdown();
  });

  it("tears down primary probe socket to prevent leaks when probe fails or times out", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
      probeTimeoutMs: 50,
    });

    await orchestrator.start();
    await orchestrator.triggerFailover("Failover trigger");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Primary hangs or fails to reach CONNECTED status
    primary.connect = vi.fn().mockImplementation(async () => {
      // Sets state to CONNECTING but never CONNECTED
      primary.simulateStatusChange({ engine: "baileys", state: "CONNECTING", connected: false });
    });

    const disconnectCallsBefore = primary.disconnectCalls;
    const probeResult = await orchestrator.executeSilentProbe();

    expect(probeResult).toBe(false);
    // Verifies safe teardown of probe socket
    expect(primary.disconnectCalls).toBeGreaterThan(disconnectCallsBefore);

    await orchestrator.shutdown();
  });

  it("monitors standby onStatusChange during FALLBACK_ACTIVE and triggers failback when standby crashes and primary is healthy", async () => {
    const primary = new MockWhatsAppDriver("baileys");
    const standby = new MockWhatsAppDriver("wwebjs", { state: "STANDBY", connected: false });

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: primary,
      standbyDriver: standby,
      disableBackgroundProbeTimer: true,
      circuitBreakerOptions: { probeSuccessThreshold: 5 }, // Needs 5 to normal failback
    });

    await orchestrator.start();
    await orchestrator.triggerFailover("Initial failover");
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Probe 1 makes primary connected
    await orchestrator.executeSilentProbe();
    expect(primary.getStatus().connected).toBe(true);
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");

    // Standby crashes unexpectedly during FALLBACK_ACTIVE
    standby.simulateStatusChange({
      engine: "wwebjs",
      state: "ERROR",
      connected: false,
      error: "Chromium crashed unexpectedly OOM",
    });

    // Standby crash triggers immediate recovery swap because primary is already connected
    await vi.waitFor(() => {
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
    });
    expect(orchestrator.getActiveEngine()).toBe("baileys");
    expect(orchestrator.getSnapshot().lastError).toBe("Chromium crashed unexpectedly OOM");

    await orchestrator.shutdown();
  });
});
