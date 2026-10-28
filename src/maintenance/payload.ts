import { randomBytes } from "node:crypto";
import type { OutboundMessage } from "../contracts/messages.js";

const TEMPLATES: readonly string[] = [
  "[standby-keepalive] Node check-in • seq=%SEQ% • nonce=%NONCE% • clock=%TS%",
  "[companion-pulse] Standby session heartbeat • seq=%SEQ% • canary=%NONCE% • clock=%TS%",
  "[diagnostic-ping] Anti-expiration sync • seq=%SEQ% • entropy=%NONCE% • clock=%TS%",
];

/**
 * Generates a non-repeating, dynamic keep-alive message for self-chat.
 *
 * INVARIANT: Repetitive static payloads are trivial for server-side heuristic scanners
 * to classify as bot heartbeats. Dynamic payloads with unique nonces, clock timestamps,
 * and rotated formats simulate organic companion note activity.
 *
 * @param to Target recipient self-chat JID.
 * @param sequence Monotonically increasing keep-alive sequence number.
 * @returns Non-repeating OutboundMessage targeting text content.
 */
export function generateDynamicKeepalivePayload(to: string, sequence: number): OutboundMessage {
  const nonce = randomBytes(6).toString("hex");
  const isoTime = new Date().toISOString();
  const templateIndex = Math.abs(sequence) % TEMPLATES.length;
  const template = TEMPLATES[templateIndex] ?? TEMPLATES[0] ?? "";

  const text = template
    .replace("%SEQ%", String(sequence))
    .replace("%NONCE%", nonce)
    .replace("%TS%", isoTime);

  return {
    to,
    type: "text",
    text,
  };
}
