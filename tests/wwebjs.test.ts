import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import pkg from "whatsapp-web.js";
import {
  DEFAULT_CHROMIUM_FLAGS,
  type InboundMessage,
  mapBaileysMessageToInbound,
  mapOutboundToWWebJSContent,
  mapWWebJSMessageToInbound,
  normalizeToCanonicalJid,
  type OutboundMessage,
  toWWebJSChatId,
  type WWebJSClientInterface,
  WWebJSDriver,
} from "../src/index.js";

const { MessageMedia } = pkg;

class MockWWebJSClient extends EventEmitter implements WWebJSClientInterface {
  public info = {
    wid: {
      _serialized: "bot-phone@c.us",
    },
  };

  public mockPid: number | undefined = 12345;
  public mockKilled = false;

  public pupBrowser = {
    process: () => ({
      pid: this.mockPid,
      killed: this.mockKilled,
    }),
  };

  public initializeMock = vi.fn().mockResolvedValue(undefined);
  public destroyMock = vi.fn().mockImplementation(async () => {
    this.mockKilled = true;
  });
  public sendMessageMock = vi.fn().mockResolvedValue({
    id: { id: "sent-wweb-msg-id", _serialized: "false_target@c.us_sent-wweb-msg-id" },
  });

  public async initialize(): Promise<void> {
    await this.initializeMock();
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

function createTestDriver(
  options: { mockClient?: MockWWebJSClient; teardownTimeoutMs?: number } = {},
): {
  driver: WWebJSDriver;
  mockClient: MockWWebJSClient;
  cleanup: () => void;
} {
  const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-unit-"));
  const authDir = join(tempParent, "auth");
  const mockClient = options.mockClient ?? new MockWWebJSClient();

  const driver = new WWebJSDriver({
    authDir,
    clientFactory: () => mockClient,
    ...(options.teardownTimeoutMs !== undefined
      ? { teardownTimeoutMs: options.teardownTimeoutMs }
      : {}),
  });

  const cleanup = () => {
    rmSync(tempParent, { recursive: true, force: true });
  };

  return { driver, mockClient, cleanup };
}

describe("JID Normalization & Conversion", () => {
  it("normalizes @c.us to canonical @s.whatsapp.net", () => {
    expect(normalizeToCanonicalJid("5511999999999@c.us")).toBe("5511999999999@s.whatsapp.net");
  });

  it("preserves group @g.us and broadcast JIDs", () => {
    expect(normalizeToCanonicalJid("123456789-987654@g.us")).toBe("123456789-987654@g.us");
    expect(normalizeToCanonicalJid("status@broadcast")).toBe("status@broadcast");
  });

  it("converts raw digits to canonical @s.whatsapp.net", () => {
    expect(normalizeToCanonicalJid("+55 (11) 99999-9999")).toBe("5511999999999@s.whatsapp.net");
  });

  it("converts canonical @s.whatsapp.net to WWebJS @c.us", () => {
    expect(toWWebJSChatId("5511999999999@s.whatsapp.net")).toBe("5511999999999@c.us");
    expect(toWWebJSChatId("5511999999999@c.us")).toBe("5511999999999@c.us");
    expect(toWWebJSChatId("123456789@g.us")).toBe("123456789@g.us");
    expect(toWWebJSChatId("5511999999999")).toBe("5511999999999@c.us");
  });
});

describe("Cross-Engine Deduplication Hash Invariant", () => {
  it("produces identical SHA-256 deduplication hashes across Baileys and WWebJS", () => {
    const timestampSec = 1700000000;
    const text = "Failover test message across engines";

    // Baileys format
    const baileysInbound = mapBaileysMessageToInbound({
      key: {
        id: "baileys-id-1",
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: timestampSec,
      message: {
        conversation: text,
      },
    });

    // WWebJS format
    const wwebjsInbound = mapWWebJSMessageToInbound({
      id: { id: "wwebjs-id-1", _serialized: "false_5511999999999@c.us_wwebjs-id-1" },
      from: "5511999999999@c.us",
      fromMe: false,
      timestamp: timestampSec,
      type: "chat",
      body: text,
    });

    expect(baileysInbound).not.toBeNull();
    expect(wwebjsInbound).not.toBeNull();
    expect(baileysInbound?.remoteJid).toBe(wwebjsInbound?.remoteJid);
    expect(baileysInbound?.senderJid).toBe(wwebjsInbound?.senderJid);
    expect(baileysInbound?.dedupHash).toBe(wwebjsInbound?.dedupHash);
    expect(wwebjsInbound?.dedupHash.length).toBe(64);
  });
});

describe("WWebJS Message Mapper", () => {
  it("maps text chat message", () => {
    const inbound = mapWWebJSMessageToInbound({
      id: { id: "msg-001" },
      from: "5511888888888@c.us",
      fromMe: false,
      timestamp: 1700000010,
      type: "chat",
      body: "Hello from standby!",
    });

    expect(inbound).not.toBeNull();
    expect(inbound?.id).toBe("msg-001");
    expect(inbound?.type).toBe("text");
    expect(inbound?.textBody).toBe("Hello from standby!");
    expect(inbound?.remoteJid).toBe("5511888888888@s.whatsapp.net");
    expect(inbound?.senderJid).toBe("5511888888888@s.whatsapp.net");
    expect(inbound?.fromMe).toBe(false);
  });

  it("maps group chat message with author as senderJid", () => {
    const inbound = mapWWebJSMessageToInbound({
      id: { id: "grp-001" },
      from: "123456789@g.us",
      author: "5511777777777@c.us",
      fromMe: false,
      timestamp: 1700000020,
      type: "chat",
      body: "Group announcement",
    });

    expect(inbound).not.toBeNull();
    expect(inbound?.remoteJid).toBe("123456789@g.us");
    expect(inbound?.senderJid).toBe("5511777777777@s.whatsapp.net");
    expect(inbound?.textBody).toBe("Group announcement");
  });

  it("maps media messages (image, audio, document)", () => {
    const imageInbound = mapWWebJSMessageToInbound({
      id: { id: "img-001" },
      from: "5511999999999@c.us",
      fromMe: false,
      timestamp: 1700000030,
      type: "image",
      body: "Photo caption",
      hasMedia: true,
      mediaKey: "img-key-hash",
    });

    expect(imageInbound?.type).toBe("image");
    expect(imageInbound?.media?.mimeType).toBe("image/jpeg");
    expect(imageInbound?.media?.caption).toBe("Photo caption");
    expect(imageInbound?.media?.digest).toBe("img-key-hash");

    const audioInbound = mapWWebJSMessageToInbound({
      id: { id: "aud-001" },
      from: "5511999999999@c.us",
      fromMe: false,
      timestamp: 1700000040,
      type: "ptt",
      hasMedia: true,
    });

    expect(audioInbound?.type).toBe("audio");
    expect(audioInbound?.media?.mimeType).toBe("audio/ogg");
  });

  it("returns null for malformed or missing id messages", () => {
    expect(
      mapWWebJSMessageToInbound({
        id: {},
        from: "5511999999999@c.us",
        fromMe: false,
        timestamp: 1700000000,
        type: "chat",
      }),
    ).toBeNull();
  });
});

describe("Outbound Message Mapper", () => {
  it("maps outbound text message", async () => {
    const outbound: OutboundMessage = {
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Test outbound text",
      quotedMessageId: "quote-123",
    };

    const payload = await mapOutboundToWWebJSContent(outbound);
    expect(payload.content).toBe("Test outbound text");
    expect(payload.options?.quotedMessageId).toBe("quote-123");
  });

  it("maps outbound media with base64 data URL", async () => {
    const outbound: OutboundMessage = {
      to: "5511999999999@s.whatsapp.net",
      type: "image",
      text: "Image with caption",
      media: {
        mimeType: "image/png",
        filename: "test.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      },
    };

    const payload = await mapOutboundToWWebJSContent(outbound);
    expect(payload.content).toBeInstanceOf(MessageMedia);
    const media = payload.content as pkg.MessageMedia;
    expect(media.mimetype).toBe("image/png");
    expect(media.filename).toBe("test.png");
    expect(payload.options?.caption).toBe("Image with caption");
  });

  it("throws error for media outbound without url", async () => {
    const outbound: OutboundMessage = {
      to: "5511999999999@s.whatsapp.net",
      type: "image",
    };

    await expect(mapOutboundToWWebJSContent(outbound)).rejects.toThrow(
      "Outbound image message requires media.url",
    );
  });
});

describe("WWebJSDriver Lifecycle & Event Wiring", () => {
  it("initializes with DISCONNECTED status and default Chromium flags", () => {
    const driver = new WWebJSDriver();
    const status = driver.getStatus();

    expect(status.engine).toBe("wwebjs");
    expect(status.state).toBe("DISCONNECTED");
    expect(status.connected).toBe(false);
    expect(DEFAULT_CHROMIUM_FLAGS).toContain("--disable-dev-shm-usage");
    expect(DEFAULT_CHROMIUM_FLAGS).toContain("--no-sandbox");
  });

  it("enforces 0700 auth permissions on connect", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "wwebjs-auth-"));
    const authPath = join(tempParent, "wwebjs-test");
    const mockClient = new MockWWebJSClient();

    const driver = new WWebJSDriver({
      authDir: authPath,
      clientFactory: () => mockClient,
    });

    try {
      await driver.connect();
      const stats = statSync(authPath);
      expect(stats.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o700);
      }
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("handles QR, ready, authenticated, and battery status transitions", async () => {
    const { driver, mockClient, cleanup } = createTestDriver();

    try {
      const statusChanges: string[] = [];
      driver.onStatusChange((s) => statusChanges.push(s.state));

      await driver.connect();
      expect(driver.getStatus().state).toBe("CONNECTING");

      // QR event
      mockClient.emit("qr", "wwebjs-pairing-qr-code");
      expect(driver.getStatus().state).toBe("PAIRING_QR_READY");
      expect(driver.getQrCode()).toBe("wwebjs-pairing-qr-code");

      // Authenticated event
      mockClient.emit("authenticated");

      // Ready event
      mockClient.emit("ready");
      expect(driver.getStatus().state).toBe("CONNECTED");
      expect(driver.getStatus().connected).toBe(true);
      expect(driver.getQrCode()).toBeUndefined();

      // Battery event
      mockClient.emit("change_battery", { battery: 85 });
      expect(driver.getStatus().batteryLevel).toBe(85);

      expect(statusChanges).toContain("PAIRING_QR_READY");
      expect(statusChanges).toContain("CONNECTED");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("handles auth_failure and disconnected events", async () => {
    const { driver, mockClient, cleanup } = createTestDriver();

    try {
      await driver.connect();

      // Auth failure
      mockClient.emit("auth_failure", "Session invalid");
      expect(driver.getStatus().state).toBe("UNPAIRED");
      expect(driver.getStatus().connected).toBe(false);
      expect(driver.getStatus().error).toBe("Session invalid");

      // Disconnected with LOGOUT
      mockClient.emit("disconnected", "LOGOUT");
      expect(driver.getStatus().state).toBe("UNPAIRED");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("forwards inbound messages to registered handler", async () => {
    const { driver, mockClient, cleanup } = createTestDriver();

    try {
      const received: InboundMessage[] = [];
      driver.onMessage(async (msg) => {
        received.push(msg);
      });

      await driver.connect();

      mockClient.emit("message", {
        id: { id: "inbound-msg-999" },
        from: "5511999999999@c.us",
        fromMe: false,
        timestamp: 1700000050,
        type: "chat",
        body: "Testing inbound forward",
      });

      expect(received.length).toBe(1);
      expect(received[0]?.id).toBe("inbound-msg-999");
      expect(received[0]?.remoteJid).toBe("5511999999999@s.whatsapp.net");
      expect(received[0]?.textBody).toBe("Testing inbound forward");
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("sends message successfully when connected", async () => {
    const { driver, mockClient, cleanup } = createTestDriver();

    try {
      await driver.connect();
      mockClient.emit("ready");

      const receipt = await driver.sendMessage("5511999999999@s.whatsapp.net", {
        to: "5511999999999@s.whatsapp.net",
        type: "text",
        text: "Test dispatch",
      });

      expect(receipt.status).toBe("SENT");
      expect(receipt.to).toBe("5511999999999@s.whatsapp.net");
      expect(receipt.id).toBe("sent-wweb-msg-id");
      expect(mockClient.sendMessageMock).toHaveBeenCalledWith(
        "5511999999999@c.us",
        "Test dispatch",
        undefined,
      );
    } finally {
      await driver.disconnect();
      cleanup();
    }
  });

  it("throws error when sending while disconnected", async () => {
    const driver = new WWebJSDriver();
    await expect(
      driver.sendMessage("5511999999999@s.whatsapp.net", {
        to: "5511999999999@s.whatsapp.net",
        type: "text",
        text: "Should fail",
      }),
    ).rejects.toThrow("Cannot send message: WWebJS driver is not connected");
  });
});

describe("Container Process Hygiene & Teardown", () => {
  it("destroys client and terminates process gracefully", async () => {
    const { driver, mockClient, cleanup } = createTestDriver();

    try {
      await driver.connect();
      mockClient.emit("ready");

      await driver.disconnect();

      expect(mockClient.destroyMock).toHaveBeenCalled();
      expect(driver.getStatus().state).toBe("DISCONNECTED");
      expect(driver.getStatus().connected).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("escalates to SIGKILL if client.destroy() hangs or process survives", async () => {
    const mockClient = new MockWWebJSClient();
    mockClient.mockKilled = false;
    mockClient.mockPid = 99999;
    mockClient.destroyMock = vi.fn().mockImplementation(async () => {
      // Simulate hanging destroy
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const { driver, cleanup } = createTestDriver({
      mockClient,
      teardownTimeoutMs: 10,
    });

    try {
      await driver.connect();
      await driver.disconnect();

      expect(killSpy).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
    } finally {
      killSpy.mockRestore();
      cleanup();
    }
  });
});
