import { z } from "zod";
import {
  type InboundMessage,
  InboundMessageSchema,
  MediaAttachmentSchema,
  type OutboundMessage,
  OutboundMessageSchema,
} from "../contracts/messages.js";

export const DEFAULT_INBOX_QUEUE = "whatsapp:receive:inbox";
export const DEFAULT_OUTBOUND_QUEUE = "whatsapp:send:priority";
export const DEFAULT_NOTIFICATIONS_QUEUE = "whatsapp:send:notifications";
export const DEFAULT_LOW_PRIORITY_OUTBOUND_QUEUE = "whatsapp:send:low";
export const DEFAULT_REACT_QUEUE = "whatsapp:react";
export const DEFAULT_DLQ_QUEUE = "whatsapp:send:dlq";
export const DEFAULT_DEDUP_PREFIX = "dedupe:msg:";
export const DEFAULT_FENCING_KEY = "gateway:active_engine";
export const DEFAULT_DEDUP_TTL_SECONDS = 300;
export const DEFAULT_BLPOP_TIMEOUT_SECONDS = 2;
export const DEFAULT_MAX_SEND_RETRIES = 3;
export const DEFAULT_SEND_MESSAGE_TIMEOUT_MS = 15000;
export const DEFAULT_URGENT_DELAY_MIN_MS = 300;
export const DEFAULT_URGENT_DELAY_MAX_MS = 800;
export const DEFAULT_NORMAL_DELAY_MIN_MS = 1500;
export const DEFAULT_NORMAL_DELAY_MAX_MS = 3500;
export const DEFAULT_LOW_DELAY_MIN_MS = 10000;
export const DEFAULT_LOW_DELAY_MAX_MS = 20000;

export const OutboundPrioritySchema = z.enum(["urgent", "normal", "low"]);
export type OutboundPriority = z.infer<typeof OutboundPrioritySchema>;

export interface PriorityJitterBounds {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface OutboundDelayConfig {
  readonly urgent: PriorityJitterBounds;
  readonly normal: PriorityJitterBounds;
  readonly low: PriorityJitterBounds;
}

/**
 * Minimal structural interface for Redis clients, matching @redis/client (redis v4)
 * and enabling hermetic mocking in tests without heavy network overhead.
 */
export interface IRedisClient {
  isOpen?: boolean | undefined;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  quit?(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mGet?(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  lPush(key: string, elements: string | string[]): Promise<number>;
  rPush?(key: string, elements: string | string[]): Promise<number>;
  rPop?(key: string): Promise<string | null>;
  lLen?(key: string): Promise<number>;
  ttl?(key: string): Promise<number>;
  keys?(pattern: string): Promise<string[]>;
  blPop(
    keys: string | string[],
    timeoutSeconds: number,
  ): Promise<{ key: string; element: string } | null>;
  eval?(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  duplicate?(): IRedisClient;
}

/**
 * Canonical whatsapp-api outbound payload schema with comprehensive aliases.
 */
export const CanonicalSendPayloadSchema = z.object({
  phone_number: z.string().optional(),
  number: z.string().optional(),
  to: z.string().optional(),

  content: z.string().optional(),
  message: z.string().optional(),
  text: z.string().optional(),

  quote_id: z.string().nullable().optional(),
  quotedMessageId: z.string().nullable().optional(),
  reply_to_id: z.string().nullable().optional(),

  is_sticker: z.boolean().optional(),
  isSticker: z.boolean().optional(),
  asSticker: z.boolean().optional(),

  media_base64: z.string().nullable().optional(),
  mediaBase64: z.string().nullable().optional(),
  mediaData: z.string().nullable().optional(),

  media_mimetype: z.string().nullable().optional(),
  mediaMimetype: z.string().nullable().optional(),
  mimetype: z.string().nullable().optional(),

  media_url: z.string().nullable().optional(),
  mediaUrl: z.string().nullable().optional(),

  send_as_document: z.boolean().optional(),
  sendAsDocument: z.boolean().optional(),

  sticker_name: z.string().nullable().optional(),
  stickerName: z.string().nullable().optional(),
  pack_name: z.string().nullable().optional(),
  packName: z.string().nullable().optional(),

  sticker_author: z.string().nullable().optional(),
  stickerAuthor: z.string().nullable().optional(),
  author: z.string().nullable().optional(),

  sticker_fast: z.boolean().optional(),
  stickerFast: z.boolean().optional(),
  fast: z.boolean().optional(),

  sticker_profile: z.enum(["balanced", "quality", "smooth"]).optional(),
  stickerProfile: z.enum(["balanced", "quality", "smooth"]).optional(),
  profile: z.enum(["balanced", "quality", "smooth"]).optional(),

  sticker_square: z.boolean().optional(),
  stickerSquare: z.boolean().optional(),

  sticker_pad: z.boolean().optional(),
  stickerPad: z.boolean().optional(),

  sticker_text: z.string().nullable().optional(),
  stickerText: z.string().nullable().optional(),

  mentions: z.array(z.string()).nullable().optional(),
  mentioned_ids: z.array(z.string()).nullable().optional(),
  mentionedIds: z.array(z.string()).nullable().optional(),

  uuid: z.string().nullable().optional(),
  source: z.string().optional(),

  priority: OutboundPrioritySchema.optional(),
  retryCount: z.coerce.number().int().min(0).optional(),
  lastError: z.string().optional(),
  requeuedAt: z.string().optional(),
});
export type CanonicalSendPayload = z.infer<typeof CanonicalSendPayloadSchema>;

/**
 * Standard Reaction Payload schema for whatsapp:react consumer.
 */
export const ReactPayloadSchema = z
  .object({
    message_id: z.string().optional(),
    messageId: z.string().optional(),
    id: z.string().optional(),
    reaction: z.string().optional(),
    emoji: z.string().optional(),
    uuid: z.string().nullish(),
    remote_jid: z.string().optional(),
    remoteJid: z.string().optional(),
    to: z.string().optional(),
  })
  .transform((data, ctx) => {
    const messageId = data.message_id ?? data.messageId ?? data.id;
    const reaction = data.reaction ?? data.emoji;
    const remoteJid = data.remote_jid ?? data.remoteJid ?? data.to;

    if (!messageId || messageId.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message ID is required for reaction",
        path: ["message_id"],
      });
      return z.NEVER;
    }

    if (reaction === undefined || reaction === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reaction emoji is required",
        path: ["reaction"],
      });
      return z.NEVER;
    }

