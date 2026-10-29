import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineName, EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../src/contracts/messages.js";
import { InMemoryFencingLock } from "../src/fsm/fencing.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import type { FailoverState } from "../src/fsm/types.js";
import { DefaultQrRenderer, QrService } from "../src/http/qr-service.js";
import { GatewayHttpServer } from "../src/http/server.js";
import type { HealthResponsePayload, IQrRenderer, QrResponsePayload } from "../src/http/types.js";
import type { QueueManagerStatus, RedisQueueManager } from "../src/queues/manager.js";

class MockTestDriver implements IWhatsAppDriver {
  readonly name: EngineName;
  private status: EngineStatus;
  private qrCode?: string | undefined;

  constructor(name: EngineName, initialStatus?: Partial<EngineStatus>, qrCode?: string) {
    this.name = name;
    this.status = {
      engine: name,
      state: initialStatus?.state ?? "CONNECTED",
      connected: initialStatus?.connected ?? true,
      batteryLevel: 100,
      ...initialStatus,
    };
    this.qrCode = qrCode;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  setStatus(status: Partial<EngineStatus>): void {
    this.status = {
      ...this.status,
      ...status,
    };
  }

  getQrCode(): string | undefined {
    return this.qrCode;
  }

  setQrCode(qr?: string): void {
    this.qrCode = qr;
  }

  async connect(): Promise<void> {
    this.status = { ...this.status, state: "CONNECTED", connected: true };
  }

  async disconnect(): Promise<void> {
    this.status = { ...this.status, state: "DISCONNECTED", connected: false };
  }

  async sendMessage(to: string, _content: OutboundMessage): Promise<MessageReceipt> {
    return {
      id: "mock_msg_id",
      to,
      timestamp: Date.now(),
      status: "SENT",
    };
  }

  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}
  onStatusChange(_handler: (status: EngineStatus) => void): void {}
}

class MockQueueManager {
  private status: QueueManagerStatus = {
    isOpen: true,
    publisher: {
      publishedCount: 12,
      duplicateCount: 2,
    },
    worker: {
      isRunning: true,
      isPaused: false,
      processedCount: 45,
      errorCount: 0,
      requeuedCount: 0,
      dlqCount: 0,
    },
  };

  getStatus(): QueueManagerStatus {
    return this.status;
  }

  setIsOpen(isOpen: boolean): void {
    this.status = { ...this.status, isOpen };
  }

  async getQueueLengths(): Promise<{ inbox: number; outbound: number; dlq: number }> {
    return { inbox: 5, outbound: 3, dlq: 1 };
  }
}

