---
author_type: human
author: Architecture Team
reviewed_by: Human Lead
date: 2026-10-27
status: accepted
type: architectural-decision-log
---

# Architectural Decisions Log

> 🏛️ **Progressive Disclosure:** Historical and cumulative decisions live here so AI agents do not load them into working context on every interaction.
> Active runtime contracts stay in [`.agent/NOTES.md`](../../.agent/NOTES.md).

---

## Cumulative Decisions

### [2026-10-27] Dual-Engine Active-Passive Failover Architecture (Baileys Primary + WWebJS Standby)

- **Context:**
  - WhatsApp automations face two opposing trade-offs:
    1. **Baileys:** Extremely lightweight (~50–100 MB RAM) and fast (direct WebSocket with Protobufs), but prone to complete downtime when WhatsApp changes web protocol handshake details before open-source community patches arrive.
    2. **whatsapp-web.js (Puppeteer):** Heavyweight (~400–800 MB RAM per Chromium instance) and slower, but resilient against protocol deprecations because it evaluates WhatsApp Web's official production JavaScript bundles directly.
- **Decision:**
  - Implement an **Active-Passive Hybrid Gateway** with Baileys as primary and WWebJS as cold-standby fallback.
  - Baileys handles 100% of standard traffic in steady state.
  - A Circuit Breaker monitors consecutive socket drops, protocol rejections, and timeouts. Upon reaching $N$ consecutive failures (default: 3 to 5), it initiates an automated failover.
  - WWebJS is cold-started on demand (accepting a 15–30s transition delay over total platform outage).
  - While operating in fallback mode, a background silent probe verifies Baileys recovery. Once Baileys remains stable for a continuous healthy window, the orchestrator drains WWebJS, terminates Chromium to reclaim RAM, and restores Baileys as primary.
- **Alternatives Considered:**
  - *Single Engine (Baileys only or WWebJS only):* Rejected. Baileys alone risks downtime during protocol updates; WWebJS alone wastes heavy system resources 24/7.
  - *Hot Standby Chromium (WWebJS running concurrently):* Rejected. Defeats the resource efficiency goal by keeping Chromium running continuously in the background.
  - *Runtime Session State Conversion (sharing keys between Baileys and WWebJS):* Rejected. Signal Protocol cryptographic ratchets and session keys diverge immediately inside IndexedDB. Sharing or converting in runtime causes `Bad MAC` and decryption failures.
- **Consequences:**
  - Requires pairing **two distinct companion device sessions** on the same WhatsApp account (one for Baileys, one for WWebJS).
  - Outbound dispatches during the cold-start window (15–30s) are queued in Redis and drained once the fallback engine reaches `READY`.

---

### [2026-10-27] Anti-Fingerprinting Standby Keep-Alive with Jitter and Dynamic Text

- **Context:**
  - WhatsApp automatically logs out linked companion devices that remain inactive without network traffic for more than 14 to 30 days.
  - Because WWebJS operates as cold-standby, it risks silent session revocation if the primary engine runs smoothly for weeks.
  - Static periodic pings (e.g., fixed cron at identical intervals with static text) are easily fingerprinted by Meta's anti-abuse heuristics.
- **Decision:**
  - Implement a **Standby Maintenance Daemon** that periodically wakes WWebJS.
  - The schedule incorporates **randomized jitter**: triggers every 3 to 5 days at diffuse off-peak hours (e.g., between 02:30 and 05:40 local time).
  - The keep-alive routine connects WWebJS, simulates presence (`composing`), generates dynamic, non-repeating text (via Markov chain or template generator), dispatches the message to the bot's own self-chat / notes JID, maintains the session active for 2 minutes to advance cryptographic ratchets, and gracefully calls `client.destroy()` to kill Chromium and release memory.
- **Alternatives Considered:**
  - *Fixed 7-day Cron Job with static ping:* Rejected due to anti-bot fingerprinting risks.
  - *Manual session re-pairing:* Rejected. Requires human intervention and breaks autonomous operation.
- **Consequences:**
  - Temporary RAM spike (~400 MB) for ~2 minutes during maintenance windows, occurring strictly in low-traffic hours.

---

### [2026-10-27] Fencing and Split-Brain Elimination

- **Context:**
  - In an active-passive failover system, connection flapping can lead to "split-brain", where both engines believe they are active, causing duplicate inbound message ingestion and duplicate outbound replies.
