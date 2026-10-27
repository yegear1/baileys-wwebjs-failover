import { describe, expect, it } from "vitest";
import {
  calculateDedupBucket,
  calculateDedupCandidateHashes,
  calculateDedupHash,
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
});
