# TASK.md — Current Task and Roadmap

> WHAT to do now. Detailed history lives in `git log`. User requests during conversation
> take precedence — report discrepancies before acting.

---

## Active Task

### 📌 Task [00.1]: Project Bootstrap & Stack Setup

- **Description:** Select and configure project stack, package manager, canonical test harness (e.g., npm test, pytest, cargo test, go test), linters, formatters, and populate validation commands and guidelines in `AGENTS.md`.
- **Systems Involved:** `bootstrap`, `tooling`, `tests`
- **Action Type:**
  - [x] Read-only / Documentation
  - [x] Source code changes
- **Status:** READY FOR PLANNING
  *(Workflow: `READY FOR PLANNING` → `PLANNING` on presenting plan → approval → `RUNNING`)*

### Acceptance Criteria
- [ ] Language runtime, package manager, and build tooling initialized.
- [ ] Canonical test runner configured and smoke test passes.
- [ ] Linter, formatter, and strict typing configured.
- [ ] Validation commands documented in `AGENTS.md`.
- [ ] `.env.example` and `.gitignore` updated with project-specific dependencies.
- [ ] `README.md` and `README.pt-br.md` populated with real architecture (Mermaid), quickstart, configuration table (`.env.example`), and validation commands (zero heading emojis or unquantified buzzwords — see `readme-standard` skill).

---

## Completed Tasks Log

| Task | Title | Commit(s) | Date |
|---|---|---|---|
| [00.0] | Initial scaffolding (ADD greenfield) | [`0000000`] | [YYYY-MM-DD] |

---

## Backlog (Upcoming, in priority order)

- [ ] **[01.1]** [First foundation epic or domain core] — `[system]`
- [ ] **[01.2]** [Subsequent foundation feature] — `[system]`

---

## Release / Cycle Wrap-up (Not the next task)

Release/tag only with explicit human request. When triggered, the ID is `[99.1]`. Do not number feature, hygiene, or CI tasks as `99.x`. Do not calculate next task ID from this section.

---

## Future Backlog / Ideas (Unprioritized)

*(empty)*

---

## How to Keep this File Lean

1. Detail only in the active task. When complete $\rightarrow$ log one line and promote the next task.
2. Backlog is a list of titles. Full spec only when an item becomes the active task.
3. Next ID = last ID in log (or active task). Cycle wrap-up and `[99.1]`: see `AGENTS.md`.
