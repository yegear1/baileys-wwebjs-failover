# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### [05.3] Resilient Failback Orchestration, Circuit Breaker Isolation & Manual Failback API

**Status:** `DONE`
**Objective:** Resolve failback lockup where outbound dispatches during `FALLBACK_ACTIVE` incorrectly reset the primary circuit breaker, decouple silent probe stability verification from circuit breaker state, and expose a dedicated administrative `POST /failback` HTTP route.

**Systems Involved:** `src/fsm/orchestrator.ts`, `src/fsm/circuit-breaker.ts`, `src/http/server.ts`, `tests/`

#### Key Deliverables:
1. **Primary Circuit Breaker Isolation:**
   - In `FailoverOrchestrator.sendMessage()`, only record circuit breaker successes (`recordSuccess()`) when `currentDriver.name === "baileys"`.
   - Prevent successful dispatches by standby engine (`wwebjs`) in `FALLBACK_ACTIVE` from prematurely resetting the primary circuit breaker to `CLOSED`.
2. **Deterministic Silent Probe Stability Verification:**
   - Decouple failback trigger in `executeSilentProbe()` so that consecutive successful health probes on primary driver reliably trigger recovery swap (`triggerFailback`) after N consecutive successes (default: 3 probes, 30s) regardless of whether circuit breaker was reset.
3. **Administrative Manual Failback Endpoint:**
   - Expose `POST /failback` on Gateway HTTP server (`src/http/server.ts`).
   - Validates that primary is healthy/connected, initiates `triggerFailback("Manual failback requested via HTTP endpoint")`, and returns transition status. If primary is disconnected/unpaired, returns `409 Conflict`.
4. **Hermetic Test Coverage:**
   - Vitest suite in `tests/fsm-failback.test.ts` or `tests/orchestrator.test.ts` verifying:
     - Dispatches in `FALLBACK_ACTIVE` do not mutate primary circuit breaker.
     - Silent probe stability count triggers automatic `triggerFailback`.
     - `POST /failback` initiates manual recovery swap and returns appropriate HTTP status codes.

#### Acceptance Criteria:
- [ ] `pnpm test` exits 0 (all unit & integration tests pass).
- [ ] `pnpm run lint` exits 0 (zero biome diagnostics).
- [ ] `pnpm run build` exits 0 (zero TypeScript strict errors).
- [ ] `git diff --check` exits 0.

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
| [04.4] | Contract Parity with Services/Brain (Stickers, Base64 Media & Reactions) | [`7a3a131`] | 2026-11-02 |
| [05.1] | On-Demand Detached Pairing Lifecycle for Standby WWebJS | [`76df80f`] | 2026-11-02 |
| [05.2] | Inbound Media Buffers, Quoted Context & Retry Circuit Breaker Hardening | [`9d1f700`] | 2026-11-02 |
| [05.3] | Resilient Failback Orchestration, Circuit Breaker Isolation & Manual Failback API | [`b8c5a01`] | 2026-11-02 |

---

## Backlog (Upcoming, in priority order)

> Tag pre-approved tasks having strictly disjoint file scopes with `[APPROVED]` `[PARALLEL: W1]` and `Paths: ...` for concurrent `task-queue` execution.


*(No pending items in current epic)*

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
