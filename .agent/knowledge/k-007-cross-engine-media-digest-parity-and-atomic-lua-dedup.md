---
id: "k-007"
title: "Cross-Engine Media Digest Parity and Atomic Multi-Bucket Lua Deduplication"
date: 2026-10-29
tags:
  - "redis"
  - "deduplication"
  - "baileys"
  - "wwebjs"
  - "lua"
severity: "high"
affected_components:
  - "src/utils/dedup.ts"
  - "src/queues/dedup-lock.ts"
  - "src/drivers/wwebjs-mapper.ts"
  - "src/drivers/baileys-mapper.ts"
symptoms:
  - "Duplicate media messages ingested when failover occurs around message delivery"
  - "Race conditions during simultaneous dual-engine inbound packet arrival at bucket boundary windows"
---

# [k-007] Cross-Engine Media Digest Parity and Atomic Multi-Bucket Lua Deduplication

## Problem / Symptom
In hybrid failover topologies where Baileys (primary) and WhatsApp Web JS (standby) concurrently process inbound traffic or failover during reception, media messages were generating divergent deduplication hashes:
- Baileys provides raw binary SHA-256 digests as `Uint8Array` (`fileSha256`).
- WWebJS provides Base64-encoded strings (`msg.filehash` or `msg._data.filehash`).
- Using raw representations caused identical media to produce different SHA-256 fingerprint hashes, resulting in duplicate inbound delivery.

Additionally, checking deduplication keys across adjacent 5-second timestamp buckets (`bucket - 1`, `bucket`, `bucket + 1`) via sequential `mGet` followed by non-atomic `set` allowed a race condition where simultaneous identical deliveries across engines both read `null` before either set the key, bypassing the filter.

---

## Approved Solution

### 1. Canonical Media Digest Normalization (`src/utils/dedup.ts`)
Normalize media digests from both engines into lowercase 64-character hex strings:
- Convert `Uint8Array` (Baileys) to hex via `Buffer.from(...).toString("hex")`.
- Convert 44-character Base64 (WWebJS `filehash`) to hex via `Buffer.from(..., "base64").toString("hex")`.
- Accept existing 64-character hex strings directly.

```typescript
export function normalizeMediaDigest(raw?: Uint8Array | string | null): string | undefined {
  if (!raw) return undefined;
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("hex").toLowerCase();
  }
  const clean = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return clean.toLowerCase();
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(clean) || /^[A-Za-z0-9+/]{42}==$/.test(clean)) {
    try {
      const buf = Buffer.from(clean, "base64");
      if (buf.length === 32) {
        return buf.toString("hex").toLowerCase();
      }
    } catch {
      // Fallback
    }
  }
  return clean.toLowerCase();
}
```

### 2. Atomic Lua Deduplication Script (`src/queues/dedup-lock.ts`)
Execute an atomic Redis Lua script via `EVAL` that checks candidate keys in all adjacent buckets and sets them atomically if none exist:

```lua
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    return 0
  end
end
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], '1', 'EX', ttl)
end
return 1
```

**Root Cause:** Differences in protocol serialization between Baileys Protobuf (`Uint8Array`) and Chromium WWebJS DevTools payload (`Base64`), coupled with multi-key check-then-set concurrency hazards across distributed nodes.

---

## What NEVER to Do
- ❌ **Anti-Pattern:** Comparing media digests without format normalization (e.g., comparing Base64 string directly against hex string).
  - *Why:* Hashes will never match, defeating deduplication between primary and standby engines.
- ❌ **Anti-Pattern:** Using sequential `mGet` followed by `set` across multiple candidate keys for distributed deduplication.
  - *Why:* Check-then-set is not atomic across multiple keys in Redis without `MULTI`/`EXEC` or Lua; concurrent deliveries race and produce duplicates.

---

## Verification
```bash
pnpm test
pnpm typecheck
pnpm lint
```
