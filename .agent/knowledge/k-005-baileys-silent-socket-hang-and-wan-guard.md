---
id: "k-005"
title: "Baileys Silent Socket Hang, Host WAN Guard and Dead Letter Queue"
date: 2026-10-29
tags:
  - "baileys"
  - "network"
  - "timeout"
  - "failover"
  - "dlq"
severity: "high"
affected_components:
  - "src/drivers/baileys.ts"
  - "src/fsm/orchestrator.ts"
  - "src/queues/outbound-worker.ts"
symptoms:
  - "Baileys sendMessage hanging indefinitely with no reject or disconnect event"
  - "False WWebJS Chromium standby wakeups during host WAN/internet outages"
  - "Message drop on transient driver errors before failover completes"
---

# [k-005] Baileys Silent Socket Hang, Host WAN Guard and Dead Letter Queue

## Problem / Symptom

1. **Silent Baileys Socket Stalls:** When upstream WhatsApp WebSocket connections drop without a TCP FIN/RST or clean protocol closure (e.g. NAT timeouts, router dropouts), `@whiskeysockets/baileys` may fail to detect the broken socket immediately. Calls to `sock.sendMessage()` return a Promise that remains pending indefinitely, stalling queue workers and preventing failover triggers.
2. **False Standby Wakeups during Host WAN Outages:** When the host server loses general WAN internet connectivity, the primary driver fails. If the orchestrator reacts by triggering failover to WWebJS, Chromium will launch and consume 500+ MB RAM only to also fail connecting, causing useless thrashing and CPU spikes.
3. **Transient Message Loss in BLPOP Consumers:** Once a message is popped from Redis via `BLPOP`, any subsequent throw inside driver dispatch permanently loses the message unless explicitly re-queued or routed to a Dead-Letter Queue (DLQ).

---

## Approved Solution

### 1. Deterministic Socket Send Timeout

Race `sock.sendMessage` against a configurable timer (`SEND_MESSAGE_TIMEOUT_MS`, default 15s) and cleanly clear the timer in a `finally` block:

```typescript
let timer: NodeJS.Timeout | undefined;
try {
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BaileysSendTimeoutError(this.sendMessageTimeoutMs));
    }, this.sendMessageTimeoutMs);
    timer.unref?.();
  });

  const sendPromise = this.socket.sendMessage(targetJid, baileysContent);
  const sent = await Promise.race([sendPromise, timeoutPromise]);
  return { id: sent?.key?.id ?? randomUUID(), to, timestamp: Date.now(), status: "SENT" };
} finally {
  if (timer) clearTimeout(timer);
}
```

### 2. Host WAN Connectivity Guard

Before tripping into `FENCING` and launching Puppeteer, probe host WAN connectivity (e.g. `checkHostConnectivity` via DNS lookup to `dns.google`):

```typescript
if (this.enableHostConnectivityGuard) {
  const isOnline = await this.hostConnectivityProbe();
  if (!isOnline) {
    logger.warn({ reason }, "Host WAN connectivity probe failed; suppressing failover to WWebJS standby");
    return;
  }
}
```

### 3. Zero-Loss Re-Queueing & Dead-Letter Queue (DLQ)

Track message retry attempts. For transient dispatch errors where `retryCount + 1 < maxSendRetries`, re-enqueue the payload into `outboundQueueKey` (`whatsapp:send:priority`). If retries are exhausted or payloads are malformed, push to `dlqQueueKey` (`whatsapp:send:dlq`) with rich diagnostic metadata (`dlqReason`, `dlqTimestamp`, `retryCount`).
