---
id: "k-008"
title: "Dynamic Chromium Health, Singleton Lock Cleanup, and Standby Puppeteer Restart Recovery"
date: 2026-10-29
tags:
  - "wwebjs"
  - "puppeteer"
  - "chromium"
  - "health"
  - "recovery"
  - "zombie-process"
severity: "high"
affected_components:
  - "src/drivers/wwebjs.ts"
  - "src/fsm/orchestrator.ts"
  - "src/http/metrics-service.ts"
symptoms:
  - "Silent Chromium crashes, renderer freezes, or CDP pipe breakage in FALLBACK_ACTIVE without triggering driver disconnected events"
  - "SingletonLock, SingletonCookie, and SingletonSocket files remaining in authDir preventing subsequent Chromium relaunch"
  - "Outbound message drops during standby browser restart attempts"
---

# [k-008] Dynamic Chromium Health, Singleton Lock Cleanup, and Standby Puppeteer Restart Recovery

## Problem / Symptom

1. **Undetected Zombie / Frozen Chromium Processes:**
   During extended standby or `FALLBACK_ACTIVE` execution, Chromium can experience silent renderer crashes, headless deadlocks, or CDP session pipe drops without `whatsapp-web.js` firing a `"disconnected"` event. Standard status checks report `connected: true` while `pupPage.evaluate()` hangs indefinitely.

2. **Stale Chromium Singleton Lockfiles:**
   When Chromium is terminated abruptly (SIGKILL or host OOM), stale lockfiles (`SingletonLock`, `SingletonCookie`, `SingletonSocket`) persist in `/data/auth/wwebjs`. On subsequent launch attempts, Chromium fails with `"The profile appears to be in use by another process"`.

3. **Message Dropping During Standby Relaunch:**
   If the standby engine crashes while active, immediate dispatch attempts fail unless the orchestrator buffers outbound messages during the restart transition (`DEGRADED` state).

---

## Approved Solution

1. **Multi-Vector Liveness & Health Probing:**
   - Verify OS process liveness via `process.kill(pid, 0)` and Linux `/proc/${pid}/status` zombie (`Z`) state detection.
   - Verify CDP session status via `pupBrowser.isConnected()`.
   - Actively probe page responsiveness with a bounded `pupPage.evaluate(() => 1)` timeout (default 3s).
   - Listen to `pupBrowser` (`"disconnected"`), child process (`"exit"`), and `pupPage` (`"error"`, `"close"`) events.

2. **Orphaned Lockfile & Standby Hygiene:**
   - Recursively scan `authDir` and remove `SingletonLock`, `SingletonCookie`, and `SingletonSocket` files prior to launch and during standby teardown.
   - Terminate any lingering Chromium master or process group PIDs.

3. **Graceful Standby Restart Recovery & Buffer Preservation:**
   - Transition driver state to `DEGRADED` during recovery attempts up to `maxRestartRetries` (default 3) with exponential backoff.
   - Failover orchestrator treats `DEGRADED` standby state as an outbound buffering window, holding messages until recovery succeeds and then flushing immediately.
   - Export monotonic `chromium_restarts_total` in Prometheus metrics.

---

## What NEVER to Do
- ❌ **Anti-Pattern:** Assuming `status.connected` guarantees browser liveness without deep CDP/page responsiveness checks.
  - *Why:* Chromium renderer crashes and deadlocks leave status as `connected` while dispatches fail silently.
- ❌ **Anti-Pattern:** Attempting to relaunch Puppeteer without unlinking stale `Singleton*` lockfiles.
  - *Why:* Prevents Chromium profile initialization after abrupt container restarts.
- ❌ **Anti-Pattern:** Failing outbound messages immediately when standby enters restart recovery.
  - *Why:* Buffering in memory during `DEGRADED` state preserves zero-loss delivery during transient browser relaunch.

---

## Verification
```bash
pnpm test tests/wwebjs-health-recovery.test.ts
```
