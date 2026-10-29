import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapBaileysMessageToInbound } from "../src/drivers/baileys-mapper.js";
import { mapWWebJSMessageToInbound } from "../src/drivers/wwebjs-mapper.js";
import {
  calculateDedupBucket,
  calculateDedupCandidateHashes,
  calculateDedupHash,
  normalizeMediaDigest,
  normalizeTimestampToSeconds,
} from "../src/utils/dedup.js";

describe("Deduplication Engine", () => {
  it("normalizes milliseconds and seconds timestamps consistently", () => {
    const timestampSec = 1700000000;
    const timestampMs = 1700000000123;

    expect(normalizeTimestampToSeconds(timestampSec)).toBe(1700000000);
    expect(normalizeTimestampToSeconds(timestampMs)).toBe(1700000000);
  });

  it("calculates integer 10-second buckets", () => {
    expect(calculateDedupBucket(1700000000)).toBe(170000000);
    expect(calculateDedupBucket(1700000009)).toBe(170000000);
    expect(calculateDedupBucket(1700000010)).toBe(170000001);
  });

  it("produces identical SHA-256 hashes for messages within the same 10s bucket", () => {
    const baseInput = {
      remoteJid: "5511999999999@s.whatsapp.net",
      senderJid: "5511888888888@s.whatsapp.net",
      textBody: "Hello, failover gateway!",
    };

    const hashAtT0 = calculateDedupHash({
      ...baseInput,
      timestamp: 1700000002,
    });

    const hashAtTPlus5 = calculateDedupHash({
      ...baseInput,
      timestamp: 1700000007,
    });

    expect(hashAtT0).toBe(hashAtTPlus5);
    expect(hashAtT0).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses mediaDigest when textBody is absent or empty", () => {
    const hash = calculateDedupHash({
      remoteJid: "5511999999999@s.whatsapp.net",
      senderJid: "5511888888888@s.whatsapp.net",
      timestamp: 1700000000,
      textBody: "",
      mediaDigest: "dGhpcy1pcy1hLW1lZGlhLXNoYTI1Ng==",
    });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("isolates distinct messages across senders, recipients, and content", () => {
    const base = {
      remoteJid: "5511999999999@s.whatsapp.net",
      senderJid: "5511888888888@s.whatsapp.net",
      timestamp: 1700000000,
      textBody: "Payload A",
    };

    const hashBase = calculateDedupHash(base);
    const hashDiffSender = calculateDedupHash({
      ...base,
      senderJid: "5511777777777@s.whatsapp.net",
    });
    const hashDiffRemote = calculateDedupHash({
      ...base,
      remoteJid: "123456789@g.us",
    });
    const hashDiffContent = calculateDedupHash({
      ...base,
      textBody: "Payload B",
    });

    expect(hashBase).not.toBe(hashDiffSender);
    expect(hashBase).not.toBe(hashDiffRemote);
    expect(hashBase).not.toBe(hashDiffContent);
  });

  it("generates candidate bucket hashes to absorb boundary clock skew", () => {
    const inputAtBoundary = {
      remoteJid: "5511999999999@s.whatsapp.net",
      senderJid: "5511888888888@s.whatsapp.net",
      timestamp: 1700000009, // 1s before bucket flip
      textBody: "Boundary message",
    };

    const candidates = calculateDedupCandidateHashes(inputAtBoundary, 5);
    // Buckets for 1700000009: 170000000, 1700000009 - 5 = 1700000004 -> bucket 170000000, 1700000009 + 5 = 1700000014 -> bucket 170000001
    expect(candidates.length).toBe(2);

    const hashNextBucket = calculateDedupHash({
      ...inputAtBoundary,
      timestamp: 1700000011,
    });

    expect(candidates).toContain(hashNextBucket);
  });

  it("normalizes media digests across Uint8Array, 64-char Hex, and 44-char Base64", () => {
    const rawPayload = Buffer.from("arbitrary image payload content for hash parity");
    const rawSha256 = createHash("sha256").update(rawPayload).digest();
    const hexDigest = rawSha256.toString("hex");
    const base64Digest = rawSha256.toString("base64");

    // Uint8Array input (Baileys format)
    expect(normalizeMediaDigest(rawSha256)).toBe(hexDigest.toLowerCase());

    // Hex string input
    expect(normalizeMediaDigest(hexDigest.toUpperCase())).toBe(hexDigest.toLowerCase());

    // Base64 string input (WWebJS format)
    expect(normalizeMediaDigest(base64Digest)).toBe(hexDigest.toLowerCase());

    // Null/undefined/empty input
    expect(normalizeMediaDigest(null)).toBeUndefined();
    expect(normalizeMediaDigest(undefined)).toBeUndefined();
    expect(normalizeMediaDigest("   ")).toBeUndefined();
  });

  it("produces identical dedupHash for media messages mapped from Baileys and WWebJS", () => {
    const timestampSec = 1700000000;
    const mediaPayload = Buffer.from("sample shared attachment image");
    const sha256Buffer = createHash("sha256").update(mediaPayload).digest();
    const sha256Hex = sha256Buffer.toString("hex");
    const sha256Base64 = sha256Buffer.toString("base64");

    // Baileys media message (supplies fileSha256 as Uint8Array)
    const baileysInbound = mapBaileysMessageToInbound({
      key: {
        id: "baileys_media_1",
        remoteJid: "5511999998888@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: timestampSec,
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileSha256: new Uint8Array(sha256Buffer),
          caption: "Shared photo",
        },
      },
    });

    // WWebJS media message (supplies filehash as Base64 string)
    const wwebjsInbound = mapWWebJSMessageToInbound({
      id: { id: "wwebjs_media_1", _serialized: "false_5511999998888@c.us_wwebjs_media_1" },
      from: "5511999998888@c.us",
      fromMe: false,
      timestamp: timestampSec,
      type: "image",
      body: "Shared photo",
      hasMedia: true,
      filehash: sha256Base64,
    });

    expect(baileysInbound).not.toBeNull();
    expect(wwebjsInbound).not.toBeNull();
    expect(baileysInbound?.media?.digest).toBe(sha256Hex);
    expect(wwebjsInbound?.media?.digest).toBe(sha256Hex);
    expect(baileysInbound?.dedupHash).toBe(wwebjsInbound?.dedupHash);
  });
});
