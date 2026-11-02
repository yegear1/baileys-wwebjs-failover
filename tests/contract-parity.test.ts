import { describe, expect, it, vi } from "vitest";
import type { IWhatsAppDriver } from "../src/contracts/driver.js";
import type { OutboundMessage } from "../src/contracts/messages.js";
import { mapOutboundToBaileysContent } from "../src/drivers/baileys-mapper.js";
import { mapOutboundToWWebJSContent } from "../src/drivers/wwebjs-mapper.js";
import { FailoverOrchestrator } from "../src/fsm/orchestrator.js";
import { normalizeOutboundPayload } from "../src/queues/outbound-worker.js";
import { RedisReactWorker } from "../src/queues/react-worker.js";
import type { IRedisClient } from "../src/queues/types.js";

describe("Outbound Contract Parity (Brain & Gateway Compatibility)", () => {
  it("normalizes canonical text payload from gatekeeper/logic-worker", () => {
    const raw = {
      phone_number: "5511999998888@c.us",
      content: "Hello world!",
      quote_id: "quote_123",
      uuid: "uuid-v4-abc",
      source: "logic-worker-py",
    };

    const normalized = normalizeOutboundPayload(raw);
    expect(normalized.to).toBe("5511999998888@c.us");
    expect(normalized.id).toBe("uuid-v4-abc");
    expect(normalized.content).toEqual({
      to: "5511999998888@c.us",
      type: "text",
      text: "Hello world!",
      media: undefined,
      quotedMessageId: "quote_123",
    });
  });

  it("normalizes canonical sticker payload with base64 and pack metadata", () => {
    const sampleBase64 = Buffer.from("fake-webp-bytes").toString("base64");
    const raw = {
      phone_number: "5511999998888@c.us",
      is_sticker: true,
      media_base64: sampleBase64,
      media_mimetype: "image/webp",
      sticker_name: "My Pack",
      sticker_author: "My Author",
      quote_id: "parent_msg_1",
    };

    const normalized = normalizeOutboundPayload(raw);
    expect(normalized.to).toBe("5511999998888@c.us");
    expect(normalized.content.type).toBe("sticker");
    expect(normalized.content.stickerName).toBe("My Pack");
    expect(normalized.content.stickerAuthor).toBe("My Author");
    expect(normalized.content.quotedMessageId).toBe("parent_msg_1");
    expect(normalized.content.media?.data).toBe(sampleBase64);
    expect(normalized.content.media?.mimeType).toBe("image/webp");
  });

  it("normalizes canonical media url payload with mentions and document flag", () => {
    const raw = {
      phone_number: "5511999998888@c.us",
      content: "Document caption",
      media_url: "https://example.com/file.pdf",
      send_as_document: true,
      mentions: ["5511999997777@s.whatsapp.net"],
    };

    const normalized = normalizeOutboundPayload(raw);
    expect(normalized.content.type).toBe("document");
    expect(normalized.content.sendAsDocument).toBe(true);
    expect(normalized.content.mentions).toEqual(["5511999997777@s.whatsapp.net"]);
    expect(normalized.content.media?.url).toBe("https://example.com/file.pdf");
    expect(normalized.content.media?.caption).toBe("Document caption");
  });

  it("normalizes canonical payload with alternative field aliases (number, message, asSticker)", () => {
    const raw = {
      number: "5511988887777@c.us",
      message: "Alias content",
      reply_to_id: "reply_99",
      asSticker: true,
      mediaData: "base64data",
      mimetype: "image/webp",
      packName: "PackAlias",
      author: "AuthorAlias",
      mentionedIds: ["5511000001111@s.whatsapp.net"],
    };

    const normalized = normalizeOutboundPayload(raw);
    expect(normalized.to).toBe("5511988887777@c.us");
    expect(normalized.content.type).toBe("sticker");
    expect(normalized.content.text).toBe("Alias content");
    expect(normalized.content.quotedMessageId).toBe("reply_99");
    expect(normalized.content.stickerName).toBe("PackAlias");
    expect(normalized.content.stickerAuthor).toBe("AuthorAlias");
    expect(normalized.content.mentions).toEqual(["5511000001111@s.whatsapp.net"]);
  });
});