    return {
      messageId: messageId.trim(),
      reaction,
      remoteJid: remoteJid?.trim() || undefined,
      uuid: data.uuid ?? null,
    };
  });
export type ReactPayload = z.infer<typeof ReactPayloadSchema>;

export interface StandardReactPayload {
  readonly message_id: string;
  readonly reaction: string;
  readonly remote_jid?: string | null;
  readonly uuid?: string | null;
}

/**
 * Native OutboundMessage queue payload schema.
 */
export const NativeSendPayloadSchema = OutboundMessageSchema.extend({
  id: z.string().optional(),
  quotedMessageId: z.string().nullable().optional(),
  priority: OutboundPrioritySchema.optional(),
  retryCount: z.coerce.number().int().min(0).optional(),
  lastError: z.string().optional(),
  requeuedAt: z.string().optional(),
});
export type NativeSendPayload = z.infer<typeof NativeSendPayloadSchema>;

/**
 * Discriminated/flexible outbound queue payload accepting both canonical and native schemas.
 */
export const OutboundQueuePayloadSchema = z.union([
  CanonicalSendPayloadSchema.extend({
    id: z.string().optional(),
    media: MediaAttachmentSchema.optional(),
  }),
  NativeSendPayloadSchema,
]);
export type OutboundQueuePayload = z.infer<typeof OutboundQueuePayloadSchema>;

/**
 * Normalized outbound dispatch request.
 */
export interface NormalizedOutboundRequest {
  readonly id?: string | undefined;
  readonly to: string;
  readonly content: OutboundMessage;
  readonly priority?: OutboundPriority | undefined;
  readonly retryCount?: number | undefined;
}

/**
 * Inbound queue payload alias conforming to InboundMessage.
 */
export const InboundQueuePayloadSchema = InboundMessageSchema;
export type InboundQueuePayload = InboundMessage;

/**
 * Configuration options for Redis Queue Manager.
 */
export interface RedisQueueOptions {
  readonly client: IRedisClient;
  readonly blockingClient?: IRedisClient | undefined;
  readonly reactClient?: IRedisClient | undefined;
  readonly inboxQueueKey?: string | undefined;
  readonly outboundQueueKey?: string | undefined;
  readonly notificationsQueueKey?: string | undefined;
  readonly lowPriorityOutboundQueueKey?: string | undefined;
  readonly reactQueueKey?: string | undefined;
  readonly dlqQueueKey?: string | undefined;
  readonly maxSendRetries?: number | undefined;
  readonly dedupPrefix?: string | undefined;
  readonly dedupTtlSeconds?: number | undefined;
  readonly blpopTimeoutSeconds?: number | undefined;
  readonly pauseCheckIntervalMs?: number | undefined;
  readonly delayConfig?: Partial<OutboundDelayConfig> | undefined;
  readonly enableTypingPresence?: boolean | undefined;
}

/**
 * React worker operational status metrics.
 */
export interface ReactWorkerMetrics {
  readonly isRunning: boolean;
  readonly isPaused: boolean;
  readonly processedCount: number;
  readonly errorCount: number;
  readonly lastProcessedAt?: Date | undefined;
  readonly lastError?: string | undefined;
}

/**
 * Outbound worker operational status metrics.
 */
export interface OutboundWorkerMetrics {
  readonly isRunning: boolean;
  readonly isPaused: boolean;
  readonly processedCount: number;
  readonly errorCount: number;
  readonly requeuedCount: number;
  readonly dlqCount: number;
  readonly lastProcessedAt?: Date | undefined;
  readonly lastError?: string | undefined;
}

/**
 * Inbound publisher operational status metrics.
 */
export interface InboundPublisherMetrics {
  readonly publishedCount: number;
  readonly duplicateCount: number;
  readonly lastPublishedAt?: Date | undefined;
  readonly lastDuplicateAt?: Date | undefined;
}
