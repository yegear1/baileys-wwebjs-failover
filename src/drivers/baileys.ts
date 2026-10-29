import { randomUUID } from "node:crypto";
import makeWASocket, {
  type AuthenticationState,
  type ConnectionState,
  DisconnectReason,
  type UserFacingSocketConfig,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import type { EngineStatus, IWhatsAppDriver, PresenceState } from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";
import { logger as defaultLogger } from "../index.js";
import { ensureSecureAuthDirectory } from "./auth-utils.js";
import { mapBaileysMessageToInbound, mapOutboundToBaileysContent } from "./baileys-mapper.js";

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
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

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
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 5;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
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

    this.updateStatus({
      engine: "baileys",
      state: isLoggedOut ? "UNPAIRED" : "DISCONNECTED",
      connected: false,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });

    // INVARIANT: Do not reconnect if unlinked/logged out, if explicitly disconnected by caller,
    // or if autoReconnect is disabled.
    if (this.isIntentionalDisconnect || isLoggedOut || !this.autoReconnect) {
      return;
    }

    this.scheduleReconnect(statusCode, errorMessage);
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

  private async handleMessagesUpsert(upsert: { messages: unknown[]; type: string }): Promise<void> {
    if (this.messageHandlers.size === 0) return;

    const selfJid = this.socket?.user?.id;

    for (const rawMessage of upsert.messages) {
      if (!rawMessage || typeof rawMessage !== "object") continue;

      const inbound = mapBaileysMessageToInbound(
        rawMessage as Parameters<typeof mapBaileysMessageToInbound>[0],
        selfJid,
      );

      if (inbound) {
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
