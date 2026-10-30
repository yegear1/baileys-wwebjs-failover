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
| `SHUTDOWN` | Disconnected / Disposed | Disconnected / Destroyed | Drained / Re-queued | Terminal lifecycle state |

---

### 2. Common Driver Interface (`IWhatsAppDriver`)

Both engine adapters must implement the identical contract:

```typescript
export interface IWhatsAppDriver {
  readonly name: "baileys" | "wwebjs";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt>;
  sendPresence?(to: string, state: PresenceState): Promise<void>;
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
| `whatsapp:send:priority` | Priority Outbound Dispatch | Redis Queue (`BLPOP`) | `SendMessagePayload` (`urgent` \| `normal`) | Drained strictly before low-priority queue |
| `whatsapp:send:low` | Low-Priority Outbound Dispatch | Redis Queue (`BLPOP`) | `SendMessagePayload` (`low`) | Consumed when priority queue is empty |
| `whatsapp:send:dlq` | Dead Letter Queue | Redis Queue (`LPUSH`) | Exhausted / malformed payloads | Unroutable messages after 3 retries |

**Deduplication Hash Algorithm:**
$$\text{hash} = \text{SHA256}(\text{remoteJid} + \text{senderJid} + (\text{textBody} \parallel \text{mediaDigest}) + \lfloor\text{timestamp} / 10\rfloor)$$
* Absorbs $\pm 5\text{s}$ cross-device socket clock skew.
* Media messages use content SHA-256 or WhatsApp file hash instead of empty body.

**Outbound Reliability, Anti-Ban Jitter & WAN Invariants:**
* Baileys send operations race against a deterministic 15s timeout (`SEND_MESSAGE_TIMEOUT_MS`).
* Multi-tier outbound worker executes `BLPOP` across `[whatsapp:send:priority, whatsapp:send:low]`, enforcing randomized anti-ban dispatch delays (`urgent`: 300–800ms, `normal`: 1500–3500ms, `low`: 10000–20000ms) and proportional `composing` presence before message dispatch.
* Transient outbound dispatch failures are re-queued to their originating queue key up to `MAX_SEND_RETRIES` (default: 3) before routing to `DLQ_QUEUE_KEY`.
* Host network WAN connectivity probe validates internet reachability prior to WWebJS standby activation, preventing false failover during host internet outages.
* Shutdown lifecycle ordering drains and cancels in-flight orchestrator buffer items before worker shutdown, safely re-queueing to Redis without retry penalty or DLQ escalation to prevent deadlocks on exit.
* Circuit breaker consecutive failure counter strictly tracks unexpired errors within the sliding window, guaranteeing consistent decay under sustained errors, intermittent bursts, or idle periods.
* Outbound queue worker pauses BLPOP dequeuing during failover transitions (`FENCING`, `COLD_START_STANDBY`, `RECOVERY_SWAP`), persisting burst messages safely in Redis with zero loss across failover switches.
* Dynamic timer and listener hygiene: `runWithTimeout` cancels timeout races upon resolution; `RedisOutboundWorker` clears wakeup and backoff timers on pause/stop; `FailoverOrchestrator` clears listener sets on shutdown; `GatewayApplication` deregisters OS signal handlers on stop, guaranteeing bounded heap delta and zero dangling handles across repeated lifecycle loops.

---

### 4. HTTP Observability & QR Pairing Contracts

| Endpoint | Method | Response Payload | Description |
|---|---|---|---|
| `/health` | `GET` | `{ status: "ok" \| "degraded" \| "down", active_engine: "baileys" \| "wwebjs", primary: EngineStatusDto, standby: EngineStatusDto }` | Granular multi-engine health check |
| `/metrics` | `GET` | `text/plain; version=0.0.4` | Prometheus metrics exporter (`failover_events_total`, `outbound_buffer_depth`, `engine_status`, `queue_length`, `dlq_messages_total`, `engine_latency_seconds`, `chromium_restarts_total`) |
| `/qr/baileys` | `GET` | `{ engine: "baileys", status: "UNPAIRED" \| "PAIRING_QR_READY" \| "CONNECTED", qr_raw?: string, qr_svg?: string }` | Dedicated QR code for primary session |
| `/qr/wwebjs` | `GET` | `{ engine: "wwebjs", status: "UNPAIRED" \| "PAIRING_QR_READY" \| "STANDBY" \| "CONNECTED", qr_raw?: string, qr_svg?: string }` | Dedicated QR code for standby session |

**VictoriaLogs NDJSON Logging Contract:**
- `createGatewayLogger()` emits single-line NDJSON on `stdout` (`NO_COLOR=1`, zero pretty-printers) with root `timestamp` (ISO-8601 UTC), lowercase `level` (`debug`, `info`, `warn`, `error`), `service`, `app`, `env`, and `message`. High-cardinality identifiers (JIDs, message IDs, request IDs) are strictly event-level properties, never stream labels.

---

### 5. Auth Storage & Chromium Hygiene Contracts

- **Storage Segregation:**
  - Baileys credentials: `/data/auth/baileys` (multi-file auth state).
  - WWebJS session: `/data/auth/wwebjs` (Chromium user data dir).
  - Directory permissions enforced on startup: `0700` (`rwx------`).
  - Companion logout auto-purge (`purgeAuthDirectory`): Wipes invalidated child entries while preserving the volume bind-mount root and `0700` permissions on explicit companion logout (`DisconnectReason.loggedOut` / 401 in Baileys or `LOGOUT` / `NAVIGATION` / `auth_failure` in WWebJS), automatically regenerating a fresh Baileys pairing QR (`PAIRING_QR_READY`) and immediately failing over to standby if primary is unlinked.
- **Chromium Docker Hygiene (aligned with `whatsapp-api`):**
  - Flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--no-first-run`, `--no-zygote`.
  - Process teardown: `client.destroy()` followed by tree kill (`process.kill(-pid, 'SIGKILL')`) if not exited within 5 seconds.
  - Container environment: Requires `init: true` (tini/dumb-init) and `shm_size: 2gb` minimum in Compose.
  - Stale lock cleanup: Recursively removes orphaned `SingletonLock`, `SingletonCookie`, and `SingletonSocket` files on launch and standby teardown.
  - Dynamic health probe: Inspects OS process liveness (`process.kill(pid, 0)`), zombie state in `/proc/${pid}/status`, CDP session status (`pupBrowser.isConnected()`), and page execution responsiveness (`pupPage.evaluate()`).
  - Standby restart recovery: Gracefully restarts Chromium up to 3 times with exponential backoff on crash/zombie detection, while orchestrator buffers outbound messages during `DEGRADED` state.
