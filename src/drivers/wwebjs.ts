import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import pkg from "whatsapp-web.js";
import type { EngineStatus, IWhatsAppDriver, PresenceState } from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";
import { logger as defaultLogger } from "../index.js";
import { ensureSecureAuthDirectory } from "./auth-utils.js";
import {
  mapOutboundToWWebJSContent,
  mapWWebJSMessageToInbound,
  toWWebJSChatId,
  type WWebJSMessageLike,
} from "./wwebjs-mapper.js";

const { Client, LocalAuth } = pkg;

export const DEFAULT_CHROMIUM_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
];

export interface WWebJSChatInterface {
  sendStateTyping?: () => Promise<void>;
  clearState?: () => Promise<void>;
}

export interface WWebJSClientInterface {
  info?: {
    wid?: {
      _serialized?: string;
    };
  };
  pupBrowser?: {
    process(): {
      pid?: number | undefined;
      killed?: boolean | undefined;
    } | null;
  };
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: unknown,
  ): Promise<{ id?: { id?: string; _serialized?: string } }>;
  sendPresenceAvailable?: () => Promise<void>;
  getChatById?: (chatId: string) => Promise<WWebJSChatInterface>;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface WWebJSDriverOptions {
  readonly authDir?: string;
  readonly logger?: Logger;
  readonly chromiumArgs?: string[];
  readonly teardownTimeoutMs?: number;
  readonly executablePath?: string;
  readonly clientFactory?: (options: pkg.ClientOptions) => WWebJSClientInterface;
}

/**
 * Driver adapter for WhatsApp Web via Puppeteer / whatsapp-web.js.
 *
 * INVARIANT: WWebJS serves as the cold-standby backup engine. It must strictly
 * implement IWhatsAppDriver, enforce secure 0700 auth permissions, apply Chromium
 * container hygiene flags, and forcefully kill zombie browser processes upon disconnect
 * to reclaim ~500MB container RAM.
 */
export class WWebJSDriver implements IWhatsAppDriver {
  public readonly name = "wwebjs" as const;

  private readonly authDir: string;
  private readonly logger: Logger;
  private readonly chromiumArgs: string[];
  private readonly teardownTimeoutMs: number;
  private readonly executablePath: string | undefined;
  private readonly clientFactory: (options: pkg.ClientOptions) => WWebJSClientInterface;

  private client: WWebJSClientInterface | null = null;
  private qrCode: string | undefined = undefined;
  private status: EngineStatus = {
    engine: "wwebjs",
    state: "DISCONNECTED",
    connected: false,
  };

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private statusHandler: ((status: EngineStatus) => void) | null = null;

  constructor(options: WWebJSDriverOptions = {}) {
    this.authDir = options.authDir ?? process.env.AUTH_DIR_WWEBJS ?? "/data/auth/wwebjs";
    this.logger = options.logger ?? defaultLogger;
    this.chromiumArgs = options.chromiumArgs ?? DEFAULT_CHROMIUM_FLAGS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? 5000;
    this.executablePath = options.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH;
    this.clientFactory =
      options.clientFactory ??
      ((opts: pkg.ClientOptions) => new Client(opts) as unknown as WWebJSClientInterface);
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  public getQrCode(): string | undefined {
    return this.qrCode;
  }

  public getSelfJid(): string | undefined {
    return this.client?.info?.wid?._serialized;
  }

  public async sendPresence(to: string, state: PresenceState): Promise<void> {
    if (!this.client || !this.status.connected) {
      throw new Error("Cannot send presence: WWebJS driver is not connected");
    }

    const targetChatId = toWWebJSChatId(to);

    try {
      if (this.client.getChatById) {
        const chat = await this.client.getChatById(targetChatId);
        if (state === "composing") {
          await chat.sendStateTyping?.();
        } else {
          await chat.clearState?.();
        }
      } else if (state === "composing" && this.client.sendPresenceAvailable) {
        await this.client.sendPresenceAvailable();
      }
    } catch (err) {
      this.logger.warn({ err, to, state }, "Failed to send presence state in WWebJS");
    }
  }

  public onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  public onStatusChange(handler: (status: EngineStatus) => void): void {
    this.statusHandler = handler;
  }

  public async connect(): Promise<void> {
    ensureSecureAuthDirectory(this.authDir);

    this.updateStatus({
      engine: "wwebjs",
      state: "CONNECTING",
      connected: false,
    });

    try {
      const client = this.clientFactory({
        authStrategy: new LocalAuth({
          dataPath: this.authDir,
        }),
        puppeteer: {
          headless: true,
          args: [...this.chromiumArgs],
          ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        },
        takeoverOnConflict: true,
      });

      this.client = client;
      this.wireClientEvents(client);

      await client.initialize();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.updateStatus({
        engine: "wwebjs",
        state: "ERROR",
        connected: false,
        error: errorMessage,
      });
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      this.qrCode = undefined;

      const browserProcess = client.pupBrowser?.process?.();
      const pid = browserProcess?.pid;

      try {
        await Promise.race([
          client.destroy(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Client destroy timeout")), this.teardownTimeoutMs),
          ),
        ]);
      } catch (err) {
        this.logger.warn(
          { err },
          "WWebJS client.destroy() timed out or failed; proceeding to process-tree SIGKILL",
        );
      }

      // INVARIANT: Chromium child processes can survive client.destroy() as orphaned zombie processes;
      // forceful process-tree SIGKILL guarantees freeing ~500MB of container memory.
      if (pid && !browserProcess?.killed) {
        this.terminateProcessTree(pid);
      }
    }

    this.updateStatus({
      engine: "wwebjs",
      state: "DISCONNECTED",
      connected: false,
    });
  }

  public async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (!this.client || !this.status.connected) {
      throw new Error("Cannot send message: WWebJS driver is not connected");
    }

    const targetChatId = toWWebJSChatId(to);
    const { content: wwebContent, options } = await mapOutboundToWWebJSContent(content);

    const sent = await this.client.sendMessage(targetChatId, wwebContent, options);
    const messageId = sent?.id?.id ?? sent?.id?._serialized ?? randomUUID();

    return {
      id: messageId,
      to,
      timestamp: Date.now(),
      status: "SENT",
    };
  }

