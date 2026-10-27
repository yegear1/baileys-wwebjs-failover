# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### 📌 Task [01.1]: Common Driver Interface & Resilient Deduplication Schemas

- **Description:** Define `IWhatsAppDriver`, unified inbound/outbound message DTOs (`InboundMessage`, `OutboundMessage`, `MessageReceipt`, `EngineStatus`), Zod validation schemas, and the SHA-256 10s-bucket deduplication hash generator.
- **Systems Involved:** `contracts`, `driver`, `dedup`, `types`
- **Action Type:**
  - [ ] Read-only / Documentation
  - [x] Source code changes
- **Status:** READY FOR PLANNING
  *(Workflow: `READY FOR PLANNING` → `PLANNING` on presenting plan → approval → `RUNNING`)*

### Acceptance Criteria
- [ ] Core driver interfaces and status types implemented in `src/contracts/driver.ts`.
- [ ] Unified inbound/outbound DTOs and Zod validation schemas defined in `src/contracts/messages.ts`.
- [ ] Deduplication hash algorithm implemented in `src/utils/dedup.ts` ($\text{SHA256}(\text{remoteJid} + \text{senderJid} + (\text{textBody} \parallel \text{mediaDigest}) + \lfloor\text{timestamp} / 10\rfloor)$).
- [ ] Unit test suite in `tests/dedup.test.ts` verifying exact hash matching across $\pm 5$s timestamps and distinct message isolation.
- [ ] Unit test suite in `tests/messages.test.ts` verifying Zod schema parsing and type safety with zero unchecked `any`.
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

---

## Backlog (Upcoming, in priority order)

- [ ] **[01.2]** **Baileys Primary Engine Adapter** — Implement `@whiskeysockets/baileys` driver with multi-device auth state (`/data/auth/baileys`) and socket lifecycle.
- [ ] **[01.3]** **WWebJS Standby Engine Adapter & Container Hygiene** — Implement `whatsapp-web.js` driver with cold-start management, `--disable-dev-shm-usage` flags, and process-tree SIGKILL teardown.
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