- **Decision:**
  - **Hard Fencing (Kill before Promote):** The primary engine is explicitly disconnected and disarmed (`socket.end()`, listeners stripped) before the fallback engine is allowed to bind to ingress/egress queues.
  - **Exclusive Consumer Lock:** Queue consumption (`whatsapp:send:priority`) is strictly single-consumer via Redis lock `gateway:active_engine`. The standby engine never executes `BLPOP` while inactive.
  - **Inbound Deduplication:** Inbound messages pass through an atomic Redis deduplication filter (`dedupe:msg:<hash>` with a 300-second TTL) using `SET NX EX`. Any duplicate event delivered by both companion devices during engine transition is silently dropped.
- **Alternatives Considered:**
  - *Dual active listeners with client-side deduplication only:* Rejected. Increases network bandwidth and token processing costs in downstream workers.
- **Consequences:**
  - Redis is a hard requirement for distributed fencing and message deduplication.

---

### [2026-10-27] Resilient Deduplication Hashing with 10-Second Time Buckets and Media Digests

- **Context:**
  - When both companion devices receive an identical message during an engine switch or reconnection burst, the message timestamps reported by WhatsApp Web and Baileys may differ by 1 to 2 seconds due to network transmission latency.
  - Furthermore, non-text messages (audio, image, document) lack a direct text body for hash calculation.
- **Decision:**
  - Calculate deduplication hashes using a normalized SHA-256 digest:
    $$\text{hash} = \text{SHA256}(\text{remoteJid} + \text{senderJid} + (\text{textBody} \parallel \text{mediaDigest}) + \lfloor\text{timestamp} / 10\rfloor)$$
  - Timestamp grouping into 10-second buckets absorbs cross-device clock jitter while preventing duplicate message ingestion.
  - Non-text media must use SHA-256 digest of media content or canonical WhatsApp media file SHA-256 identifier.
- **Alternatives Considered:**
  - *Strict exact-second timestamp hash:* Rejected due to false-negative deduplication when clock skew exists across sockets.
  - *WhatsApp Message ID only (`id._serialized`):* Rejected as Baileys and WWebJS occasionally produce divergent client envelope IDs for certain system and forwarded messages.
- **Consequences:**
  - Requires normalizing incoming messages into a canonical payload before evaluating deduplication filters.

---

### [2026-10-27] Dual-Session QR Architecture, Independent Auth Storage, and Health Observability

- **Context:**
  - The gateway operates two companion device connections linked to the same phone number.
  - Operators must pair each session independently without ambiguity.
  - Auth sessions must survive container restarts without state corruption or permission conflicts.
- **Decision:**
  - Separate QR pairing endpoints into dedicated routes: `GET /qr/baileys` and `GET /qr/wwebjs`, returning raw QR strings or SVG payloads alongside pairing state (`UNPAIRED`, `PAIRING_QR_READY`, `CONNECTED`, `STANDBY`).
  - Provide a unified `GET /health` endpoint exposing granular health status for both engines individually (`primary_engine`, `standby_engine`, `active_role`).
  - Store credentials in segregated local volume directories: `/data/auth/baileys` and `/data/auth/wwebjs` with strict filesystem permissions (`0700`).
- **Alternatives Considered:**
  - *Single multiplexed /qr endpoint:* Rejected because operators cannot determine which engine session they are scanning.
- **Consequences:**
  - Operator onboarding requires two consecutive QR scans during initial provisioning.

---

### [2026-10-27] Containerized Chromium Process Lifecycle, Zombie Mitigation, and Docker Hygiene

- **Context:**
  - Running Puppeteer / Chromium inside Docker containers carries risk of OOM crashes due to `/dev/shm` exhaustion and zombie processes after `client.destroy()`.
- **Decision:**
  - Adopt Docker and Puppeteer execution hygiene aligned with `whatsapp-api`:
    - Mount `/dev/shm` with minimum 2GB (`shm_size: 2gb`) or pass `--disable-dev-shm-usage`.
    - Mandatory Chromium flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--no-first-run`, `--no-zygote`.
    - Container entrypoint MUST execute through an init supervisor (`tini` or `dumb-init`) to reap zombie processes.
    - Orchestrator teardown logic MUST execute process tree termination (`process.kill(-pid, 'SIGKILL')`) if Chromium does not exit cleanly within 5 seconds of `client.destroy()`.
- **Alternatives Considered:**
  - *Relying solely on `client.destroy()` without process tree kill:* Rejected as Chromium browser processes occasionally linger in orphan state.
- **Consequences:**
  - Docker Compose configuration and container images require explicit `init: true` and appropriate volume/flag configurations.
