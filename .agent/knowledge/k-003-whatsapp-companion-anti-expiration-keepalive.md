---
id: "k-003"
title: "WhatsApp Companion Session Idle Expiration and Anti-Fingerprinting Keep-Alive"
date: 2026-10-28
tags:
  - "wwebjs"
  - "keepalive"
  - "anti-fingerprinting"
  - "companion"
  - "jitter"
severity: "high"
affected_components:
  - "src/maintenance/daemon.ts"
  - "src/maintenance/jitter.ts"
  - "src/maintenance/payload.ts"
  - "src/fsm/orchestrator.ts"
symptoms:
  - "Standby WWebJS companion session silently unlinked/revoked by WhatsApp after 14 days of idle standby"
  - "Fixed-schedule bot heartbeats detected and flagged by WhatsApp anti-spam heuristics"
---

# [k-003] WhatsApp Companion Session Idle Expiration and Anti-Fingerprinting Keep-Alive

## Problem / Symptom

1. **Idle Companion Device Revocation:**
   WhatsApp server infrastructure enforces an automatic 14-day inactivity timeout on linked companion devices. If a companion session (such as the cold-standby WWebJS engine) establishes zero network socket activity and dispatches no messages for 14 consecutive days, the session token is revoked server-side. When primary fails over after 14 days, the standby engine fails to authenticate, yielding unrecoverable `UNPAIRED` status.

2. **Robotic Heartbeat Fingerprinting:**
   Simple cron jobs executing at exact fixed intervals (e.g. every 24 hours at 00:00:00) sending static ping strings (e.g., `"ping"` or `"keepalive"`) trigger WhatsApp automated abuse and bot telemetry detectors, risking companion disconnection or phone number bans.

---

## Approved Solution

1. **Jittered Scheduling within Quiet Hours:**
   - Execute keep-alive cycles every 3 to 5 days with uniform randomized day offset ($D \in [3, 5]$).
   - Constrain execution strictly to off-peak quiet hours between **02:30 and 05:40 local time** (190-minute window) to emulate background synchronization.

2. **Typing Presence Simulation:**
   - Emit `composing` state to the socket prior to dispatch.
   - Maintain composing presence for a randomized duration between **3,000 ms and 5,000 ms**.
   - Clear state with `paused` after message dispatch.

3. **Dynamic Self-Chat Only (`toMe`):**
   - Target recipient strictly to own companion self-chat JID (`toMe`), never external contacts or group chats.
   - Disallow static strings: embed unique monotonic sequence numbers, ISO timestamps, cryptographic nonces, and rotated templates.

4. **Lifecycle Coordination & Memory Teardown:**
   - Standby daemon coordinates with `FailoverOrchestrator` via `enterMaintenanceKeepalive()` and `exitMaintenanceKeepalive()`.
   - Standby Chromium browser is launched on-demand (~15–30s) and immediately terminated with hard process-tree SIGKILL upon cycle completion to prevent 500+ MB resident RAM bloat.

---

## What NEVER to Do
- ❌ **Anti-Pattern:** Running companion keep-alives at deterministic fixed intervals (e.g., standard cron `0 3 * * *`).
  - *Why:* Trivial for server heuristics to classify as automated bot traffic.
- ❌ **Anti-Pattern:** Sending keep-alive pings to external phone numbers or groups.
  - *Why:* Pollutes real chat histories and risks recipient spam reports.
- ❌ **Anti-Pattern:** Leaving the standby Chromium instance running after the keepalive completes.
  - *Why:* Violates cold-standby memory hygiene, consuming 500+ MB of container RAM indefinitely.

---

## Verification
```bash
pnpm test tests/maintenance-daemon.test.ts
```
