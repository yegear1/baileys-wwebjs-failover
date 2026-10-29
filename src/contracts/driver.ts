import type { InboundMessage, MessageReceipt, OutboundMessage } from "./messages.js";

export type EngineName = "baileys" | "wwebjs";

export type EngineState =
  | "UNPAIRED"
  | "PAIRING_QR_READY"
  | "CONNECTING"
  | "CONNECTED"
  | "STANDBY"
  | "DISCONNECTED"
  | "DEGRADED"
  | "ERROR";

export interface EngineStatus {
  readonly engine: EngineName;
  readonly state: EngineState;
  readonly connected: boolean;
  readonly batteryLevel?: number;
  readonly lastSeen?: Date;
  readonly error?: string;
  readonly restartCount?: number;
  readonly isHealthy?: boolean;
}

export type PresenceState = "composing" | "paused";

/**
 * Common driver contract for WhatsApp engines (Baileys and WhatsApp-Web.js).
 *
 * INVARIANT: Both engines must adhere strictly to this contract to allow
 * transparent failover orchestration without leaking engine-specific internals.
 */
export interface IWhatsAppDriver {
  readonly name: EngineName;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt>;
  sendPresence?(to: string, state: PresenceState): Promise<void>;
  getSelfJid?(): string | undefined;
  getQrCode?(): string | undefined;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onStatusChange(handler: (status: EngineStatus) => void): void;
  getStatus(): EngineStatus;
  checkHealth?(): Promise<{ isHealthy: boolean; details?: unknown }>;
  restart?(): Promise<void>;
}
