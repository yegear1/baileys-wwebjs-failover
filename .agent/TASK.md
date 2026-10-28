# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### 📌 Task [01.3]: WWebJS Standby Engine Adapter & Container Hygiene

- **Description:** Implement `whatsapp-web.js` driver adapter conforming to `IWhatsAppDriver`, including cold-start management, Chromium process-tree hygiene (hard SIGKILL teardown to reclaim ~500MB RAM), `--disable-dev-shm-usage` flags, QR pairing event handling, and message conversion with deduplication hashing.
- **Systems Involved:** `driver`, `wwebjs`, `chromium`, `contracts`
- **Action Type:**
  - [ ] Read-only / Documentation
  - [x] Source code changes
- **Status:** READY FOR PLANNING
  *(Workflow: `READY FOR PLANNING` → `PLANNING` on presenting plan → approval → `RUNNING`)*

### Acceptance Criteria
- [ ] Implement `WWebJSDriver` class implementing `IWhatsAppDriver` in `src/drivers/wwebjs.ts`.
- [ ] Secure Chromium profile directory initialization with permissions check on `/data/auth/wwebjs`.
- [ ] Chromium container hygiene flags configured (`--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--no-first-run`, `--no-zygote`).
- [ ] Graceful and forceful process-tree teardown (`client.destroy()` followed by SIGKILL if needed) to ensure complete RAM recovery.
- [ ] Normalized event mapping for QR code, connection states, and inbound messages with deduplication hashing.
- [ ] Implementation of `sendMessage(to, content)` mapping `OutboundMessage` to WWebJS dispatch API.
- [ ] Unit and mock tests in `tests/wwebjs.test.ts`.
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

---

## Backlog (Upcoming, in priority order)

- [ ] **[01.4]** **Failover Orchestrator & Circuit Breaker FSM** — Implement sliding error window, hard fencing, cold-start promotion, and silent probe failback.
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