  private wireClientEvents(client: WWebJSClientInterface): void {
    client.on("qr", (qr: unknown) => {
      if (typeof qr === "string") {
        this.qrCode = qr;
        this.updateStatus({
          engine: "wwebjs",
          state: "PAIRING_QR_READY",
          connected: false,
        });
      }
    });

    client.on("ready", () => {
      this.qrCode = undefined;
      this.updateStatus({
        engine: "wwebjs",
        state: "CONNECTED",
        connected: true,
        lastSeen: new Date(),
      });
    });

    client.on("authenticated", () => {
      this.qrCode = undefined;
    });

    client.on("auth_failure", (msg: unknown) => {
      this.qrCode = undefined;
      const error = typeof msg === "string" ? msg : "Authentication failed";
      this.updateStatus({
        engine: "wwebjs",
        state: "UNPAIRED",
        connected: false,
        error,
      });
    });

    client.on("disconnected", (reason: unknown) => {
      this.qrCode = undefined;
      const reasonStr = typeof reason === "string" ? reason : "Disconnected";
      const isLoggedOut = reasonStr.toUpperCase().includes("LOGOUT");
      this.updateStatus({
        engine: "wwebjs",
        state: isLoggedOut ? "UNPAIRED" : "DISCONNECTED",
        connected: false,
        error: reasonStr,
      });
    });

    client.on("change_battery", (batteryInfo: unknown) => {
      if (
        batteryInfo &&
        typeof batteryInfo === "object" &&
        "battery" in batteryInfo &&
        typeof batteryInfo.battery === "number"
      ) {
        this.updateStatus({
          ...this.status,
          batteryLevel: batteryInfo.battery,
        });
      }
    });

    client.on("message", async (rawMessage: unknown) => {
      if (!this.messageHandler || !rawMessage || typeof rawMessage !== "object") {
        return;
      }

      const selfJid = client.info?.wid?._serialized;
      const inbound = mapWWebJSMessageToInbound(rawMessage as WWebJSMessageLike, selfJid);
      if (inbound) {
        try {
          await this.messageHandler(inbound);
        } catch (err) {
          this.logger.error({ err, msgId: inbound.id }, "Error in messageHandler for WWebJS");
        }
      }
    });
  }

  private terminateProcessTree(pid: number): void {
    try {
      // INVARIANT: Process group kill (-pid) signals Chromium master and all spawned renderer/GPU sub-processes.
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already terminated cleanly
      }
    }
  }

  private updateStatus(newStatus: EngineStatus): void {
    this.status = newStatus;
    if (this.statusHandler) {
      try {
        this.statusHandler(this.status);
      } catch (err) {
        this.logger.error({ err }, "Error in statusHandler callback");
      }
    }
  }
}
