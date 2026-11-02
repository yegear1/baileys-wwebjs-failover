import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus, IWhatsAppDriver } from "../src/contracts/driver.js";
import { QrService } from "../src/http/qr-service.js";
import { type WWebJSClientInterface, WWebJSDriver } from "../src/index.js";

class PairingMockClient extends EventEmitter implements WWebJSClientInterface {
  public pupBrowser = { process: () => ({ pid: undefined, killed: true }) };
  public destroyMock = vi.fn().mockResolvedValue(undefined);
  public initializeMock = vi.fn().mockResolvedValue(undefined);

  public async initialize(): Promise<void> {
    await this.initializeMock();
  }

  public async destroy(): Promise<void> {
    await this.destroyMock();
  }

  public async sendMessage(): Promise<{ id?: { id?: string } }> {
    return {};
  }
}

describe("WWebJSDriver detached pairing lifecycle", () => {
  let authDir: string;
  let client: PairingMockClient;
  let factory: ReturnType<typeof vi.fn>;

  const makeDriver = (overrides: { timeout?: number; persist?: number } = {}): WWebJSDriver =>
    new WWebJSDriver({
      authDir,
      clientFactory: factory as unknown as () => WWebJSClientInterface,
      pairingTimeoutMs: overrides.timeout ?? 5000,
      pairingPersistDelayMs: overrides.persist ?? 30,
      pairingQrWaitMs: 1000,
      teardownTimeoutMs: 200,
    });

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "wwebjs-pair-"));
    client = new PairingMockClient();
    factory = vi.fn(() => client);
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
  });

  it("exposes qr_raw on the first QR event", async () => {
    const driver = makeDriver();
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("qr", "qr-token-1"));
    });

    await driver.requestPairing();

    expect(driver.getStatus().state).toBe("PAIRING_QR_READY");
    expect(driver.getQrCode()).toBe("qr-token-1");
    await driver.disconnect();
  });

  it("persists, destroys Chromium after the delay and rests as STANDBY_READY", async () => {
    const driver = makeDriver();
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("qr", "qr-token-1"));
    });
    await driver.requestPairing();

    client.emit("authenticated");
    expect(client.destroyMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(driver.getStatus().state).toBe("STANDBY_READY"));
    expect(client.destroyMock).toHaveBeenCalledTimes(1);
    expect(driver.getQrCode()).toBeUndefined();
    expect(driver.getStatus().connected).toBe(false);
  });

  it("returns to DISCONNECTED on pairing timeout", async () => {
    const driver = makeDriver({ timeout: 40 });
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("qr", "qr-token-1"));
    });
    await driver.requestPairing();

    await vi.waitFor(() => expect(driver.getStatus().state).toBe("DISCONNECTED"));
    expect(client.destroyMock).toHaveBeenCalledTimes(1);
    expect(driver.getQrCode()).toBeUndefined();
  });

  it("is idempotent while a pairing session is active", async () => {
    const driver = makeDriver();
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("qr", "qr-token-1"));
    });

    await Promise.all([driver.requestPairing(), driver.requestPairing()]);
    await driver.requestPairing();

    expect(factory).toHaveBeenCalledTimes(1);
    await driver.disconnect();
  });

  it("does not relaunch once resting as STANDBY_READY", async () => {
    const driver = makeDriver();
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("authenticated"));
    });
    await driver.requestPairing();
    await vi.waitFor(() => expect(driver.getStatus().state).toBe("STANDBY_READY"));

    await driver.requestPairing();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("tears down the pairing client when connect() is invoked for failover", async () => {
    const driver = makeDriver();
    client.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => client.emit("qr", "qr-token-1"));
    });
    await driver.requestPairing();

    const failoverClient = new PairingMockClient();
    factory.mockImplementation(() => failoverClient);
    failoverClient.initializeMock.mockImplementation(async () => {
      queueMicrotask(() => failoverClient.emit("ready"));
    });
    await driver.connect();

    expect(client.destroyMock).toHaveBeenCalledTimes(1);
    expect(driver.getStatus().state).toBe("CONNECTED");
    await driver.disconnect();
  });
});

describe("QrService lazy pairing trigger", () => {
  const makeDriver = (state: EngineStatus["state"]): IWhatsAppDriver & { pairing: () => void } => {
    const pairing = vi.fn();
    return {
      name: "wwebjs",
      connect: async () => {},
      disconnect: async () => {},
      sendMessage: async () => ({ id: "x", to: "y", timestamp: 0, status: "SENT" }),
      onMessage: () => {},
      onStatusChange: () => {},
      getStatus: () => ({ engine: "wwebjs", state, connected: false }),
      requestPairing: async () => {
        pairing();
      },
      pairing,
    };
  };

  it("triggers pairing only when allowed and the driver is idle", async () => {
    const service = new QrService();
    const idle = makeDriver("DISCONNECTED");
    await service.getQrStatus(idle, { allowPairing: true });
    expect(idle.pairing).toHaveBeenCalledTimes(1);

    const denied = makeDriver("DISCONNECTED");
    await service.getQrStatus(denied);
    expect(denied.pairing).not.toHaveBeenCalled();

    const resting = makeDriver("STANDBY_READY");
    await service.getQrStatus(resting, { allowPairing: true });
    expect(resting.pairing).not.toHaveBeenCalled();
  });
});
