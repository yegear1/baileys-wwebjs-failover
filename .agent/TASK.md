# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### [06.2] Redis Persistence Hygiene & Worker Exponential Backoff

**Status:** `RUNNING`
**Objective:** Disallow RDB snapshots and disable `stop-writes-on-bgsave-error` in Redis Compose service; implement adaptive exponential backoff in outbound and reaction worker loops to eliminate tight error loops and telemetry storms during transient Redis persistence degradation.

---

## Completed Tasks Log

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [06.1] | Configurable GATEWAY_MODE (failover vs baileys_only) | [`e201c97`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/e201c97) | 2026-11-03 |
| *(Archived)* | Tasks [00.0] through [05.3] archived to [`.agent/ARCHIVE.md`](ARCHIVE.md) under `[v0.1.0]` | [`c2b22c8`](file:///home/yegear/github/ye-dev/baileys-wwebjs-failover/c2b22c8) | 2026-11-02 |

---

## Backlog (Upcoming, in priority order)

> Tag pre-approved tasks having strictly disjoint file scopes with `[APPROVED]` `[PARALLEL: W1]` and `Paths: ...` for concurrent `task-queue` execution.

*(No pending items in backlog)*

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
