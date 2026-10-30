# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### [04.4] Next Feature / Hardening Milestone (Awaiting User Scope)

**Status:** `READY FOR PLANNING`
**Objective:** All tasks in Epic `04.x` (`[04.1]` Multi-Tier Outbound Queue & Typing Presence, `[04.2]` Automated Session Purge & QR Regeneration on Companion Logout, and `[04.3]` VictoriaLogs Canonical NDJSON Logging & Docker Hygiene) are complete and verified. Awaiting user scope for the next feature or explicit release instruction.

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
| [90.4] | Shutdown Lifecycle Ordering & Buffer Safety | [`1e70ce7`] | 2026-10-29 |
| [90.5] | Observability & Prometheus Metrics Exporter | [`8a10ca6`] | 2026-10-29 |
| [90.6] | Dynamic Chromium Health & Standby Puppeteer Restart Recovery | [`a6bb283`] | 2026-10-29 |
| [90.7] | End-to-End Load & Sustained Queue Concurrency Verification | [`184a6ed`] | 2026-10-29 |
| [90.8] | Soak Test & Long-Running Memory Leak Audit | [`59739d7`] | 2026-10-29 |
| [04.1] | Multi-Tier Outbound Queue, Priority Jitter Delays & Typing Presence | [`687006a`] | 2026-10-30 |
| [04.2] | Automated Session Purge & QR Regeneration on Companion Logout | [`0e09b8e`] | 2026-10-30 |
| [04.3] | VictoriaLogs Canonical NDJSON Logging & Docker Hygiene | [`3f1973b`] | 2026-10-30 |

---

## Backlog (Upcoming, in priority order)

*(No pending items in current epic)*

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
