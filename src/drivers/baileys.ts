import { randomUUID } from "node:crypto";
import makeWASocket, {
  type AuthenticationState,
  type CacheStore,
  type ConnectionState,
  DisconnectReason,
  downloadMediaMessage,
  type proto,
  type UserFacingSocketConfig,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import type { EngineStatus, IWhatsAppDriver, PresenceState } from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";
import { logger as defaultLogger } from "../index.js";
import { ensureSecureAuthDirectory, purgeAuthDirectory } from "./auth-utils.js";
import { mapBaileysMessageToInbound, mapOutboundToBaileysContent } from "./baileys-mapper.js";

/**
 * Bounded retry counter cache for Baileys.
 *
 * INVARIANT: Baileys default cache deletes the key when retry limit is reached,
 * which resets the retry counter to zero on WhatsApp's next attempt and causes an
 * infinite retry loop. This cache locks the counter at maxRetries for the duration
 * of TTL to permanently silence repeat retry requests for un-decryptable messages.
 */
export class BoundedRetryCounterCache implements CacheStore {
  private readonly store = new Map<string, { count: number; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxRetries: number;

  constructor(options?: { ttlMs?: number; maxEntries?: number; maxRetries?: number }) {
    this.ttlMs = options?.ttlMs ?? 3600 * 1000; // 1 hour default
    this.maxEntries = options?.maxEntries ?? 2000;
    this.maxRetries = options?.maxRetries ?? 3;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.count as unknown as T;
  }

  set<T>(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    const count = typeof value === "number" ? value : 1;
    this.store.set(key, { count, expiresAt: Date.now() + this.ttlMs });
  }

  del(key: string): void {
    const entry = this.store.get(key);
    // INVARIANT: Do not delete counter if the message has already hit maxRetries,
    // preventing infinite retry receipt loops on broken sessions.
    if (entry && entry.count < this.maxRetries) {
      this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  flushAll(): void {
    this.clear();
  }
}

export interface BaileysDriverOptions {
  readonly authDir?: string;
  readonly printQR?: boolean;
  readonly logger?: Logger;
  readonly socketFactory?: (config: UserFacingSocketConfig) => WASocket;
  readonly authStateLoader?: (
    authDir: string,
  ) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  readonly sendMessageTimeoutMs?: number;
  /**
   * Whether to automatically reconnect with exponential backoff on transient socket drops.
   * Default: true.
   */
  readonly autoReconnect?: boolean;
  /**
   * Whether to automatically purge invalidated auth credentials and re-initialize a fresh
   * pairing QR session when the companion device is explicitly logged out (401).
   * Default: true.
   */
  readonly autoPurgeOnLogout?: boolean;
  /**
   * Maximum consecutive reconnect attempts before transitioning to ERROR.
   * Default: 5.
   */
  readonly reconnectMaxAttempts?: number;
  /**
   * Initial delay in milliseconds for exponential backoff.
   * Default: 1,000 ms.
   */
  readonly reconnectInitialDelayMs?: number;
  /**
   * Maximum delay cap in milliseconds for exponential backoff.
   * Default: 30,000 ms.
   */
  readonly reconnectMaxDelayMs?: number;
  /**
   * Optional custom media downloader for testing or custom media fetch pipelines.
   */
  readonly mediaDownloader?: (msg: proto.IWebMessageInfo) => Promise<Buffer | null>;
  /**
   * Maximum media download size in bytes. Default: 16 MiB.
   */
  readonly maxMediaDownloadSizeBytes?: number;
  /**
   * Maximum automatic message retry count before permanently suppressing retries. Default: 3.
   */
  readonly maxMsgRetryCount?: number;
  /**
   * Maximum number of messages kept in memory for retry resolution and reaction targeting. Default: 1000.
   */
  readonly maxStoredMessages?: number;
  /**
   * Optional custom retry counter cache.
   */
  readonly retryCounterCache?: CacheStore;
}

export class BaileysSendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Baileys sendMessage timed out after ${timeoutMs}ms`);
    this.name = "BaileysSendTimeoutError";
  }
}

interface BoomLikeError {
  readonly output?: {
    readonly statusCode?: number;
  };
  readonly message?: string;
}

/**
 * Driver adapter for WhatsApp Web socket protocol via @whiskeysockets/baileys.
 *
 * INVARIANT: Baileys is the primary socket engine. It must maintain strict state isolation,
 * adhere to IWhatsAppDriver, and enforce secure multi-device auth directory permissions.
 */
export class BaileysDriver implements IWhatsAppDriver {
  public readonly name = "baileys" as const;

  private readonly authDir: string;
  private readonly logger: Logger;
  private readonly socketFactory: (config: UserFacingSocketConfig) => WASocket;
  private readonly authStateLoader: (
    authDir: string,
  ) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  private readonly sendMessageTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly autoPurgeOnLogout: boolean;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly mediaDownloader:
    | ((msg: proto.IWebMessageInfo) => Promise<Buffer | null>)
    | undefined;
  private readonly maxMediaDownloadSizeBytes: number;
  private readonly maxMsgRetryCount: number;
  private readonly maxStoredMessages: number;
  private readonly retryCounterCache: CacheStore;
  private readonly messageStore = new Map<string, { message: proto.IMessage; remoteJid: string }>();

  private socket: WASocket | null = null;
  private qrCode: string | undefined = undefined;
  private status: EngineStatus = {
    engine: "baileys",
    state: "DISCONNECTED",
    connected: false,
  };

  private readonly messageHandlers: Set<(msg: InboundMessage) => Promise<void>> = new Set();
  private readonly statusHandlers: Set<(status: EngineStatus) => void> = new Set();

  private isIntentionalDisconnect = false;
  private reconnectTimer: NodeJS.Timeout | undefined = undefined;
  private reconnectAttempt = 0;

  constructor(options: BaileysDriverOptions = {}) {
    this.authDir = options.authDir ?? process.env.AUTH_DIR_BAILEYS ?? "/data/auth/baileys";
    this.logger = options.logger ?? defaultLogger;
    this.socketFactory = options.socketFactory ?? makeWASocket;
    this.authStateLoader = options.authStateLoader ?? useMultiFileAuthState;
    this.sendMessageTimeoutMs =
      options.sendMessageTimeoutMs ??
      (process.env.SEND_MESSAGE_TIMEOUT_MS
        ? Number.parseInt(process.env.SEND_MESSAGE_TIMEOUT_MS, 10)
        : 15000);
    this.autoReconnect = options.autoReconnect ?? true;
    this.autoPurgeOnLogout = options.autoPurgeOnLogout ?? true;
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 5;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
    this.mediaDownloader = options.mediaDownloader;
    this.maxMediaDownloadSizeBytes = options.maxMediaDownloadSizeBytes ?? 16 * 1024 * 1024;
    this.maxMsgRetryCount = options.maxMsgRetryCount ?? 3;
    this.maxStoredMessages = options.maxStoredMessages ?? 1000;
    this.retryCounterCache =
      options.retryCounterCache ??
      new BoundedRetryCounterCache({ maxRetries: this.maxMsgRetryCount });
  }

  public storeMessage(id: string, remoteJid: string, message: proto.IMessage): void {
    if (this.messageStore.size >= this.maxStoredMessages) {
      const oldestKey = this.messageStore.keys().next().value;
      if (oldestKey) {
        this.messageStore.delete(oldestKey);
      }
    }
    this.messageStore.set(id, { message, remoteJid });
  }

  public async getMessage(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined;
    return this.messageStore.get(key.id)?.message;
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  public getQrCode(): string | undefined {
    return this.qrCode;
  }

  public getSelfJid(): string | undefined {
    const rawId = this.socket?.user?.id;
    if (!rawId) return undefined;
    return rawId.replace(/:.*@/, "@");
  }

  public async sendPresence(to: string, state: PresenceState): Promise<void> {
    if (!this.socket || !this.status.connected) {
      throw new Error("Cannot send presence: Baileys driver is not connected");
    }

    const targetJid = this.normalizeJid(to);
    try {
      await this.socket.sendPresenceUpdate(state, targetJid);
    } catch (err) {
      this.logger.warn({ err, to, state }, "Failed to send presence update in Baileys");
    }
  }

  public onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.add(handler);
  }

  public onStatusChange(handler: (status: EngineStatus) => void): void {
    this.statusHandlers.add(handler);
  }

  public async connect(): Promise<void> {
    this.isIntentionalDisconnect = false;
    this.clearReconnectTimer();

    // INVARIANT: Clean up any prior socket reference before creating a new connection to prevent leaks
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // Socket may already be closed
      }
      this.socket = null;
    }

    ensureSecureAuthDirectory(this.authDir);

    const { state, saveCreds } = await this.authStateLoader(this.authDir);

    this.updateStatus({
      engine: "baileys",
      state: "CONNECTING",
      connected: false,
    });

    const sock = this.socketFactory({
      auth: state,
      printQRInTerminal: false,
      logger: this.logger.child({ engine: "baileys" }) as unknown as NonNullable<
        UserFacingSocketConfig["logger"]
      >,
      getMessage: async (key) => this.getMessage(key),
      msgRetryCounterCache: this.retryCounterCache,
      maxMsgRetryCount: this.maxMsgRetryCount,
    });

    this.socket = sock;

    sock.ev.on("creds.update", async () => {
      await saveCreds();
    });

    sock.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(update);
    });

    sock.ev.on("messages.upsert", async (upsert) => {
      await this.handleMessagesUpsert(upsert);
    });
  }

  public async disconnect(): Promise<void> {
    this.isIntentionalDisconnect = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;

    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // Socket may already be closed
      }
      this.socket = null;
    }

    this.qrCode = undefined;
    this.updateStatus({
      engine: "baileys",
      state: "DISCONNECTED",
      connected: false,
    });
  }

  public async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (!this.socket || !this.status.connected) {
      throw new Error("Cannot send message: Baileys driver is not connected");
    }

    const targetJid = this.normalizeJid(to);
    const baileysContent = mapOutboundToBaileysContent(content);

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BaileysSendTimeoutError(this.sendMessageTimeoutMs));
        }, this.sendMessageTimeoutMs);
        timer.unref?.();
      });

      const sendPromise = this.socket.sendMessage(targetJid, baileysContent);
      const sent = await Promise.race([sendPromise, timeoutPromise]);
      const messageId = sent?.key?.id ?? randomUUID();

      if (sent?.message) {
        this.storeMessage(messageId, targetJid, sent.message);
      }

      return {
        id: messageId,
        to,
        timestamp: Date.now(),
        status: "SENT",
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  public async sendReaction(
    messageId: string,
    reaction: string,
    remoteJid?: string,
  ): Promise<void> {
    if (!this.socket || !this.status.connected) {
      throw new Error("Cannot send reaction: Baileys driver is not connected");
    }

    let targetJid = remoteJid;
    let fromMe = false;
    let cleanMessageId = messageId;

    if (messageId.includes("_")) {
      const parts = messageId.split("_");
      if (parts.length >= 3) {
        fromMe = parts[0] === "true";
        if (!targetJid && parts[1]) {
          targetJid = parts[1];
        }
        if (parts[2]) {
          cleanMessageId = parts[2];
        }
      }
    }

    // INVARIANT: If targetJid was not provided or parsed from compound ID,
    // look it up in the bounded message store before throwing.
    if (!targetJid) {
      const stored = this.messageStore.get(cleanMessageId);
      if (stored) {
        targetJid = stored.remoteJid;
      }
    }

    if (!targetJid) {
      throw new Error(
        `Cannot send reaction: target JID could not be determined for message ${messageId}`,
      );
    }

    const normalizedJid = this.normalizeJid(targetJid);
    await this.socket.sendMessage(normalizedJid, {
      react: {
        text: reaction,
        key: {
          remoteJid: normalizedJid,
          fromMe,
          id: cleanMessageId,
        },
      },
    });
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    if (update.qr) {
      this.qrCode = update.qr;
      this.updateStatus({
        engine: "baileys",
        state: "PAIRING_QR_READY",
        connected: false,
      });
      return;
    }

    if (update.connection === "open") {
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      this.qrCode = undefined;
      this.updateStatus({
        engine: "baileys",
        state: "CONNECTED",
        connected: true,
        lastSeen: new Date(),
      });
      return;
    }

    if (update.connection === "connecting") {
      this.updateStatus({
        engine: "baileys",
        state: "CONNECTING",
        connected: false,
      });
      return;
    }

    if (update.connection === "close") {
      this.handleDisconnect(update.lastDisconnect?.error);
    }
  }

  private handleDisconnect(error?: unknown): void {
    this.connectedStateClean();
    const boomError = error as BoomLikeError | undefined;
    const statusCode = boomError?.output?.statusCode;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
    const errorMessage = error instanceof Error ? error.message : undefined;

    if (isLoggedOut && this.autoPurgeOnLogout) {
      this.logger.warn(
        { authDir: this.authDir, statusCode },
        "Baileys companion device logged out (401); purging invalidated auth state",
      );
      try {
        purgeAuthDirectory(this.authDir);
      } catch (purgeErr) {
        this.logger.error({ purgeErr, authDir: this.authDir }, "Failed to purge Baileys authDir");
      }
    }

    this.updateStatus({
      engine: "baileys",
      state: isLoggedOut ? "UNPAIRED" : "DISCONNECTED",
      connected: false,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });

    if (this.isIntentionalDisconnect || !this.autoReconnect) {
      return;
    }

    if (isLoggedOut) {
      if (this.autoPurgeOnLogout) {
        this.scheduleLogoutQrRegeneration();
      }
      return;
    }

    this.scheduleReconnect(statusCode, errorMessage);
  }

  private scheduleLogoutQrRegeneration(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;

    // INVARIANT: Defer QR session re-initialization so synchronous status listeners
    // (including FailoverOrchestrator) observe the UNPAIRED transition first, and explicit
    // disconnect() calls can cancel the pending re-initialization cleanly.
    this.reconnectTimer = setTimeout(async () => {
      if (this.isIntentionalDisconnect) return;
      try {
        this.logger.info(
          { authDir: this.authDir },
          "Re-initializing Baileys socket after companion logout to generate fresh pairing QR",
        );
        await this.connect();
      } catch (err) {
        this.logger.warn({ err }, "Failed to re-initialize Baileys QR session after logout");
      }
    }, this.reconnectInitialDelayMs);
    this.reconnectTimer.unref?.();
  }

  private scheduleReconnect(statusCode?: number, errorMessage?: string): void {
    this.clearReconnectTimer();

    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this.logger.warn(
        { attempts: this.reconnectAttempt, maxAttempts: this.reconnectMaxAttempts },
        "Baileys auto-reconnect attempts exhausted; transitioning to ERROR",
      );
      this.updateStatus({
        engine: "baileys",
        state: "ERROR",
        connected: false,
        error: `Auto-reconnect failed after ${this.reconnectAttempt} attempts`,
      });
      return;
    }

    const delay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;

    this.logger.info(
      {
        attempt: this.reconnectAttempt,
        maxAttempts: this.reconnectMaxAttempts,
        delayMs: delay,
        statusCode,
        reason: errorMessage,
      },
      "Scheduling transient Baileys reconnect with exponential backoff",
    );

    this.reconnectTimer = setTimeout(async () => {
      if (this.isIntentionalDisconnect) return;
      try {
        await this.connect();
      } catch (err) {
        this.logger.warn({ err }, "Baileys auto-reconnect attempt failed");
        if (!this.status.connected && !this.isIntentionalDisconnect) {
          this.scheduleReconnect(undefined, err instanceof Error ? err.message : String(err));
        }
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private connectedStateClean(): void {
    this.qrCode = undefined;
  }

  public async downloadInboundMedia(rawMessage: proto.IWebMessageInfo): Promise<Buffer | null> {
    try {
      const rawContent = rawMessage.message;
      if (!rawContent) return null;

      const messageContent =
        rawContent.ephemeralMessage?.message ??
        rawContent.viewOnceMessage?.message ??
        rawContent.viewOnceMessageV2?.message ??
        rawContent.viewOnceMessageV2Extension?.message ??
        rawContent;

      const hasDirect = Boolean(
        messageContent.imageMessage ||
          messageContent.videoMessage ||
          messageContent.stickerMessage ||
          messageContent.documentMessage ||
          messageContent.audioMessage,
      );

      const quotedMsg = messageContent.extendedTextMessage?.contextInfo?.quotedMessage;
      const unwrappedQuoted = quotedMsg
        ? (quotedMsg.ephemeralMessage?.message ??
          quotedMsg.viewOnceMessage?.message ??
          quotedMsg.viewOnceMessageV2?.message ??
          quotedMsg)
        : undefined;

      const hasQuoted = Boolean(
        unwrappedQuoted?.imageMessage ||
          unwrappedQuoted?.videoMessage ||
          unwrappedQuoted?.stickerMessage ||
          unwrappedQuoted?.documentMessage ||
          unwrappedQuoted?.audioMessage,
      );

      if (!hasDirect && !hasQuoted) return null;

      const targetMsg = hasDirect
        ? {
            ...rawMessage,
            message: messageContent,
          }
        : {
            key: {
              remoteJid: rawMessage.key.remoteJid ?? null,
              id:
                messageContent.extendedTextMessage?.contextInfo?.stanzaId ??
                rawMessage.key.id ??
                null,
              participant:
                messageContent.extendedTextMessage?.contextInfo?.participant ??
                rawMessage.key.participant ??
                null,
              fromMe: false,
            },
            message: unwrappedQuoted,
          };

      const mediaSize =
        messageContent.imageMessage?.fileLength ??
        messageContent.videoMessage?.fileLength ??
        messageContent.stickerMessage?.fileLength ??
        messageContent.documentMessage?.fileLength ??
        unwrappedQuoted?.imageMessage?.fileLength ??
        unwrappedQuoted?.videoMessage?.fileLength ??
        unwrappedQuoted?.stickerMessage?.fileLength ??
        unwrappedQuoted?.documentMessage?.fileLength;

      const sizeNum =
        typeof mediaSize === "object" && mediaSize !== null && "toNumber" in mediaSize
          ? (mediaSize as { toNumber: () => number }).toNumber()
          : Number(mediaSize || 0);

      if (sizeNum > this.maxMediaDownloadSizeBytes) {
        this.logger.warn(
          { msgId: rawMessage.key.id, sizeNum, max: this.maxMediaDownloadSizeBytes },
          "Inbound media exceeds maximum download size; skipping buffer download",
        );
        return null;
      }

      if (this.mediaDownloader) {
        return await this.mediaDownloader(targetMsg as proto.IWebMessageInfo);
      }

      const reuploadRequest =
        this.socket?.updateMediaMessage ??
        (async (_msg: WAMessage): Promise<WAMessage> => {
          throw new Error("Socket disconnected; cannot reupload media");
        });

      const buffer = await downloadMediaMessage(
        targetMsg as WAMessage,
        "buffer",
        {},
        {
          logger: this.logger.child({ component: "media-download" }) as unknown as NonNullable<
            UserFacingSocketConfig["logger"]
          >,
          reuploadRequest,
        },
      );

      return buffer as Buffer;
    } catch (err) {
      this.logger.warn(
        { err, msgId: rawMessage.key.id },
        "Failed to download media buffer for inbound message",
      );
      return null;
    }
  }

  private async handleMessagesUpsert(upsert: { messages: unknown[]; type: string }): Promise<void> {
    const selfJid = this.socket?.user?.id;

    for (const rawMessage of upsert.messages) {
      if (!rawMessage || typeof rawMessage !== "object") continue;

      const webMsg = rawMessage as proto.IWebMessageInfo;
      if (webMsg.key?.id && webMsg.message) {
        this.storeMessage(webMsg.key.id, webMsg.key.remoteJid ?? "", webMsg.message);
      }

      if (this.messageHandlers.size === 0) continue;

      const inbound = mapBaileysMessageToInbound(webMsg, selfJid);

      if (inbound) {
        // INVARIANT: Automatically ingest media buffers (including quoted stickers/photos)
        // and populate base64 data so downstream workers can process media without roundtrips.
        if (inbound.media && !inbound.media.data) {
          const mediaBuf = await this.downloadInboundMedia(webMsg);
          if (mediaBuf) {
            inbound.media = {
              ...inbound.media,
              data: mediaBuf.toString("base64"),
            };
          }
        }

        for (const handler of this.messageHandlers) {
          try {
            await handler(inbound);
          } catch (err) {
            this.logger.error({ err, msgId: inbound.id }, "Error in messageHandler");
          }
        }
      }
    }
  }

  private normalizeJid(recipient: string): string {
    if (recipient.includes("@")) {
      return recipient;
    }
    const cleanNumber = recipient.replace(/\D/g, "");
    return `${cleanNumber}@s.whatsapp.net`;
  }

  private updateStatus(newStatus: EngineStatus): void {
    this.status = newStatus;
    for (const handler of this.statusHandlers) {
      try {
        handler(this.status);
      } catch (err) {
        this.logger.error({ err }, "Error in statusHandler callback");
      }
    }
  }
}
