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
export const DEFAULT_LOW_PRIORITY_OUTBOUND_QUEUE = "whatsapp:send:low";
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
 * Canonical whatsapp-api outbound payload schema.
 */
export const CanonicalSendPayloadSchema = z.object({
  phone_number: z.string().min(1),
  content: z.string(),
  quote_id: z.string().nullable().optional(),
  priority: OutboundPrioritySchema.optional(),
  retryCount: z.coerce.number().int().min(0).optional(),
  lastError: z.string().optional(),
  requeuedAt: z.string().optional(),
});
export type CanonicalSendPayload = z.infer<typeof CanonicalSendPayloadSchema>;

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
  readonly inboxQueueKey?: string | undefined;
  readonly outboundQueueKey?: string | undefined;
  readonly lowPriorityOutboundQueueKey?: string | undefined;
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
