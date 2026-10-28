import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthenticationState,
  UserFacingSocketConfig,
  WASocket,
} from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import {
  BaileysDriver,
  ensureSecureAuthDirectory,
  mapBaileysMessageToInbound,
  mapOutboundToBaileysContent,
} from "../src/index.js";

class MockSocketEventEmitter extends EventEmitter {
  public process = vi.fn();
  public buffer = vi.fn();
  public flush = vi.fn();
  public createBufferedFunction = vi.fn();
}

function createMockSocket(): {
  sock: WASocket;
  ev: MockSocketEventEmitter;
  sendMessageMock: ReturnType<typeof vi.fn>;
  sendPresenceUpdateMock: ReturnType<typeof vi.fn>;
  endMock: ReturnType<typeof vi.fn>;
} {
  const ev = new MockSocketEventEmitter();
  const sendMessageMock = vi.fn().mockResolvedValue({
    key: { id: "mock-wa-msg-id" },
  });
  const sendPresenceUpdateMock = vi.fn().mockResolvedValue(undefined);
  const endMock = vi.fn();

  const sock = {
    ev: ev as unknown as WASocket["ev"],
    user: { id: "bot-user:1@s.whatsapp.net" },
    sendMessage: sendMessageMock,
    sendPresenceUpdate: sendPresenceUpdateMock,
    end: endMock,
  } as unknown as WASocket;

  return { sock, ev, sendMessageMock, sendPresenceUpdateMock, endMock };
}

