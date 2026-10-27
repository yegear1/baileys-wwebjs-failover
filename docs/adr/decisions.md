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
