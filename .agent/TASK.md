# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### [06.3] Operational Observability & Production Rollout Verification

**Status:** `READY FOR PLANNING`
**Objective:** Define post-release operational observability, alerting dashboards, and production rollout verification.

---

## Completed Tasks Log

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [06.2] | Redis Persistence Hygiene & Worker Exponential Backoff | [`bc96b43`](file:///home/luis/Github/ye-dev/baileys-wwebjs-failover/bc96b43) | 2026-11-05 |
| [06.1] | Configurable GATEWAY_MODE (failover vs baileys_only) | [`e201c97`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/e201c97) | 2026-11-03 |
| *(Archived)* | Tasks [00.0] through [05.3] archived to [`.agent/ARCHIVE.md`](ARCHIVE.md) under `[v0.1.0]` | [`c2b22c8`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/c2b22c8) | 2026-11-02 |

---

## Backlog (Upcoming, in priority order)

> Tag pre-approved tasks having strictly disjoint file scopes with `[APPROVED]` `[PARALLEL: W1]` and `Paths: ...` for concurrent `task-queue` execution.

- **[06.4]** `[APPROVED]` Inbound Message Deduplication by Canonical Message ID & Concatenated Media Digest
  - **Objective:** Eliminate false-positive message drops on rapid commands (!s) by using unique remote `msg.id` as primary deduplication lock and concatenating `textBody:mediaDigest` in candidate content fallback. Prevent cross-bucket 300s TTL cascade on adjacent time windows.
  - **Paths:** `src/utils/dedup.ts`, `src/queues/dedup-lock.ts`, `src/queues/inbound-publisher.ts`, `tests/`

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
