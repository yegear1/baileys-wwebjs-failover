# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### [90.4] Shutdown Lifecycle Ordering & Buffer Safety

**Status:** PLANNING
**Objective:** Ensure `orchestrator.shutdown()` cancels/rejects in-flight buffer before or during worker shutdown to prevent deadlock on exit, and ensure `CircuitBreaker.consecutiveFailures` window decay consistency.

**Plan:**
1. Shutdown Lifecycle Ordering & Buffer Drain:
   - Audit `orchestrator.shutdown()` and `gateway.ts` shutdown sequence.
   - When the orchestrator enters `SHUTDOWN`, reject or drain pending buffer items with a descriptive cancellation error so callers do not hang indefinitely awaiting transitions that will never happen.
2. Circuit Breaker Failure Window Decay:
   - Verify `CircuitBreaker.consecutiveFailures` window decay consistency and reset mechanics under sustained error vs idle periods.
3. Tests & Verification:
   - Add unit/lifecycle tests for shutdown buffer drainage without hanging promises and circuit breaker decay consistency.

---

## Completed Tasks Log

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [00.0] | Initial scaffolding (ADD greenfield template) | [`1d2d385`] | 2026-10-27 |
| [00.1] | Project Bootstrap, Tooling & Strict TypeScript Stack | [`dabe627`] | 2026-10-27 |
| [01.1] | Common Driver Interface & Resilient Deduplication Schemas | [`90e520e`] | 2026-10-27 |
| [01.2] | Baileys Primary Engine Adapter & Dedup Hash Integration | [`6ebada6`] | 2026-10-28 |
| [01.3] | WWebJS Standby Engine Adapter & Container Hygiene | [`bd2aa75`] | 2026-10-28 |
| [01.4] | Failover Orchestrator & Circuit Breaker FSM | [`eb3d96b`] | 2026-10-28 |
| [01.5] | Standby Maintenance Daemon & Anti-Fingerprinting Keep-Alive | [`289fc9a`] | 2026-10-28 |
| [01.6] | Redis Queue Integration & Deduplication Lock | [`0ef28c3`] | 2026-10-28 |
| [02.1] | Dual-Device QR Pairing & Granular Health API | [`632eb2b`] | 2026-10-28 |
| [02.2] | Container Orchestration & Production Compose Stack | [`18ad2d5`] | 2026-10-28 |
| [03.1] | End-to-End Gateway Integration & Service Bootstrap | [`63eb7d4`] | 2026-10-28 |
| [03.2] | E2E Smoke & Resilience Verification | [`7067936`] | 2026-10-29 |
| [03.3] | Zero-Loss Outbound Re-queue, Dead-Letter Queue & Host Connectivity Guard | [`9ad0485`] | 2026-10-29 |
| [90.1] | Hermetic Redis Test Fallback & E2E Resilience Decoupling | [`8485c62`] | 2026-10-29 |
| [90.2] | Driver Stability & Lifecycle Hardening | [`917937d`] | 2026-10-29 |
| [90.3] | Atomic Lua Deduplication & Media Digest Parity | [`07f4807`] | 2026-10-29 |

---

## Backlog (Upcoming, in priority order)

- [90.5] Observability & Prometheus Metrics Exporter
  - Export real-time Prometheus metrics endpoint (`/metrics`) for failover count, engine latencies, buffer depth, and DLQ counters.

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
