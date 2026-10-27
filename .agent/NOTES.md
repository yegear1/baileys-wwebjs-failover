# NOTES.md — Active Contracts and Runtime Memory

> Stores active runtime contracts (WHAT interacts with WHAT), live communication topology, and critical gotchas.
> Historical architectural decisions live in [`docs/adr/decisions.md`](../docs/adr/decisions.md).

---

## How to Use this File

1. **Read before planning:** Active contracts and gotchas here take precedence over unstated defaults.
2. **Keep this file lean:** Only store ACTIVE contracts, live topology, open technical debt, and critical gotchas.
3. **Architectural decisions:** Record in [`docs/adr/decisions.md`](../docs/adr/decisions.md). Do NOT accumulate historical decisions here to prevent context bloat.

---

## Active Contracts

### 1. Engine & Orchestrator Lifecycle States

The Failover Orchestrator operates as a strict finite state machine (FSM):

| State | Primary (Baileys) | Standby (WWebJS) | Outbound Queue (`BLPOP`) | Notes |
|---|---|---|---|---|
| `PRIMARY_ACTIVE` | Running / Connected | Sleeping (Chromium terminated) | Bound to Baileys | Steady state (90%+ of runtime) |
| `FENCING` | Disconnecting / Killed | Dormant | Paused / Buffered in Redis | Triggered by 3–5 consecutive failures |
| `COLD_START_STANDBY` | Dead | Launching Puppeteer (~15–30s) | Paused / Buffered in Redis | Transition window |
| `FALLBACK_ACTIVE` | Silent Probe (Isolated Socket) | Running / Connected | Bound to WWebJS | Outbound restored; Baileys probing |
| `MAINTENANCE_KEEPALIVE` | Running / Connected | Temporary Wakeup (~2 min) | Bound to Baileys | Periodic anti-expiration keep-alive |
| `RECOVERY_SWAP` | Restoring Active Listeners | Draining & Destroying Chromium | Bound to Baileys | Failback complete; RAM released |

---

### 2. Common Driver Interface (`IWhatsAppDriver`)

Both engine adapters must implement the identical contract:

```typescript
export interface IWhatsAppDriver {
  readonly name: "baileys" | "wwebjs";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onStatusChange(handler: (status: EngineStatus) => void): void;
  getStatus(): EngineStatus;
}
```

---

### 3. Redis Messaging & Fencing Contracts

| Channel / Key | Role | Type | TTL / Contract | Notes |
|---|---|---|---|---|
| `gateway:active_engine` | Distributed Fencing Lock | String (`"baileys"` \| `"wwebjs"`) | Managed by Orchestrator | Prevents split-brain consumption |
| `dedupe:msg:<hash>` | Inbound Deduplication | Key flag (`"1"`) | 300 seconds (`EX 300`) | At-most-once processing filter |
| `whatsapp:receive:inbox` | Normalized Incoming Messages | Redis Queue (`LPUSH`) | `InboundMessagePayload` | Consumed by downstream workers |
| `whatsapp:send:priority` | Outbound Message Dispatch | Redis Queue (`BLPOP`) | `SendMessagePayload` | Consumed strictly by active engine |

---

## Critical Gotchas & Pitfalls

- **Multi-Device Ratchet Desynchronization:** Baileys and WWebJS cannot share or hot-swap the same authentication credentials. They MUST be paired as two independent companion devices on the same phone.
- **WWebJS Chromium Cold-Start Delay:** Launching Puppeteer, passing browser sandbox validation, navigating to WhatsApp Web, and waiting for script injection takes **15 to 35 seconds**. Outbound queues will buffer during this window.
- **WhatsApp Idle Companion Expiration:** Linked devices with zero network activity for 14+ days are silently unlinked by WhatsApp. Standby daemon must run keep-alives every 3–5 days with randomized jitter.
- **Memory Reclaim on Failback:** Simply disconnecting WWebJS leaves Chromium child processes zombie/active in memory. The orchestrator must explicitly call `client.destroy()` and guarantee `SIGTERM` to free the 500+ MB RAM.

---

## Deliberate Technical Debt

| Debt | Rationale | Revisit When |
|---|---|---|
| Inbound deduplication via Redis hash key | Hash of `remoteJid + timestamp + body` handles 99.9% of failover overlaps without complex vector clocks. | If identical messages are legitimately sent within 5 minutes by the same user. |
| Cold-start delay on failover | Accepting a 15–30s delay during failover eliminates the continuous 500 MB RAM overhead of a hot-standby browser. | If sub-second failover SLA becomes a mandatory business requirement. |