describe("ensureSecureAuthDirectory", () => {
  it("creates directory and enforces 0700 permissions", () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-test-"));
    const authPath = join(tempParent, "baileys-test");

    try {
      ensureSecureAuthDirectory(authPath);
      const stats = statSync(authPath);
      expect(stats.isDirectory()).toBe(true);
      // POSIX mode check (rwx------)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});

describe("Baileys Message Mapper", () => {
  it("maps simple conversation text message", () => {
    const inbound = mapBaileysMessageToInbound({
      key: {
        id: "msg-123",
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: 1700000000,
      message: {
        conversation: "Hello world!",
      },
    });

    expect(inbound).not.toBeNull();
    expect(inbound?.id).toBe("msg-123");
    expect(inbound?.type).toBe("text");
    expect(inbound?.textBody).toBe("Hello world!");
    expect(inbound?.senderJid).toBe("5511999999999@s.whatsapp.net");
    expect(inbound?.dedupHash).toBeDefined();
    expect(inbound?.dedupHash.length).toBe(64);
  });

  it("maps group message with participant as senderJid", () => {
    const inbound = mapBaileysMessageToInbound({
      key: {
        id: "group-msg-1",
        remoteJid: "123456789@g.us",
        participant: "5511888888888@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: 1700000010,
      message: {
        extendedTextMessage: {
          text: "Group message text",
        },
      },
    });

    expect(inbound?.senderJid).toBe("5511888888888@s.whatsapp.net");
    expect(inbound?.remoteJid).toBe("123456789@g.us");
    expect(inbound?.textBody).toBe("Group message text");
  });

  it("maps image message with digest and caption", () => {
    const fileSha = new Uint8Array([1, 2, 3, 4, 5]);
    const inbound = mapBaileysMessageToInbound({
      key: {
        id: "img-msg-1",
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: 1700000020,
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          caption: "Photo caption",
          fileSha256: fileSha,
          fileLength: 1024,
        },
      },
    });

    expect(inbound?.type).toBe("image");
    expect(inbound?.textBody).toBe("Photo caption");
    expect(inbound?.media?.digest).toBe(Buffer.from(fileSha).toString("hex"));
    expect(inbound?.media?.sizeBytes).toBe(1024);
  });

  it("returns null for empty or keyless messages", () => {
    expect(
      mapBaileysMessageToInbound({
        key: undefined,
      } as unknown as Parameters<typeof mapBaileysMessageToInbound>[0]),
    ).toBeNull();
    expect(mapBaileysMessageToInbound({ key: { id: "1" } })).toBeNull();
  });

  it("maps outbound text message to Baileys content", () => {
    const content = mapOutboundToBaileysContent({
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Test outbound text",
    });

    expect(content).toEqual({ text: "Test outbound text" });
  });

  it("maps outbound image message with media.url", () => {
    const content = mapOutboundToBaileysContent({
      to: "5511999999999@s.whatsapp.net",
      type: "image",
      text: "Look at this",
      media: {
        url: "https://example.com/image.png",
        mimeType: "image/png",
      },
    });

    expect(content).toEqual({
      image: { url: "https://example.com/image.png" },
      mimetype: "image/png",
      caption: "Look at this",
    });
  });

  it("throws when outbound media message lacks media.url", () => {
    expect(() =>
      mapOutboundToBaileysContent({
        to: "5511999999999@s.whatsapp.net",
        type: "image",
      }),
    ).toThrow("Outbound image message requires media.url");
  });
});

describe("BaileysDriver", () => {
  it("initializes in DISCONNECTED state", () => {
    const driver = new BaileysDriver();
    const status = driver.getStatus();

    expect(status.engine).toBe("baileys");
    expect(status.state).toBe("DISCONNECTED");
    expect(status.connected).toBe(false);
    expect(driver.getQrCode()).toBeUndefined();
  });

  it("manages connection lifecycle and pairing QR event", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    const saveCredsMock = vi.fn().mockResolvedValue(undefined);
    const authStateLoader = vi.fn().mockResolvedValue({
      state: {} as AuthenticationState,
      saveCreds: saveCredsMock,
    });
    const socketFactory = vi.fn().mockReturnValue(sock);

    const driver = new BaileysDriver({
      authDir,
      authStateLoader,
      socketFactory: socketFactory as unknown as (config: UserFacingSocketConfig) => WASocket,
    });

    const statusUpdates: string[] = [];
    driver.onStatusChange((status) => {
      statusUpdates.push(status.state);
    });

    try {
      await driver.connect();
      expect(driver.getStatus().state).toBe("CONNECTING");

      // Simulate QR emitted
      ev.emit("connection.update", { qr: "qr-raw-payload-string" });
      expect(driver.getStatus().state).toBe("PAIRING_QR_READY");
      expect(driver.getQrCode()).toBe("qr-raw-payload-string");

      // Simulate Connection open
      ev.emit("connection.update", { connection: "open" });
      expect(driver.getStatus().state).toBe("CONNECTED");
      expect(driver.getStatus().connected).toBe(true);
      expect(driver.getQrCode()).toBeUndefined();

      // Simulate Creds update
      ev.emit("creds.update");
      expect(saveCredsMock).toHaveBeenCalled();

      // Verify sequence of status updates
      expect(statusUpdates).toEqual(["CONNECTING", "PAIRING_QR_READY", "CONNECTED"]);
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("handles inbound messages from messages.upsert", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-upsert-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
        config: UserFacingSocketConfig,
      ) => WASocket,
    });

    const receivedMessages: string[] = [];
    driver.onMessage(async (msg) => {
      if (msg.textBody) {
        receivedMessages.push(msg.textBody);
      }
    });

    try {
      await driver.connect();

      ev.emit("messages.upsert", {
        type: "notify",
        messages: [
          {
            key: {
              id: "upsert-msg-1",
              remoteJid: "5511999999999@s.whatsapp.net",
              fromMe: false,
            },
            messageTimestamp: 1700000050,
            message: {
              conversation: "Upsert incoming message",
            },
          },
        ],
      });

      expect(receivedMessages).toContain("Upsert incoming message");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("sends message and returns receipt when connected", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-send-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev, sendMessageMock } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
        config: UserFacingSocketConfig,
      ) => WASocket,
    });

    try {
      await driver.connect();
      // Set to connected
      ev.emit("connection.update", { connection: "open" });

      const receipt = await driver.sendMessage("5511999999999", {
        to: "5511999999999",
        type: "text",
        text: "Hello via Baileys",
      });

      expect(sendMessageMock).toHaveBeenCalledWith("5511999999999@s.whatsapp.net", {
        text: "Hello via Baileys",
      });
      expect(receipt.id).toBe("mock-wa-msg-id");
      expect(receipt.status).toBe("SENT");
      expect(receipt.to).toBe("5511999999999");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("throws when sendMessage is called while disconnected", async () => {
    const driver = new BaileysDriver();
    await expect(
      driver.sendMessage("5511999999999", {
        to: "5511999999999",
        type: "text",
        text: "Hello",
      }),
    ).rejects.toThrow("Cannot send message: Baileys driver is not connected");
  });

  it("handles DisconnectReason.loggedOut as UNPAIRED", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-logout-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
        config: UserFacingSocketConfig,
      ) => WASocket,
    });

    try {
      await driver.connect();
      ev.emit("connection.update", { connection: "open" });

      // Emit logout close event (statusCode 401)
      const error = Object.assign(new Error("Connection logged out"), {
        output: { statusCode: 401 },
      });
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error },
      });

      expect(driver.getStatus().state).toBe("UNPAIRED");
      expect(driver.getStatus().connected).toBe(false);
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("returns normalized self JID stripping device suffixes", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-self-"));
    const authDir = join(tempParent, "creds");
    const { sock } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
        config: UserFacingSocketConfig,
      ) => WASocket,
    });

    try {
      expect(driver.getSelfJid()).toBeUndefined();
      await driver.connect();
      expect(driver.getSelfJid()).toBe("bot-user@s.whatsapp.net");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("dispatches presence update through socket", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-presence-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev, sendPresenceUpdateMock } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
        config: UserFacingSocketConfig,
      ) => WASocket,
    });

    try {
      await driver.connect();
      ev.emit("connection.update", { connection: "open" });

      await driver.sendPresence("5511999998888@s.whatsapp.net", "composing");
      expect(sendPresenceUpdateMock).toHaveBeenCalledWith(
        "composing",
        "5511999998888@s.whatsapp.net",
      );
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});