- **Standby Keep-Alive Rules:**
  - Jittered cron: runs every 3–5 days during quiet off-peak hours (02:30–05:40).
  - Recipient: strictly the bot's own self-chat / notes JID (`toMe`).
  - Simulation: dispatches typing presence (`composing`) for 3–5 seconds before sending dynamic text.

---

## Critical Gotchas & Pitfalls

- **Multi-Device Ratchet Desynchronization:** Baileys and WWebJS cannot share or hot-swap the same authentication credentials. They MUST be paired as two independent companion devices on the same phone.
- **WWebJS Chromium Cold-Start Delay:** Launching Puppeteer, passing browser sandbox validation, navigating to WhatsApp Web, and waiting for script injection takes **15 to 35 seconds**. Outbound queues will buffer during this window.
- **WhatsApp Idle Companion Expiration:** Linked devices with zero network activity for 14+ days are silently unlinked by WhatsApp. Standby daemon must run keep-alives every 3–5 days with randomized jitter strictly to self-chat.
- **Memory Reclaim on Failback:** Simply disconnecting WWebJS leaves Chromium child processes zombie/active in memory. The orchestrator must explicitly call `client.destroy()` and guarantee process-tree `SIGKILL` to free the 500+ MB RAM.

---

## Deliberate Technical Debt

| Debt | Rationale | Revisit When |
|---|---|---|
| Inbound deduplication via 10s bucket SHA256 | Hash with 10s timestamp bucket handles 99.99% of failover overlaps without complex distributed vector clocks. | If identical messages legitimately arrive from the same sender within 10 seconds. |
| Cold-start delay on failover | Accepting a 15–30s delay during failover eliminates the continuous 500 MB RAM overhead of a hot-standby browser. | If sub-second failover SLA becomes a mandatory business requirement (can switch to Warm-Standby). |
