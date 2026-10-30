import { z } from "zod";

function parseBooleanEnv(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultValue;
      if (typeof val === "boolean") return val;
      const normalized = val.trim().toLowerCase();
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      return Boolean(val);
    });
}

export const GatewayConfigSchema = z
  .object({
    nodeEnv: z.string().default("production"),
    port: z.coerce.number().int().min(0).max(65535).default(3000),
    host: z.string().default("0.0.0.0"),
    redisUrl: z.string().min(1).default("redis://127.0.0.1:6379"),
    authDirBaileys: z.string().min(1).default("/data/auth/baileys"),
    authDirWWebJS: z.string().min(1).default("/data/auth/wwebjs"),
    puppeteerExecutablePath: z.string().min(1).default("/usr/bin/chromium"),
    failoverErrorThreshold: z.coerce.number().int().min(1).default(3),
    probeStabilityWindowSec: z.coerce.number().int().min(1).default(300),
    probeIntervalMs: z.coerce.number().int().min(500).default(10000),
    keepaliveIntervalDaysMin: z.coerce.number().int().min(1).default(3),
    keepaliveIntervalDaysMax: z.coerce.number().int().min(1).default(5),
    selfChatJid: z.string().optional(),
    inboxQueueKey: z.string().min(1).default("whatsapp:receive:inbox"),
    outboundQueueKey: z.string().min(1).default("whatsapp:send:priority"),
    lowPriorityOutboundQueueKey: z.string().min(1).default("whatsapp:send:low"),
    dlqQueueKey: z.string().min(1).default("whatsapp:send:dlq"),
    fencingLockKey: z.string().min(1).default("gateway:active_engine"),
    blpopTimeoutSeconds: z.coerce.number().min(0.01).default(2),
    sendMessageTimeoutMs: z.coerce.number().int().min(1000).default(15000),
    maxSendRetries: z.coerce.number().int().min(1).default(3),
    urgentDelayMinMs: z.coerce.number().int().min(0).default(300),
    urgentDelayMaxMs: z.coerce.number().int().min(0).default(800),
    normalDelayMinMs: z.coerce.number().int().min(0).default(1500),
    normalDelayMaxMs: z.coerce.number().int().min(0).default(3500),
    lowDelayMinMs: z.coerce.number().int().min(0).default(10000),
    lowDelayMaxMs: z.coerce.number().int().min(0).default(20000),
    enableTypingPresence: parseBooleanEnv(true),
    enableHostConnectivityGuard: parseBooleanEnv(true),
    shutdownTimeoutMs: z.coerce.number().int().min(1000).default(10000),
  })
  .refine((data) => data.keepaliveIntervalDaysMin <= data.keepaliveIntervalDaysMax, {
    message: "keepaliveIntervalDaysMin must not exceed keepaliveIntervalDaysMax",
    path: ["keepaliveIntervalDaysMin"],
  })
  .refine((data) => data.urgentDelayMinMs <= data.urgentDelayMaxMs, {
    message: "urgentDelayMinMs must not exceed urgentDelayMaxMs",
    path: ["urgentDelayMinMs"],
  })
  .refine((data) => data.normalDelayMinMs <= data.normalDelayMaxMs, {
    message: "normalDelayMinMs must not exceed normalDelayMaxMs",
    path: ["normalDelayMinMs"],
  })
  .refine((data) => data.lowDelayMinMs <= data.lowDelayMaxMs, {
    message: "lowDelayMinMs must not exceed lowDelayMaxMs",
    path: ["lowDelayMinMs"],
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Parses and validates gateway configuration from process.env or an override dictionary.
 */
export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  return GatewayConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    redisUrl: env.REDIS_URL,
    authDirBaileys: env.AUTH_DIR_BAILEYS,
    authDirWWebJS: env.AUTH_DIR_WWEBJS,
    puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
    failoverErrorThreshold: env.FAILOVER_ERROR_THRESHOLD,
    probeStabilityWindowSec: env.PROBE_STABILITY_WINDOW_SEC,
    probeIntervalMs: env.PROBE_INTERVAL_MS,
    keepaliveIntervalDaysMin: env.KEEPALIVE_INTERVAL_DAYS_MIN,
    keepaliveIntervalDaysMax: env.KEEPALIVE_INTERVAL_DAYS_MAX,
    selfChatJid: env.SELF_CHAT_JID,
    inboxQueueKey: env.INBOX_QUEUE_KEY,
    outboundQueueKey: env.OUTBOUND_QUEUE_KEY,
    lowPriorityOutboundQueueKey: env.LOW_PRIORITY_OUTBOUND_QUEUE_KEY,
    dlqQueueKey: env.DLQ_QUEUE_KEY,
    fencingLockKey: env.FENCING_LOCK_KEY,
    blpopTimeoutSeconds: env.BLPOP_TIMEOUT_SECONDS,
    sendMessageTimeoutMs: env.SEND_MESSAGE_TIMEOUT_MS,
    maxSendRetries: env.MAX_SEND_RETRIES,
    urgentDelayMinMs: env.URGENT_DELAY_MIN_MS,
    urgentDelayMaxMs: env.URGENT_DELAY_MAX_MS,
    normalDelayMinMs: env.NORMAL_DELAY_MIN_MS,
    normalDelayMaxMs: env.NORMAL_DELAY_MAX_MS,
    lowDelayMinMs: env.LOW_DELAY_MIN_MS,
    lowDelayMaxMs: env.LOW_DELAY_MAX_MS,
    enableTypingPresence: env.ENABLE_TYPING_PRESENCE,
    enableHostConnectivityGuard: env.ENABLE_HOST_CONNECTIVITY_GUARD,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  });
}
