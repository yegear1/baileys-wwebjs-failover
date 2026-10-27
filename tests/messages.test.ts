import { describe, expect, it } from "vitest";
import {
  InboundMessageSchema,
  MessageReceiptSchema,
  OutboundMessageSchema,
} from "../src/contracts/messages.js";

describe("Message Contracts & Schemas", () => {
  it("validates a standard inbound text message", () => {
    const raw = {
      id: "3EB0ABC1234567890",
      remoteJid: "5511999999999@s.whatsapp.net",
      senderJid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      timestamp: 1700000000,
      type: "text",
      textBody: "Hello from WhatsApp",
      dedupHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };

    const parsed = InboundMessageSchema.parse(raw);
    expect(parsed.id).toBe(raw.id);
    expect(parsed.type).toBe("text");
    expect(parsed.textBody).toBe("Hello from WhatsApp");
  });

  it("validates an inbound media message with attachment metadata", () => {
    const raw = {
      id: "3EB0MEDIA123",
      remoteJid: "12036302482394@g.us",
      senderJid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      timestamp: 1700000050,
      type: "image",
      dedupHash: "a".repeat(64),
      media: {
        mimeType: "image/jpeg",
        filename: "photo.jpg",
        digest: "file-sha256-hash",
        url: "https://example.com/media/photo.jpg",
        sizeBytes: 1048576,
        caption: "Check this out",
      },
    };

    const parsed = InboundMessageSchema.parse(raw);
    expect(parsed.type).toBe("image");
    expect(parsed.media?.mimeType).toBe("image/jpeg");
    expect(parsed.media?.sizeBytes).toBe(1048576);
  });

  it("rejects an inbound message with invalid fields", () => {
    expect(() =>
      InboundMessageSchema.parse({
        id: "",
        remoteJid: "5511999999999@s.whatsapp.net",
        senderJid: "5511888888888@s.whatsapp.net",
        fromMe: false,
        timestamp: -1,
        type: "non-existent-type",
        dedupHash: "",
      }),
    ).toThrow();
  });

  it("validates an outbound message payload", () => {
    const outbound = {
      to: "5511999999999@s.whatsapp.net",
      type: "text",
      text: "Outbound failover notification",
      quotedMessageId: "3EB0ABC1234567890",
    };

    const parsed = OutboundMessageSchema.parse(outbound);
    expect(parsed.to).toBe(outbound.to);
    expect(parsed.text).toBe(outbound.text);
    expect(parsed.quotedMessageId).toBe(outbound.quotedMessageId);
  });

  it("validates message receipt lifecycles", () => {
    const receipt = {
      id: "3EB0ABC1234567890",
      to: "5511999999999@s.whatsapp.net",
      timestamp: 1700000010,
      status: "DELIVERED",
    };

    const parsed = MessageReceiptSchema.parse(receipt);
    expect(parsed.status).toBe("DELIVERED");
    expect(parsed.id).toBe(receipt.id);
  });

  it("rejects invalid receipt statuses", () => {
    expect(() =>
      MessageReceiptSchema.parse({
        id: "msg-1",
        to: "5511999999999@s.whatsapp.net",
        timestamp: 1700000010,
        status: "UNKNOWN_STATUS",
      }),
    ).toThrow();
  });
});