describe("Dual-Device QR Pairing & Granular Health API", () => {
  let primaryDriver: MockTestDriver;
  let standbyDriver: MockTestDriver;
  let orchestrator: FailoverOrchestrator;
  let mockQueueManager: MockQueueManager;
  let server: GatewayHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    primaryDriver = new MockTestDriver("baileys", { state: "CONNECTED", connected: true });
    standbyDriver = new MockTestDriver("wwebjs", { state: "STANDBY", connected: false });
    mockQueueManager = new MockQueueManager();

    orchestrator = new FailoverOrchestrator({
      primaryDriver,
      standbyDriver,
      fencingLock: new InMemoryFencingLock(),
    });

    server = new GatewayHttpServer({
      orchestrator,
      primaryDriver,
      standbyDriver,
      queueManager: mockQueueManager as unknown as RedisQueueManager,
      port: 0,
      host: "127.0.0.1",
    });

    const port = await server.start(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe("QR Renderer and Service", () => {
    it("DefaultQrRenderer renders valid SVG containing xml and svg tags", async () => {
      const renderer = new DefaultQrRenderer();
      const svg = await renderer.renderSvg("2@test_pairing_token_123");
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    });

    it("QrService handles SVG renderer failure gracefully by returning raw token", async () => {
      const faultyRenderer: IQrRenderer = {
        async renderSvg() {
          throw new Error("SVG rendering fault");
        },
      };
      const qrService = new QrService(faultyRenderer);
      const driver = new MockTestDriver(
        "baileys",
        { state: "PAIRING_QR_READY", connected: false },
        "token_123",
      );

      const status = await qrService.getQrStatus(driver);
      expect(status.engine).toBe("baileys");
      expect(status.status).toBe("PAIRING_QR_READY");
      expect(status.qr_raw).toBe("token_123");
      expect(status.qr_svg).toBeUndefined();
    });
  });

  describe("GET /health", () => {
    it("returns 200 OK and status 'ok' when primary is active and connected", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as HealthResponsePayload;
      expect(data.status).toBe("ok");
      expect(data.active_engine).toBe("baileys");
      expect(data.primary.connected).toBe(true);
      expect(data.standby.connected).toBe(false);
      expect(data.queues).toBeDefined();
      expect(data.queues?.isOpen).toBe(true);
      expect(data.queues?.publisher.publishedCount).toBe(12);
      expect(data.queues?.worker.processedCount).toBe(45);
    });

    it("returns 200 OK and status 'degraded' when fallback standby is serving traffic", async () => {
      primaryDriver.setStatus({ state: "DISCONNECTED", connected: false });
      standbyDriver.setStatus({ state: "CONNECTED", connected: true });

      const internalOrchestrator = orchestrator as unknown as {
        state: FailoverState;
        activeEngine: EngineName | null;
      };
      internalOrchestrator.state = "FALLBACK_ACTIVE";
      internalOrchestrator.activeEngine = "wwebjs";

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as HealthResponsePayload;
      expect(data.status).toBe("degraded");
      expect(data.active_engine).toBe("wwebjs");
      expect(data.primary.connected).toBe(false);
      expect(data.standby.connected).toBe(true);
    });

    it("returns 503 and status 'down' when neither engine is connected", async () => {
      primaryDriver.setStatus({ state: "DISCONNECTED", connected: false });
      standbyDriver.setStatus({ state: "DISCONNECTED", connected: false });
      const internalOrchestrator = orchestrator as unknown as {
        state: FailoverState;
        activeEngine: EngineName | null;
      };
      internalOrchestrator.state = "FENCING";
      internalOrchestrator.activeEngine = null;

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(503);

      const data = (await res.json()) as HealthResponsePayload;
      expect(data.status).toBe("down");
      expect(data.active_engine).toBeNull();
      expect(data.primary.connected).toBe(false);
      expect(data.standby.connected).toBe(false);
    });

    it("omits queues payload when queueManager is not configured", async () => {
      const serverWithoutQueues = new GatewayHttpServer({
        orchestrator,
        primaryDriver,
        standbyDriver,
        port: 0,
        host: "127.0.0.1",
      });
      const port = await serverWithoutQueues.start(0, "127.0.0.1");

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const data = (await res.json()) as HealthResponsePayload;
        expect(data.status).toBe("ok");
        expect(data.queues).toBeUndefined();
      } finally {
        await serverWithoutQueues.stop();
      }
    });
  });

  describe("GET /qr/baileys", () => {
    it("returns 200 with raw token and SVG when primary pairing QR is available", async () => {
      primaryDriver.setStatus({ state: "PAIRING_QR_READY", connected: false });
      primaryDriver.setQrCode("2@baileys_test_pairing_token");

      const res = await fetch(`${baseUrl}/qr/baileys`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as QrResponsePayload;
      expect(data.engine).toBe("baileys");
      expect(data.status).toBe("PAIRING_QR_READY");
      expect(data.qr_raw).toBe("2@baileys_test_pairing_token");
      expect(data.qr_svg).toContain("<svg");
      expect(data.qr_svg).toContain("</svg>");
    });

    it("returns 200 with status CONNECTED and no QR when session is already paired", async () => {
      primaryDriver.setStatus({ state: "CONNECTED", connected: true });
      primaryDriver.setQrCode(undefined);

      const res = await fetch(`${baseUrl}/qr/baileys`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as QrResponsePayload;
      expect(data.engine).toBe("baileys");
      expect(data.status).toBe("CONNECTED");
      expect(data.qr_raw).toBeUndefined();
      expect(data.qr_svg).toBeUndefined();
    });
  });

  describe("GET /qr/wwebjs", () => {
    it("returns 200 with raw token and SVG when standby pairing QR is available", async () => {
      standbyDriver.setStatus({ state: "PAIRING_QR_READY", connected: false });
      standbyDriver.setQrCode("2@wwebjs_standby_pairing_token");

      const res = await fetch(`${baseUrl}/qr/wwebjs`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as QrResponsePayload;
      expect(data.engine).toBe("wwebjs");
      expect(data.status).toBe("PAIRING_QR_READY");
      expect(data.qr_raw).toBe("2@wwebjs_standby_pairing_token");
      expect(data.qr_svg).toContain("<svg");
    });

    it("returns 200 with status STANDBY and no QR when standby session is dormant", async () => {
      standbyDriver.setStatus({ state: "STANDBY", connected: false });
      standbyDriver.setQrCode(undefined);

      const res = await fetch(`${baseUrl}/qr/wwebjs`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as QrResponsePayload;
      expect(data.engine).toBe("wwebjs");
      expect(data.status).toBe("STANDBY");
      expect(data.qr_raw).toBeUndefined();
    });
  });

  describe("GET /metrics (Prometheus Exporter)", () => {
    it("returns 200 OK with Prometheus exposition content-type and valid metrics headers", async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");

      const body = await res.text();
      expect(body).toContain("# HELP failover_events_total");
      expect(body).toContain("# TYPE failover_events_total counter");
      expect(body).toContain("failover_events_total 0");

      expect(body).toContain("# HELP fsm_state");
      expect(body).toContain('fsm_state{state="PRIMARY_ACTIVE"} 1');
      expect(body).toContain('fsm_state{state="FALLBACK_ACTIVE"} 0');

      expect(body).toContain("# HELP engine_status");
      expect(body).toContain('engine_status{engine="baileys",role="primary"} 1');
      expect(body).toContain('engine_status{engine="wwebjs",role="standby"} 0');

      expect(body).toContain("# HELP queue_length");
      expect(body).toContain('queue_length{queue="inbox"} 5');
      expect(body).toContain('queue_length{queue="outbound"} 3');
      expect(body).toContain('queue_length{queue="dlq"} 1');

      expect(body).toContain("# HELP dlq_messages_total");
      expect(body).toContain("dlq_messages_total 0");

      expect(body).toContain("# HELP messages_processed_total");
      expect(body).toContain("messages_processed_total 45");

      expect(body).toContain("# HELP messages_inbound_published_total");
      expect(body).toContain("messages_inbound_published_total 12");

      expect(body).toContain("# HELP messages_inbound_duplicate_total");
      expect(body).toContain("messages_inbound_duplicate_total 2");

      expect(body).toContain("# HELP gateway_health_status");
      expect(body).toContain('gateway_health_status{status="ok"} 1');
    });

    it("dynamically increments failover counter and updates state upon failover transition", async () => {
      await orchestrator.start();
      await orchestrator.triggerFailover("Simulated failover for metrics test");

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();

      expect(body).toContain("failover_events_total 1");
      expect(body).toContain('fsm_state{state="PRIMARY_ACTIVE"} 0');
      expect(body).toContain('fsm_state{state="FALLBACK_ACTIVE"} 1');
    });

    it("tracks engine dispatch latency when messages are sent", async () => {
      await orchestrator.start();
      await orchestrator.sendMessage("5511999998888@c.us", {
        to: "5511999998888@c.us",
        type: "text",
        text: "Latency measurement test",
      });

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();

      expect(body).toMatch(/engine_latency_seconds\{engine="baileys"\} \d+(\.\d+)?/);
      expect(body).toContain('engine_latency_seconds{engine="wwebjs"} 0');
    });

    it("operates gracefully when queueManager is omitted (standalone server)", async () => {
      const serverWithoutQueues = new GatewayHttpServer({
        orchestrator,
        primaryDriver,
        standbyDriver,
        port: 0,
        host: "127.0.0.1",
      });
      const port = await serverWithoutQueues.start(0, "127.0.0.1");

      try {
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
        const body = await res.text();

        expect(body).toContain('queue_length{queue="inbox"} 0');
        expect(body).toContain('queue_length{queue="outbound"} 0');
        expect(body).toContain('queue_length{queue="dlq"} 0');
        expect(body).toContain("dlq_messages_total 0");
      } finally {
        await serverWithoutQueues.stop();
      }
    });

    it("security invariant: never leaks pairing tokens, phone numbers, or passwords", async () => {
      primaryDriver.setQrCode("2@secret_pairing_token_never_leak");
      await orchestrator.start();
      await orchestrator.sendMessage("5511999998888@c.us", {
        to: "5511999998888@c.us",
        type: "text",
        text: "top_secret_classified_payload",
      });

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();

      expect(body).not.toContain("secret_pairing_token_never_leak");
      expect(body).not.toContain("5511999998888");
      expect(body).not.toContain("top_secret_classified_payload");
      expect(body).not.toContain("password");
    });
  });

  describe("HTTP edge cases & error routes", () => {
    it("returns 404 for unknown route", async () => {
      const res = await fetch(`${baseUrl}/nonexistent`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Not Found");
    });

    it("returns 405 Method Not Allowed for POST requests", async () => {
      const res = await fetch(`${baseUrl}/health`, { method: "POST" });
      expect(res.status).toBe(405);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Method Not Allowed");
    });

    it("handles OPTIONS request with 204 No Content and CORS headers", async () => {
      const res = await fetch(`${baseUrl}/health`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    });
  });
});
