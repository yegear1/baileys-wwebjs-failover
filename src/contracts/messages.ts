import { z } from "zod";

export const MessageTypeSchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "unknown",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MediaAttachmentSchema = z.object({
  mimeType: z.string().min(1),
  filename: z.string().optional(),
  digest: z.string().optional(),
  url: z.string().url().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
});
export type MediaAttachment = z.infer<typeof MediaAttachmentSchema>;

export const InboundMessageSchema = z.object({
  id: z.string().min(1),
  remoteJid: z.string().min(1),
  senderJid: z.string().min(1),
  fromMe: z.boolean(),
  timestamp: z.number().int().nonnegative(),
  type: MessageTypeSchema,
  textBody: z.string().optional(),
  media: MediaAttachmentSchema.optional(),
  dedupHash: z.string().min(1),
  raw: z.record(z.unknown()).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const OutboundMessageSchema = z.object({
  to: z.string().min(1),
  type: z.enum(["text", "image", "video", "audio", "document"]),
  text: z.string().optional(),
  media: MediaAttachmentSchema.optional(),
  quotedMessageId: z.string().optional(),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const ReceiptStatusSchema = z.enum(["PENDING", "SENT", "DELIVERED", "READ", "FAILED"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const MessageReceiptSchema = z.object({
  id: z.string().min(1),
  to: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  status: ReceiptStatusSchema,
  error: z.string().optional(),
});
export type MessageReceipt = z.infer<typeof MessageReceiptSchema>;
