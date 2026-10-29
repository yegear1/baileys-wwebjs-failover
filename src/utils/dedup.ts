import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export interface DedupHashInput {
  readonly remoteJid: string;
  readonly senderJid: string;
  readonly timestamp: number;
  readonly textBody?: string | null | undefined;
  readonly mediaDigest?: string | null | undefined;
}

/**
 * Normalizes raw media hash/digest from either engine to a canonical lowercase hex string.
 * Supports:
 * - Uint8Array (32-byte SHA-256 buffer, e.g. Baileys fileSha256)
 * - 64-character Hex string (e.g. Baileys / already normalized digests)
 * - 44-character Base64 string (32 bytes Base64-encoded, e.g. WWebJS msg.filehash / msg._data.filehash)
 */
export function normalizeMediaDigest(raw?: Uint8Array | string | null): string | undefined {
  if (!raw) return undefined;

  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return Buffer.from(raw).toString("hex").toLowerCase();
  }

  const str = raw.trim();
  if (str.length === 0) return undefined;

  // 64-character hex string
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    return str.toLowerCase();
  }

  // 44-character base64 string (32 bytes with = padding or unpadded)
  if (/^[A-Za-z0-9+/]{43}=?$/.test(str) || /^[A-Za-z0-9+/]{44}$/.test(str)) {
    try {
      const buf = Buffer.from(str, "base64");
      if (buf.length === 32) {
        return buf.toString("hex").toLowerCase();
      }
    } catch {
      // ignore
    }
  }

  return str;
}

/**
 * Normalizes a Unix timestamp to seconds.
 * If the input is in milliseconds (> 1e11, approximately year 1973+ in ms),
 * it converts it to integer seconds.
 */
export function normalizeTimestampToSeconds(timestamp: number): number {
  if (timestamp > 100_000_000_000) {
    return Math.floor(timestamp / 1000);
  }
  return Math.floor(timestamp);
}

/**
 * Calculates the 10-second bucket for a given timestamp in seconds.
 */
export function calculateDedupBucket(timestampInSeconds: number): number {
  return Math.floor(timestampInSeconds / 10);
}

/**
 * Generates an SHA-256 deduplication hash for an inbound message.
 *
 * INVARIANT: Deduplication hash uses 10-second integer division bucket to absorb
 * cross-engine clock skew and network jitter between primary and standby companion sockets.
 * Formula: SHA256(remoteJid + senderJid + (textBody || mediaDigest) + floor(timestamp / 10))
 */
export function calculateDedupHash(input: DedupHashInput): string {
  const tsSeconds = normalizeTimestampToSeconds(input.timestamp);
  const bucket = calculateDedupBucket(tsSeconds);
  const content = (input.textBody ?? "").trim() || (input.mediaDigest ?? "").trim();
  const rawPayload = `${input.remoteJid}${input.senderJid}${content}${bucket}`;

  return createHash("sha256").update(rawPayload).digest("hex");
}

/**
 * Generates deduplication candidate hashes across a window of adjacent buckets.
 *
 * INVARIANT: Cross-device socket events arriving right on a 10s boundary (e.g. 9.9s vs 10.1s)
 * fall into adjacent buckets. Checking adjacent candidate hashes prevents split-brain duplicate
 * delivery during failover transitions.
 */
export function calculateDedupCandidateHashes(
  input: DedupHashInput,
  windowSkewSeconds = 5,
): string[] {
  const tsSeconds = normalizeTimestampToSeconds(input.timestamp);
  const buckets = new Set<number>([
    calculateDedupBucket(tsSeconds),
    calculateDedupBucket(tsSeconds - windowSkewSeconds),
    calculateDedupBucket(tsSeconds + windowSkewSeconds),
  ]);

  const content = (input.textBody ?? "").trim() || (input.mediaDigest ?? "").trim();
  const candidateHashes: string[] = [];

  for (const bucket of buckets) {
    const rawPayload = `${input.remoteJid}${input.senderJid}${content}${bucket}`;
    candidateHashes.push(createHash("sha256").update(rawPayload).digest("hex"));
  }

  return candidateHashes;
}
