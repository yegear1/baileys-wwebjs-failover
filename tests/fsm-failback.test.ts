import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { InMemoryFencingLock } from "../src/fsm/fencing.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { GatewayHttpServer } from "../src/http/server.js";
import type { RedisQueueManager } from "../src/queues/manager.js";

class StubDriver implements IWhatsAppDriver {
  private status: EngineStatus;
  private statusHandlers: Array<(status: EngineStatus) => void> = [];

  constructor(
    readonly name: EngineName,
    connected: boolean,
  ) {
    this.status = {
      engine: name,
      state: connected ? "CONNECTED" : "DISCONNECTED",
      connected,
      batteryLevel: 100,
    };
  }

  async connect(): Promise<void> {
    this.setStatus("CONNECTED", true);
  }

  async disconnect(): Promise<void> {
    this.setStatus("DISCONNECTED", false);
  }

  async sendMessage(to: string, _content: OutboundMessage): Promise<MessageReceipt> {
    return { id: `stub_${Math.random()}`, to, timestamp: Date.now(), status: "SENT" };
  }

  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}

  onStatusChange(handler: (status: EngineStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  setStatus(state: EngineStatus["state"], connected: boolean): void {
    this.status = { ...this.status, state, connected };
    for (const handler of this.statusHandlers) handler(this.status);
  }
}

const TEXT: OutboundMessage = { type: "text", to: "5511999998888@c.us", text: "hello" };

function buildOrchestrator(primaryConnected = true): {
  orchestrator: FailoverOrchestrator;
  primary: StubDriver;
  standby: StubDriver;
} {
  const primary = new StubDriver("baileys", primaryConnected);
  const standby = new StubDriver("wwebjs", false);
  const orchestrator = new FailoverOrchestrator({
    primaryDriver: primary,
    standbyDriver: standby,
    fencingLock: new InMemoryFencingLock(),
    circuitBreakerOptions: { probeSuccessThreshold: 3 },
    disableBackgroundProbeTimer: true,
  });
  return { orchestrator, primary, standby };
}

describe("Resilient failback orchestration", () => {
  const servers: GatewayHttpServer[] = [];
  const orchestrators: FailoverOrchestrator[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    for (const orchestrator of orchestrators.splice(0)) await orchestrator.shutdown();
  });

  it("keeps the primary circuit breaker untouched by standby dispatches", async () => {
    const { orchestrator } = buildOrchestrator();
    orchestrators.push(orchestrator);
    await orchestrator.start();
    await orchestrator.triggerFailover("test");
    const breaker = (orchestrator as unknown as { circuitBreaker: { getState(): string } })
      .circuitBreaker;
    expect(breaker.getState()).toBe("OPEN");

    await orchestrator.sendMessage("5511999998888@c.us", TEXT);

    expect(breaker.getState()).toBe("OPEN");
  });

  it("triggers failback after N consecutive probe successes", async () => {
    const { orchestrator } = buildOrchestrator();
    orchestrators.push(orchestrator);
    await orchestrator.start();
    await orchestrator.triggerFailover("test");
    // Dispatches on standby must not starve probe-based failback.
    await orchestrator.sendMessage("5511999998888@c.us", TEXT);

    await orchestrator.executeSilentProbe();
    await orchestrator.executeSilentProbe();
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
    await orchestrator.executeSilentProbe();

    await vi.waitFor(() => expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE"));
  });

  async function startHttp(
    orchestrator: FailoverOrchestrator,
    primary: StubDriver,
    standby: StubDriver,
  ) {
    const server = new GatewayHttpServer({
      orchestrator,
      primaryDriver: primary,
      standbyDriver: standby,
      queueManager: {} as unknown as RedisQueueManager,
      port: 0,
      host: "127.0.0.1",
    });
    servers.push(server);
    const port = await server.start(0, "127.0.0.1");
    return `http://127.0.0.1:${port}`;
  }

  it("POST /failback swaps back to primary and returns 202", async () => {
    const { orchestrator, primary, standby } = buildOrchestrator();
    orchestrators.push(orchestrator);
    await orchestrator.start();
    await orchestrator.triggerFailover("test");
    primary.setStatus("CONNECTED", true);
    const baseUrl = await startHttp(orchestrator, primary, standby);

    const res = await fetch(`${baseUrl}/failback`, { method: "POST" });

    expect(res.status).toBe(202);
    expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
  });

  it("POST /failback returns 409 when primary is disconnected", async () => {
    const { orchestrator, primary, standby } = buildOrchestrator();
    orchestrators.push(orchestrator);
    await orchestrator.start();
    await orchestrator.triggerFailover("test");
    primary.setStatus("DISCONNECTED", false);
    const baseUrl = await startHttp(orchestrator, primary, standby);

    const res = await fetch(`${baseUrl}/failback`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(orchestrator.getState()).toBe("FALLBACK_ACTIVE");
  });

  it("POST /failback returns 409 when no fallback is active", async () => {
    const { orchestrator, primary, standby } = buildOrchestrator();
    orchestrators.push(orchestrator);
    await orchestrator.start();
    const baseUrl = await startHttp(orchestrator, primary, standby);

    const res = await fetch(`${baseUrl}/failback`, { method: "POST" });

    expect(res.status).toBe(409);
  });
});