describe("Outbound Mappers Parity", () => {
  it("maps sticker message with Buffer to Baileys content", () => {
    const testBuffer = Buffer.from("webp-binary-data");
    const outbound: OutboundMessage = {
      to: "5511999998888@s.whatsapp.net",
      type: "sticker",
      media: {
        mimeType: "image/webp",
        data: testBuffer,
      },
    };

    const mapped = mapOutboundToBaileysContent(outbound);
    expect(mapped).toHaveProperty("sticker");
    expect((mapped as { sticker: Buffer }).sticker).toEqual(testBuffer);
    expect((mapped as { mimetype?: string }).mimetype).toBe("image/webp");
  });

  it("maps sticker message with base64 string to Baileys content", () => {
    const rawBase64 = Buffer.from("base64-data").toString("base64");
    const outbound: OutboundMessage = {
      to: "5511999998888@s.whatsapp.net",
      type: "sticker",
      media: {
        mimeType: "image/webp",
        data: `data:image/webp;base64,${rawBase64}`,
      },
    };

    const mapped = mapOutboundToBaileysContent(outbound);
    expect(mapped).toHaveProperty("sticker");
    expect(Buffer.isBuffer((mapped as { sticker: Buffer }).sticker)).toBe(true);
  });

  it("maps text with mentions to Baileys content", () => {
    const outbound: OutboundMessage = {
      to: "5511999998888@s.whatsapp.net",
      type: "text",
      text: "Hello @user",
      mentions: ["5511999997777@s.whatsapp.net"],
    };

    const mapped = mapOutboundToBaileysContent(outbound);
    expect(mapped).toEqual({
      text: "Hello @user",
      mentions: ["5511999997777@s.whatsapp.net"],
    });
  });

  it("maps sticker message with base64 to WWebJS content", async () => {
    const rawBase64 = Buffer.from("webp-data").toString("base64");
    const outbound: OutboundMessage = {
      to: "5511999998888@c.us",
      type: "sticker",
      stickerName: "CoolSticker",
      stickerAuthor: "Artist",
      media: {
        mimeType: "image/webp",
        data: rawBase64,
      },
    };

    const mapped = await mapOutboundToWWebJSContent(outbound);
    expect(mapped.options?.sendMediaAsSticker).toBe(true);
    expect(mapped.options?.stickerName).toBe("CoolSticker");
    expect(mapped.options?.stickerAuthor).toBe("Artist");
    expect(mapped.content).toBeDefined();
  });
});

describe("Redis React Consumer & Driver Reaction Parity", () => {
  it("consumes from whatsapp:react and dispatches via orchestrator.sendReaction", async () => {
    const mockDriver: IWhatsAppDriver = {
      name: "baileys",
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      getStatus: vi
        .fn()
        .mockReturnValue({ engine: "baileys", state: "CONNECTED", connected: true }),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
    };

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: mockDriver,
      standbyDriver: mockDriver,
      disableBackgroundProbeTimer: true,
      enableHostConnectivityGuard: false,
    });
    await orchestrator.start();

    const mockRedisClient: IRedisClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      lPush: vi.fn().mockResolvedValue(1),
      blPop: vi
        .fn()
        .mockResolvedValueOnce({
          key: "whatsapp:react",
          element: JSON.stringify({
            message_id: "false_5511999998888@c.us_3EB0ABC",
            reaction: "🚀",
          }),
        })
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return null;
        }),
    };

    const reactWorker = new RedisReactWorker({
      client: mockRedisClient,
      orchestrator,
      reactQueueKey: "whatsapp:react",
      blpopTimeoutSeconds: 0.05,
    });

    reactWorker.start();
    // Allow transient async processing
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reactWorker.stop();

    expect(mockDriver.sendReaction).toHaveBeenCalledWith(
      "false_5511999998888@c.us_3EB0ABC",
      "🚀",
      undefined,
    );
    const metrics = reactWorker.getMetrics();
    expect(metrics.processedCount).toBe(1);
    expect(metrics.errorCount).toBe(0);

    await orchestrator.shutdown();
  });

  it("handles alternative reaction aliases (id, emoji, remote_jid)", async () => {
    const sendReactionSpy = vi.fn().mockResolvedValue(undefined);
    const mockDriver: IWhatsAppDriver = {
      name: "baileys",
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      sendReaction: sendReactionSpy,
      getStatus: vi
        .fn()
        .mockReturnValue({ engine: "baileys", state: "CONNECTED", connected: true }),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
    };

    const orchestrator = new FailoverOrchestrator({
      primaryDriver: mockDriver,
      standbyDriver: mockDriver,
      disableBackgroundProbeTimer: true,
      enableHostConnectivityGuard: false,
    });
    await orchestrator.start();

    const mockRedisClient: IRedisClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      lPush: vi.fn().mockResolvedValue(1),
      blPop: vi
        .fn()
        .mockResolvedValueOnce({
          key: "whatsapp:react",
          element: JSON.stringify({
            id: "msg_999",
            emoji: "🔥",
            remote_jid: "5511988887777@s.whatsapp.net",
          }),
        })
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return null;
        }),
    };

    const reactWorker = new RedisReactWorker({
      client: mockRedisClient,
      orchestrator,
      reactQueueKey: "whatsapp:react",
      blpopTimeoutSeconds: 0.05,
    });

    reactWorker.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reactWorker.stop();

    expect(sendReactionSpy).toHaveBeenCalledWith("msg_999", "🔥", "5511988887777@s.whatsapp.net");
    await orchestrator.shutdown();
  });
});
