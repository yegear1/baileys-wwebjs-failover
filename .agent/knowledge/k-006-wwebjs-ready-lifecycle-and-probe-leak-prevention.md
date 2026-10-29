---
id: "k-006"
title: "WWebJS Ready Lifecycle Synchronization and Silent Probe Socket Leak Prevention"
date: 2026-10-29
tags:
  - "wwebjs"
  - "puppeteer"
  - "orchestrator"
  - "probe"
  - "lifecycle"
severity: "medium"
affected_components:
  - "src/drivers/wwebjs.ts"
  - "src/drivers/baileys.ts"
  - "src/fsm/orchestrator.ts"
symptoms:
  - "Premature message send failure immediately after WWebJS connect() returns"
  - "Accumulation of zombie probe sockets during FALLBACK_ACTIVE state"
  - "Silent failure to detect standby Chromium crash while in FALLBACK_ACTIVE"
---

# [k-006] WWebJS Ready Lifecycle Synchronization and Silent Probe Socket Leak Prevention

## Problem / Symptom

1. **Premature Message Send in Cold-Standby Failover:** In `whatsapp-web.js`, `client.initialize()` resolves once Chromium launches and script injection starts, but BEFORE the session has fully authenticated or emitted `'ready'`. If callers (`FailoverOrchestrator`) flush buffered outbound messages immediately upon `connect()`, `sendMessage` throws `Cannot send message: WWebJS driver is not connected`.
2. **Zombie Probe Sockets:** During `FALLBACK_ACTIVE`, automated silent probes against Baileys can create redundant WebSocket connections if they reconnect without checking if primary is already connected, or if failed/timed-out probe sockets are left open without explicit disconnect.
3. **Undetected Standby Failure:** If WWebJS crashes or disconnects while serving traffic in `FALLBACK_ACTIVE`, the orchestrator previously lacked a standby `onStatusChange` listener, leaving outbound queues stalled.

---

## Approved Solution

### 1. WWebJS `connect()` Awaits `'ready'` Event

`WWebJSDriver.connect()` must await the client `'ready'` event with a deterministic timeout (`readyTimeoutMs`, default 45s), rejecting immediately on `'auth_failure'` or `'disconnected'`:

```typescript
// INVARIANT: Callers must only proceed when the driver is genuinely ready to send and receive messages
await new Promise<void>((resolve, reject) => {
  const onReady = () => { cleanup(); resolve(); };
  const onAuthFailure = (err) => { cleanup(); reject(err); };
  const onDisconnected = (reason) => { cleanup(); reject(reason); };
  client.on("ready", onReady);
  client.on("auth_failure", onAuthFailure);
  client.on("disconnected", onDisconnected);
  // ... timer cleanup
});
```

### 2. Guarded Silent Probing and Socket Teardown

`FailoverOrchestrator.executeSilentProbe()`:
- Inspects `primary.getStatus().connected` first — if already connected, records success without reconnecting.
- If disconnected, awaits connection completion with deterministic timeout (`probeTimeoutMs`).
- Upon connection failure or timeout, explicitly tears down probe sockets (`await this.disconnectPrimarySafely()`).
- Guards against concurrent probe execution with `this.isProbing`.

### 3. Standby Status Monitoring in `FALLBACK_ACTIVE`

`FailoverOrchestrator` subscribes to `this.standby.onStatusChange`:
- Captures unexpected crashes (`ERROR`, `DISCONNECTED`, `UNPAIRED`) while in `FALLBACK_ACTIVE`.
- Triggers immediate recovery swap if primary is already connected, or triggers an immediate silent probe to evaluate primary readiness.
