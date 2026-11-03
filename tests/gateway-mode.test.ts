import { describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "../src/bootstrap/config.js";
import type { IWhatsAppDriver } from "../src/contracts/driver.js";
import { DisabledDriver } from "../src/drivers/disabled.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { GatewayHttpServer } from "../src/http/server.js";

function createMockDriver(name: "baileys" | "wwebjs", connected = true): IWhatsAppDriver {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({
      id: "msg_1",
      to: "5511999999999@s.whatsapp.net",
      status: "SENT",
      timestamp: Date.now(),
    }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendPresence: vi.fn().mockResolvedValue(undefined),
    getSelfJid: vi.fn().mockReturnValue(`123456@s.whatsapp.net`),
    getQrCode: vi.fn().mockReturnValue(undefined),
    onMessage: vi.fn(),
    onStatusChange: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      engine: name,
      state: connected ? "CONNECTED" : "DISCONNECTED",
      connected,
    }),
  };
}

describe("GATEWAY_MODE Configuration & Orchestration", () => {
  describe("loadGatewayConfig", () => {
    it("defaults to failover mode when GATEWAY_MODE is not set", () => {
      const config = loadGatewayConfig({});
      expect(config.gatewayMode).toBe("failover");
    });

    it("parses baileys_only mode across common casing variations", () => {
      expect(loadGatewayConfig({ GATEWAY_MODE: "baileys_only" }).gatewayMode).toBe("baileys_only");
      expect(loadGatewayConfig({ GATEWAY_MODE: "baileys-only" }).gatewayMode).toBe("baileys_only");
      expect(loadGatewayConfig({ GATEWAY_MODE: "baileys" }).gatewayMode).toBe("baileys_only");
      expect(loadGatewayConfig({ GATEWAY_MODE: "BAILEYS_ONLY" }).gatewayMode).toBe("baileys_only");
      expect(loadGatewayConfig({ GATEWAY_MODE: "  baileys_only  " }).gatewayMode).toBe(
        "baileys_only",
      );
    });

    it("falls back to failover mode on unknown values", () => {
      expect(loadGatewayConfig({ GATEWAY_MODE: "dual" }).gatewayMode).toBe("failover");
      expect(loadGatewayConfig({ GATEWAY_MODE: "unknown" }).gatewayMode).toBe("failover");
    });
  });

  describe("DisabledDriver", () => {
    it("reports DISABLED state and rejects dispatches", async () => {
      const driver = new DisabledDriver("wwebjs", "Test disabled");
      expect(driver.name).toBe("wwebjs");

      const status = driver.getStatus();
      expect(status.state).toBe("DISABLED");
      expect(status.connected).toBe(false);
      expect(status.error).toContain("Test disabled");

      await expect(
        driver.sendMessage("5511999999999@s.whatsapp.net", {
          to: "5511999999999@s.whatsapp.net",
          type: "text",
          text: "hi",
        }),
      ).rejects.toThrow("is disabled");
      if (driver.sendReaction) {
        await expect(driver.sendReaction("msg_1", "🔥")).rejects.toThrow("is disabled");
      }
      if (driver.requestPairing) {
        await expect(driver.requestPairing()).rejects.toThrow("is disabled");
      }

      // connect and disconnect should be silent no-ops
      await expect(driver.connect()).resolves.toBeUndefined();
      await expect(driver.disconnect()).resolves.toBeUndefined();
    });
  });

  describe("FailoverOrchestrator in baileys_only mode", () => {
    it("suppresses failover transitions and stays in PRIMARY_ACTIVE", async () => {
      const primary = createMockDriver("baileys", true);
      const standby = new DisabledDriver("wwebjs", "baileys_only mode");

      const orchestrator = new FailoverOrchestrator({
        primaryDriver: primary,
        standbyDriver: standby,
        gatewayMode: "baileys_only",
        disableBackgroundProbeTimer: true,
      });

      await orchestrator.start();
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");
      expect(orchestrator.isStandbyDisabled()).toBe(true);
      expect(orchestrator.getGatewayMode()).toBe("baileys_only");

      // Manual failover must be safely suppressed
      await orchestrator.triggerFailover("Manual failover test");
      expect(orchestrator.getState()).toBe("PRIMARY_ACTIVE");

      // Maintenance keepalive must throw
      await expect(orchestrator.enterMaintenanceKeepalive()).rejects.toThrow(
        "standby engine is disabled in baileys_only mode",
      );

      // Sending messages through primary works
      const receipt = await orchestrator.sendMessage("5511999999999@s.whatsapp.net", {
        to: "5511999999999@s.whatsapp.net",
        type: "text",
        text: "hello",
      });
      expect(receipt.id).toBe("msg_1");

      // Standby snapshot reflects DISABLED state
      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.standbyStatus.state).toBe("DISABLED");

      await orchestrator.shutdown();
    });
  });

  describe("GatewayHttpServer in baileys_only mode", () => {
    it("returns 404 for /qr/wwebjs and reports DISABLED standby in /health", async () => {
      const primary = createMockDriver("baileys", true);
      const standby = new DisabledDriver("wwebjs", "baileys_only mode");

      const orchestrator = new FailoverOrchestrator({
        primaryDriver: primary,
        standbyDriver: standby,
        gatewayMode: "baileys_only",
        disableBackgroundProbeTimer: true,
      });
      await orchestrator.start();

      const server = new GatewayHttpServer({
        port: 0,
        host: "127.0.0.1",
        orchestrator,
        primaryDriver: primary,
        standbyDriver: standby,
      });

      const port = await server.start(0, "127.0.0.1");

      // 1. Check /health
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as {
        status: string;
        primary: { engine: string };
        standby: { state: string };
      };
      expect(healthData.status).toBe("ok");
      expect(healthData.primary.engine).toBe("baileys");
      expect(healthData.standby.state).toBe("DISABLED");

      // 2. Check /qr/wwebjs
      const qrWwebjsRes = await fetch(`http://127.0.0.1:${port}/qr/wwebjs`);
      expect(qrWwebjsRes.status).toBe(404);
      const qrWwebjsData = (await qrWwebjsRes.json()) as { status: string };
      expect(qrWwebjsData.status).toBe("DISABLED");

      // 3. Check /qr/baileys
      const qrBaileysRes = await fetch(`http://127.0.0.1:${port}/qr/baileys`);
      expect(qrBaileysRes.status).toBe(200);

      await server.stop();
      await orchestrator.shutdown();
    });
  });
});
