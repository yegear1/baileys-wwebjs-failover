---
author_type: human
author: Architecture Team
reviewed_by: Human Lead
date: 2026-10-05
status: accepted
type: architectural-decision-log
---

# Architectural Decisions Log

> 🏛️ **Progressive Disclosure:** Historical and cumulative decisions live here so AI agents do not load them into working context on every interaction.
> Active runtime contracts stay in [`.agent/NOTES.md`](../../.agent/NOTES.md).

---

## How to Record Architectural Decisions

1. When a substantive design decision or trade-off is approved, append it here chronologically.
2. Maintain decisions compact and falsifiable using the canonical schema below.
3. If an extraordinary architectural decision requires a massive specification or complex C4 diagrams, create an attachment at `docs/adr/ADR-XXX-<name>.md` and link it directly from the entry here.
4. In `.agent/NOTES.md`, maintain only **Active Contracts** and link to this file for background rationale.

---

## Cumulative Decisions

### [YYYY-MM-DD] [Decision Title]

- **Context:** [Problem description, constraint, or requirement motivating the decision]
- **Decision:** [Approved architecture, chosen library, algorithm, or boundary]
- **Alternatives Considered:** [Rejected options and rationale for discarding them]
- **Consequences:** [Positive and negative trade-offs, follow-up invariants]
