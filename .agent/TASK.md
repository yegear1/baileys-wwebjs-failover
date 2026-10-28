# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### 📌 Task [01.4]: Failover Orchestrator & Circuit Breaker FSM

- **Description:** Implement the Failover Orchestrator managing runtime finite state machine (`PRIMARY_ACTIVE`, `FENCING`, `COLD_START_STANDBY`, `FALLBACK_ACTIVE`, `MAINTENANCE_KEEPALIVE`, `RECOVERY_SWAP`), sliding error window for trip detection, hard fencing locks, cold-start standby promotion, and silent probe failback.
- **Systems Involved:** `orchestrator`, `circuit-breaker`, `fsm`, `driver`
- **Action Type:**
  - [ ] Read-only / Documentation
  - [x] Source code changes
- **Status:** READY FOR PLANNING
  *(Workflow: `READY FOR PLANNING` → `PLANNING` on presenting plan → approval → `RUNNING`)*

### Acceptance Criteria
- [ ] Implement `FailoverOrchestrator` managing the FSM lifecycle states recorded in `.agent/NOTES.md`.
- [ ] Implement `CircuitBreaker` sliding failure window (3–5 consecutive failures within configurable window).
- [ ] Fencing protocol: disconnect and isolate failing engine before promoting standby.
- [ ] Standby promotion: cold-start `WWebJSDriver.connect()` and buffer outbound queues during startup window.
- [ ] Silent probe failback: background verification of primary socket stability before draining standby and switching back.
- [ ] Complete unit and integration tests with deterministic state machine verification.
- [ ] Strict type checking passing with zero `any` (`pnpm typecheck` exits 0).
- [ ] Automated tests passing (`pnpm test` exits 0).
- [ ] Linter and format checks passing (`pnpm lint` exits 0).
- [ ] Build passes cleanly (`pnpm build` exits 0).

---

## Completed Tasks Log

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [00.0] | Initial scaffolding (ADD greenfield template) | [`1d2d385`] | 2026-10-27 |
| [00.1] | Project Bootstrap, Tooling & Strict TypeScript Stack | [`dabe627`] | 2026-10-27 |
| [01.1] | Common Driver Interface & Resilient Deduplication Schemas | [`90e520e`] | 2026-10-27 |
| [01.2] | Baileys Primary Engine Adapter & Dedup Hash Integration | [`6ebada6`] | 2026-10-28 |
| [01.3] | WWebJS Standby Engine Adapter & Container Hygiene | [`bd2aa75`] | 2026-10-28 |

---

## Backlog (Upcoming, in priority order)

- [ ] **[01.5]** **Standby Maintenance Daemon** — Implement anti-fingerprinting keep-alive cron with jittered schedule (3–5 days), typing presence simulation, and self-chat dispatches.
- [ ] **[01.6]** **Redis Queue Integration & Deduplication Lock** — Connect to `whatsapp:receive:inbox` and `whatsapp:send:priority` with atomic Redis deduplication lock (`SET NX EX 300`).
- [ ] **[02.1]** **Dual-Device QR Pairing & Granular Health API** — HTTP endpoints for pairing both sessions independently (`GET /qr/baileys`, `GET /qr/wwebjs`) and reporting multi-engine health (`GET /health`).

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
