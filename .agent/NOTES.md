# NOTES.md — Active Contracts and Runtime Memory

> Stores the active runtime contracts (WHAT interacts with WHAT), live communication topology, and critical gotchas.
> Historical architectural decisions live in [`docs/adr/decisions.md`](../docs/adr/decisions.md).

---

## How to Use this File

1. **Read before planning.** Active contracts and gotchas here take precedence over unstated defaults.
2. **Keep this file lean:** Only store ACTIVE contracts, live topology, open technical debt, and critical gotchas.
3. **Architectural decisions:** Record in [`docs/adr/decisions.md`](../docs/adr/decisions.md). Do NOT accumulate historical decisions here to prevent context bloat.

---

## Active Contracts

### 1. Runtime Data & Payload Contracts

Full schemas live in code (`[src/models/]` or `[core/schemas/]`). This table maps high-level contracts:

| Channel / Route / Queue | Producer | Consumer | Payload Schema / Protocol | Notes |
|---|---|---|---|---|
| `[e.g.: GET /api/v1/items]` | `[Service API]` | `[Web Frontend]` | `[ItemSummaryResponse]` | `[Active pagination schema]` |
| `[e.g.: queue:events:raw]` | `[Ingestion Worker]` | `[Event Parser]` | `[RawEventPayload]` | `[Redis stream / Kafka topic]` |

Contract changes require updating schemas on both sides within the same task.

### 2. Multi-Agent Collaboration Contracts (Optional)

> For projects operating with multiple AI agents or specialized subagents. If single-agent, leave as default.

| Role | Interface / Channel | Responsibilities | Boundary |
|---|---|---|---|
| **Planner / Architect** | `.agent/TASK.md` / Chat | Decomposes initiatives, defines acceptance criteria and scope. | Does not edit source code directly. |
| **Developer / Implementer** | Workspace / Terminal | Implements code changes strictly within task scope. | Follows Definition of Done in `AGENTS.md`. |
| **Auditor / Reviewer** | Diffs / Test Suite | Asserts test coverage, invariants, and DoD before task completion. | Read-only inspection; reports approval or rejection. |

---

## Gotchas & Pitfalls

- **[Lib/Service]:** [unexpected behavior and mitigation]

---

## Deliberate Technical Debt

| Debt | Rationale | Revisit When |
|---|---|---|
| | | |
