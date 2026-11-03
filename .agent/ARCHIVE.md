# ARCHIVE.md — Historical Log of Completed Tasks

> Batches archived after Git tag (or when `TASK.md` log exceeds ~15 entries).
> Canonical header: `## [vX.Y.Z] - YYYY-MM-DD`. Deep detail: `git log`.

---

## [v0.1.0] - 2026-11-02

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [00.0] | Initial scaffolding (ADD greenfield template) | [`1d2d385`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/1d2d385) | 2026-10-27 |
| [00.1] | Project Bootstrap, Tooling & Strict TypeScript Stack | [`dabe627`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/dabe627) | 2026-10-27 |
| [01.1] | Common Driver Interface & Resilient Deduplication Schemas | [`90e520e`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/90e520e) | 2026-10-27 |
| [01.2] | Baileys Primary Engine Adapter & Dedup Hash Integration | [`6ebada6`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/6ebada6) | 2026-10-28 |
| [01.3] | WWebJS Standby Engine Adapter & Container Hygiene | [`bd2aa75`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/bd2aa75) | 2026-10-28 |
| [01.4] | Failover Orchestrator & Circuit Breaker FSM | [`eb3d96b`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/eb3d96b) | 2026-10-28 |
| [01.5] | Standby Maintenance Daemon & Anti-Fingerprinting Keep-Alive | [`289fc9a`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/289fc9a) | 2026-10-28 |
| [01.6] | Redis Queue Integration & Deduplication Lock | [`0ef28c3`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/0ef28c3) | 2026-10-28 |
| [02.1] | Dual-Device QR Pairing & Granular Health API | [`632eb2b`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/632eb2b) | 2026-10-28 |
| [02.2] | Container Orchestration & Production Compose Stack | [`18ad2d5`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/18ad2d5) | 2026-10-28 |
| [03.1] | End-to-End Gateway Integration & Service Bootstrap | [`63eb7d4`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/63eb7d4) | 2026-10-28 |
| [03.2] | E2E Smoke & Resilience Verification | [`7067936`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/7067936) | 2026-10-29 |
| [03.3] | Zero-Loss Outbound Re-queue, Dead-Letter Queue & Host Connectivity Guard | [`9ad0485`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/9ad0485) | 2026-10-29 |
| [90.1] | Hermetic Redis Test Fallback & E2E Resilience Decoupling | [`8485c62`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/8485c62) | 2026-10-29 |
| [90.2] | Driver Stability & Lifecycle Hardening | [`917937d`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/917937d) | 2026-10-29 |
| [90.3] | Atomic Lua Deduplication & Media Digest Parity | [`07f4807`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/07f4807) | 2026-10-29 |
| [90.4] | Shutdown Lifecycle Ordering & Buffer Safety | [`1e70ce7`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/1e70ce7) | 2026-10-29 |
| [90.5] | Observability & Prometheus Metrics Exporter | [`8a10ca6`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/8a10ca6) | 2026-10-29 |
| [90.6] | Dynamic Chromium Health & Standby Puppeteer Restart Recovery | [`a6bb283`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/a6bb283) | 2026-10-29 |
| [90.7] | End-to-End Load & Sustained Queue Concurrency Verification | [`184a6ed`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/184a6ed) | 2026-10-29 |
| [90.8] | Soak Test & Long-Running Memory Leak Audit | [`59739d7`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/59739d7) | 2026-10-29 |
| [04.1] | Multi-Tier Outbound Queue, Priority Jitter Delays & Typing Presence | [`687006a`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/687006a) | 2026-10-30 |
| [04.2] | Automated Session Purge & QR Regeneration on Companion Logout | [`0e09b8e`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/0e09b8e) | 2026-10-30 |
| [04.3] | VictoriaLogs Canonical NDJSON Logging & Docker Hygiene | [`3f1973b`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/3f1973b) | 2026-10-30 |
| [04.4] | Contract Parity with Services/Brain (Stickers, Base64 Media & Reactions) | [`7a3a131`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/7a3a131) | 2026-11-02 |
| [05.1] | On-Demand Detached Pairing Lifecycle for Standby WWebJS | [`76df80f`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/76df80f) | 2026-11-02 |
| [05.2] | Inbound Media Buffers, Quoted Context & Retry Circuit Breaker Hardening | [`9d1f700`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/9d1f700) | 2026-11-02 |
| [05.3] | Resilient Failback Orchestration, Circuit Breaker Isolation & Manual Failback API | [`b8c5a01`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/b8c5a01) | 2026-11-02 |
