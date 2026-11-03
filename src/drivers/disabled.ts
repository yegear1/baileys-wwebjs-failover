import type {
  EngineName,
  EngineStatus,
  IWhatsAppDriver,
  PresenceState,
} from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";

/**
 * Null-object driver representing a disabled WhatsApp engine.
 *
 * INVARIANT: Used when a specific engine (such as the WWebJS standby engine)
 * is explicitly disabled via configuration (e.g. GATEWAY_MODE=baileys_only).
 * Prevents Chromium/Puppeteer processes from launching, rejects outbound requests,
 * and reports the engine state as DISABLED to observability.
 */
export class DisabledDriver implements IWhatsAppDriver {
  public readonly name: EngineName;
  private readonly reason: string;

  constructor(name: EngineName = "wwebjs", reason = "Engine is disabled by gateway configuration") {
    this.name = name;
    this.reason = reason;
  }

  public async connect(): Promise<void> {
    // INVARIANT: Disabled engine is a no-op; never initiates socket or browser sessions
  }

  public async disconnect(): Promise<void> {
    // No-op
  }

  public async sendMessage(_to: string, _content: OutboundMessage): Promise<MessageReceipt> {
    throw new Error(`Cannot send message: engine ${this.name} is disabled (${this.reason})`);
  }

  public async sendReaction?(
    _messageId: string,
    _reaction: string,
    _remoteJid?: string,
  ): Promise<void> {
    throw new Error(`Cannot send reaction: engine ${this.name} is disabled (${this.reason})`);
  }

  public async sendPresence?(_to: string, _state: PresenceState): Promise<void> {
    // No-op
  }

  public getSelfJid(): string | undefined {
    return undefined;
  }

  public getQrCode(): string | undefined {
    return undefined;
  }

  public onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {
    // No-op
  }

  public onStatusChange(_handler: (status: EngineStatus) => void): void {
    // No-op
  }

  public getStatus(): EngineStatus {
    return {
      engine: this.name,
      state: "DISABLED",
      connected: false,
      error: this.reason,
    };
  }

  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return { isHealthy: false, details: { disabled: true, reason: this.reason } };
  }

  public async restart(): Promise<void> {
    // No-op
  }

  public async requestPairing(): Promise<void> {
    throw new Error(
      `Pairing is not supported because engine ${this.name} is disabled (${this.reason})`,
    );
  }
}
