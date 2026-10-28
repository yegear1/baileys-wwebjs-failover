# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### 📌 Task [01.5]: Standby Maintenance Daemon

- **Description:** Implement the Standby Maintenance Daemon running an anti-fingerprinting keep-alive scheduler with randomized jitter (3–5 days) during quiet hours (02:30–05:40), simulated typing presence, dynamic self-chat dispatches, and teardown releasing Chromium memory.
- **Systems Involved:** `maintenance`, `daemon`, `orchestrator`, `driver`
- **Action Type:**
  - [ ] Read-only / Documentation
  - [x] Source code changes
- **Status:** READY FOR PLANNING
  *(Workflow: `READY FOR PLANNING` → `PLANNING` on presenting plan → approval → `RUNNING`)*

### Acceptance Criteria
- [ ] Implement `StandbyMaintenanceDaemon` managing scheduled keep-alive cycles for WWebJS.
- [ ] Jittered scheduling: triggers every 3 to 5 days at randomized off-peak windows (02:30–05:40 local time).
- [ ] Typing presence simulation: dispatches `composing` state for 3–5 seconds before dispatching text.
- [ ] Dynamic payload generation: generates non-repeating dynamic messages targeted strictly to self-chat (`toMe`).
- [ ] Coordinates with `FailoverOrchestrator` via `enterMaintenanceKeepalive()` and `exitMaintenanceKeepalive()`.
- [ ] Verifies clean teardown of Chromium child processes upon cycle completion.
- [ ] Unit and integration tests covering scheduling jitter, self-chat dispatch, typing delay, and orchestrator integration.
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
| [01.4] | Failover Orchestrator & Circuit Breaker FSM | [`eb3d96b`] | 2026-10-28 |

---

## Backlog (Upcoming, in priority order)

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
