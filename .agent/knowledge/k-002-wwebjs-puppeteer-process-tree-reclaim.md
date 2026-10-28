---
id: "k-002"
title: "WWebJS Chromium Process-Tree Teardown and Cross-Engine JID Deduplication"
date: 2026-10-28
tags:
  - "wwebjs"
  - "puppeteer"
  - "chromium"
  - "dedup"
  - "failover"
severity: "high"
affected_components:
  - "src/drivers/wwebjs.ts"
  - "src/drivers/wwebjs-mapper.ts"
symptoms:
  - "Chromium child processes remain alive after client.destroy(), retaining 500+ MB RAM in container"
  - "Cross-engine failover duplicate dispatches caused by JID suffix mismatch (@c.us vs @s.whatsapp.net)"
---

# [k-002] WWebJS Chromium Process-Tree Teardown and Cross-Engine JID Deduplication

## Problem / Symptom

1. **Memory Bloat & Zombie Processes:**
   Calling `client.destroy()` in `whatsapp-web.js` does not guarantee that underlying Chromium renderer/GPU helper child processes exit immediately or cleanly in Docker container environments. Without hard process-tree cleanup, orphaned Chromium processes retain approximately 500 MB RAM per instance, causing OOM kills when switching between primary and standby engines.

2. **Deduplication Key Mismatch Across Engines:**
   WhatsApp-Web.js represents contact chats using `@c.us` (e.g. `5511999999999@c.us`), whereas Baileys represents contacts using `@s.whatsapp.net` (e.g. `5511999999999@s.whatsapp.net`). Group chats in both use `@g.us`. Calculating deduplication hashes with raw JIDs causes identical messages received during failover overlap to yield divergent hashes, breaking at-most-once delivery.

---

## Approved Solution

1. **Two-Stage Process Teardown with Forceful SIGKILL:**
   - Attempt graceful `client.destroy()` with a bounded timeout (e.g., 5000ms).
   - If the browser process PID is still alive, signal the process group (`process.kill(-pid, 'SIGKILL')`) with fallback to individual PID (`process.kill(pid, 'SIGKILL')`).
   - Launch with Chromium container hygiene flags:
     `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--no-first-run`, `--no-zygote`.

2. **Canonical JID Normalization:**
   - In `wwebjs-mapper.ts`, normalize all inbound contact JIDs from `@c.us` to `@s.whatsapp.net` prior to hashing.
   - Preserves `@g.us` for groups and `@broadcast` for status feeds.
   - When sending outbound messages via WWebJS, convert canonical `@s.whatsapp.net` back to `@c.us`.

---

## What NEVER to Do
- ❌ **Anti-Pattern:** Relying solely on `client.destroy()` without monitoring process exit and enforcing SIGKILL.
  - *Why:* Leaks 500+ MB RAM per cold-start cycle.
- ❌ **Anti-Pattern:** Hashing unnormalized engine-specific JID strings.
  - *Why:* Produces split-brain duplicate messages during engine failover.

---

## Verification
```bash
pnpm test tests/wwebjs.test.ts
```
