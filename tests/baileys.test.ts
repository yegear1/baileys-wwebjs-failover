import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  BaileysSendTimeoutError,
  BoundedRetryCounterCache,
  ensureSecureAuthDirectory,
  mapBaileysMessageToInbound,
  mapOutboundToBaileysContent,
  purgeAuthDirectory,
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

describe("ensureSecureAuthDirectory & purgeAuthDirectory", () => {
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

  it("purges stale files and subdirectories while preserving mount root and 0700 permissions", () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-purge-test-"));
    const authPath = join(tempParent, "baileys-mount");

    try {
      ensureSecureAuthDirectory(authPath);
      const rootInodeBefore = statSync(authPath).ino;

      writeFileSync(join(authPath, "creds.json"), '{"noiseKey":"stale"}');
      writeFileSync(join(authPath, "app-state-sync-key-1.json"), "{}");
      mkdirSync(join(authPath, "nested-session"), { recursive: true });
      writeFileSync(join(authPath, "nested-session", "pre-key-1.json"), "{}");

      expect(readdirSync(authPath).length).toBe(3);

      purgeAuthDirectory(authPath);

      const statsAfter = statSync(authPath);
      expect(statsAfter.isDirectory()).toBe(true);
      expect(statsAfter.ino).toBe(rootInodeBefore);
      expect(readdirSync(authPath)).toEqual([]);
      if (process.platform !== "win32") {
        expect(statsAfter.mode & 0o777).toBe(0o700);
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

  it("aborts with BaileysSendTimeoutError when socket sendMessage hangs beyond timeout", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-send-timeout-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    // Socket sendMessage hangs indefinitely
    sock.sendMessage = vi.fn().mockImplementation(() => new Promise(() => {}));

    const driver = new BaileysDriver({
      authDir,
      sendMessageTimeoutMs: 50,
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

      await expect(
        driver.sendMessage("5511999999999", {
          to: "5511999999999",
          type: "text",
          text: "Will hang",
        }),
      ).rejects.toThrow(BaileysSendTimeoutError);
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

  it("handles DisconnectReason.loggedOut by purging stale credentials and regenerating a fresh QR session", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-logout-"));
    const authDir = join(tempParent, "creds");
    const socket1 = createMockSocket();
    const socket2 = createMockSocket();

    let callIndex = 0;
    const socketFactory = vi.fn().mockImplementation(() => {
      callIndex += 1;
      return callIndex === 1 ? socket1.sock : socket2.sock;
    });

    const driver = new BaileysDriver({
      authDir,
      reconnectInitialDelayMs: 15,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: socketFactory as unknown as (config: UserFacingSocketConfig) => WASocket,
    });

    try {
      await driver.connect();
      writeFileSync(join(authDir, "creds.json"), '{"stale":true}');
      writeFileSync(join(authDir, "session-1.json"), '{"ratchet":true}');
      expect(readdirSync(authDir).length).toBe(2);

      socket1.ev.emit("connection.update", { connection: "open" });

      // Emit logout close event (statusCode 401)
      const error = Object.assign(new Error("Connection logged out"), {
        output: { statusCode: 401 },
      });
      socket1.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error },
      });

      // Immediately purges stale credentials and enters UNPAIRED
      expect(driver.getStatus().state).toBe("UNPAIRED");
      expect(driver.getStatus().connected).toBe(false);
      expect(readdirSync(authDir)).toEqual([]);

      // Automatically re-initializes connect() to generate a fresh QR code
      await vi.waitFor(() => {
        expect(socketFactory).toHaveBeenCalledTimes(2);
      });

      socket2.ev.emit("connection.update", { qr: "fresh-regenerated-qr-token" });
      expect(driver.getStatus().state).toBe("PAIRING_QR_READY");
      expect(driver.getQrCode()).toBe("fresh-regenerated-qr-token");
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

  it("schedules auto-reconnect on transient network drop and resets attempts upon open", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-reconnect-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    let connectCount = 0;
    const socketFactoryMock = vi.fn().mockImplementation(() => {
      connectCount += 1;
      return sock;
    });

    const driver = new BaileysDriver({
      authDir,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 50,
      reconnectMaxAttempts: 3,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: socketFactoryMock as unknown as (config: UserFacingSocketConfig) => WASocket,
    });

    try {
      await driver.connect();
      expect(connectCount).toBe(1);
      ev.emit("connection.update", { connection: "open" });
      expect(driver.getStatus().state).toBe("CONNECTED");

      // Transient disconnect with DisconnectReason.connectionLost (408)
      const transientErr = Object.assign(new Error("Connection lost"), {
        output: { statusCode: 408 },
      });
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: transientErr },
      });

      expect(driver.getStatus().state).toBe("DISCONNECTED");

      // Await automatic reconnect
      await vi.waitFor(() => {
        expect(connectCount).toBe(2);
      });

      // Confirm state resets on reconnect open
      ev.emit("connection.update", { connection: "open" });
      expect(driver.getStatus().state).toBe("CONNECTED");
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("cancels pending reconnect timer upon explicit disconnect()", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-cancel-reconnect-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    let connectCount = 0;
    const driver = new BaileysDriver({
      authDir,
      reconnectInitialDelayMs: 50,
      reconnectMaxAttempts: 3,
      authStateLoader: vi.fn().mockResolvedValue({
        state: {} as AuthenticationState,
        saveCreds: vi.fn(),
      }),
      socketFactory: vi.fn().mockImplementation(() => {
        connectCount += 1;
        return sock;
      }) as unknown as (config: UserFacingSocketConfig) => WASocket,
    });

    try {
      await driver.connect();
      expect(connectCount).toBe(1);
      ev.emit("connection.update", { connection: "open" });

      // Trigger transient drop
      const dropErr = Object.assign(new Error("Restart required"), {
        output: { statusCode: 515 },
      });
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: dropErr },
      });

      // Immediately execute explicit disconnect
      await driver.disconnect();
      expect(driver.getStatus().state).toBe("DISCONNECTED");

      // Wait longer than initial delay to ensure no reconnect fired
      await new Promise((r) => setTimeout(r, 70));
      expect(connectCount).toBe(1);
    } finally {
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("transitions to ERROR when auto-reconnect attempts are exhausted", async () => {
    const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-exhausted-"));
    const authDir = join(tempParent, "creds");
    const { sock, ev } = createMockSocket();

    const driver = new BaileysDriver({
      authDir,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10,
      reconnectMaxAttempts: 2,
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

      const transientErr = Object.assign(new Error("Connection closed"), {
        output: { statusCode: 428 },
      });

      // Drop 1 -> schedules attempt 1
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: transientErr },
      });

      // Await auto-reconnect attempt 1
      await vi.waitFor(() => {
        expect(driver.getStatus().state).toBe("CONNECTING");
      });

      // Drop 2 -> attempts exhausted (reconnectMaxAttempts = 2) and transitions to ERROR
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: transientErr },
      });

      await vi.waitFor(() => {
        expect(driver.getStatus().state).toBe("ERROR");
        expect(driver.getStatus().error).toContain("Auto-reconnect failed after 2 attempts");
      });
    } finally {
      await driver.disconnect();
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  describe("BoundedRetryCounterCache", () => {
    it("tracks retry counts and locks when reaching maxRetries without deletion", () => {
      const cache = new BoundedRetryCounterCache({ maxRetries: 3 });

      expect(cache.get("msg1")).toBeUndefined();
      cache.set("msg1", 1);
      expect(cache.get("msg1")).toBe(1);

      cache.del("msg1");
      expect(cache.get("msg1")).toBeUndefined();

      // Set to maxRetries
      cache.set("msg1", 3);
      expect(cache.get("msg1")).toBe(3);

      // Attempt deletion on maxRetries (Baileys behavior) should be ignored
      cache.del("msg1");
      expect(cache.get("msg1")).toBe(3);
    });

    it("flushes and clears on flushAll()", () => {
      const cache = new BoundedRetryCounterCache();
      cache.set("k1", 2);
      cache.set("k2", 3);

      cache.flushAll();
      expect(cache.get("k1")).toBeUndefined();
      expect(cache.get("k2")).toBeUndefined();
    });
  });

  describe("Inbound Media Buffer Download & Resilience", () => {
    it("automatically downloads media buffer and populates media.data as base64", async () => {
      const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-media-"));
      const authDir = join(tempParent, "creds");
      const { sock, ev } = createMockSocket();
      const mockBuffer = Buffer.from("test image binary data");

      const mockDownloader = vi.fn().mockResolvedValue(mockBuffer);

      const driver = new BaileysDriver({
        authDir,
        mediaDownloader: mockDownloader,
        authStateLoader: vi.fn().mockResolvedValue({
          state: {} as AuthenticationState,
          saveCreds: vi.fn(),
        }),
        socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
          config: UserFacingSocketConfig,
        ) => WASocket,
      });

      const receivedMessages: unknown[] = [];
      driver.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      try {
        await driver.connect();

        const fakeImageMsg = {
          key: {
            id: "msg-media-1",
            remoteJid: "120363410090219458@g.us",
            fromMe: false,
          },
          messageTimestamp: 1700000000,
          message: {
            imageMessage: {
              mimetype: "image/jpeg",
              caption: "Test photo",
              fileLength: 50,
            },
          },
        };

        ev.emit("messages.upsert", {
          messages: [fakeImageMsg],
          type: "notify",
        });

        await vi.waitFor(() => {
          expect(receivedMessages.length).toBe(1);
        });

        const received = receivedMessages[0] as {
          id: string;
          media?: { data?: string; mimeType: string };
        };
        expect(received.id).toBe("msg-media-1");
        expect(received.media).toBeDefined();
        expect(received.media?.data).toBe(mockBuffer.toString("base64"));
        expect(mockDownloader).toHaveBeenCalledTimes(1);
      } finally {
        await driver.disconnect();
        rmSync(tempParent, { recursive: true, force: true });
      }
    });

    it("downloads media buffer from quotedMessage when replying with command !s", async () => {
      const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-quoted-"));
      const authDir = join(tempParent, "creds");
      const { sock, ev } = createMockSocket();
      const mockStickerBuffer = Buffer.from("quoted sticker binary");

      const mockDownloader = vi.fn().mockResolvedValue(mockStickerBuffer);

      const driver = new BaileysDriver({
        authDir,
        mediaDownloader: mockDownloader,
        authStateLoader: vi.fn().mockResolvedValue({
          state: {} as AuthenticationState,
          saveCreds: vi.fn(),
        }),
        socketFactory: vi.fn().mockReturnValue(sock) as unknown as (
          config: UserFacingSocketConfig,
        ) => WASocket,
      });

      const receivedMessages: unknown[] = [];
      driver.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      try {
        await driver.connect();

        const fakeQuotedMsg = {
          key: {
            id: "cmd-sticker-1",
            remoteJid: "120363410090219458@g.us",
            fromMe: false,
          },
          messageTimestamp: 1700000000,
          message: {
            extendedTextMessage: {
              text: "!s",
              contextInfo: {
                stanzaId: "target-quoted-id",
                quotedMessage: {
                  imageMessage: {
                    mimetype: "image/png",
                    fileLength: 120,
                  },
                },
              },
            },
          },
        };

        ev.emit("messages.upsert", {
          messages: [fakeQuotedMsg],
          type: "notify",
        });

        await vi.waitFor(() => {
          expect(receivedMessages.length).toBe(1);
        });

        const received = receivedMessages[0] as {
          id: string;
          textBody?: string;
          media?: { data?: string; mimeType: string };
        };
        expect(received.id).toBe("cmd-sticker-1");
        expect(received.textBody).toBe("!s");
        expect(received.media).toBeDefined();
        expect(received.media?.data).toBe(mockStickerBuffer.toString("base64"));
        expect(mockDownloader).toHaveBeenCalledTimes(1);
      } finally {
        await driver.disconnect();
        rmSync(tempParent, { recursive: true, force: true });
      }
    });

    it("resolves targetJid from bounded messageStore when sendReaction receives raw ID without remoteJid", async () => {
      const tempParent = mkdtempSync(join(tmpdir(), "auth-baileys-reaction-"));
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
        ev.emit("connection.update", { connection: "open" });

        // Simulate incoming message to populate messageStore
        const incoming = {
          key: {
            id: "AC7E4D5CA9D30649B95CF1340EB8D5DB",
            remoteJid: "120363410090219458@g.us",
            fromMe: false,
          },
          messageTimestamp: 1700000000,
          message: {
            conversation: "!dl https://example.com/video",
          },
        };

        ev.emit("messages.upsert", {
          messages: [incoming],
          type: "notify",
        });

        // sendReaction without remoteJid parameter should look up targetJid from store
        await driver.sendReaction("AC7E4D5CA9D30649B95CF1340EB8D5DB", "⏳");

        expect(sendMessageMock).toHaveBeenCalledWith("120363410090219458@g.us", {
          react: {
            text: "⏳",
            key: {
              remoteJid: "120363410090219458@g.us",
              fromMe: false,
              id: "AC7E4D5CA9D30649B95CF1340EB8D5DB",
            },
          },
        });

        // getMessage callback returns stored message
        const retrieved = await driver.getMessage({
          id: "AC7E4D5CA9D30649B95CF1340EB8D5DB",
        });
        expect(retrieved?.conversation).toBe("!dl https://example.com/video");
      } finally {
        await driver.disconnect();
        rmSync(tempParent, { recursive: true, force: true });
      }
    });
  });
});
