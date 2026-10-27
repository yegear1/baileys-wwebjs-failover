# Multi-Repository Ecosystem Topology & Contracts (ECOSYSTEM.md)

> 🎯 **Purpose:** Canonical source of truth for topology, sibling services, shared contracts, and cross-repo boundaries in a multi-repository ecosystem.
>
> ⚠️ **Mandatory Rules for the Agent:**
> 1. You MUST NOT break active contracts consumed by sibling repositories without an expand/contract deprecation period.
> 2. You MUST NOT attempt to directly inspect or mutate files outside this repository directory.
> 3. You MUST mock external service interactions in local automated tests.

---

## 1. Repository Topology Matrix

> Record all related repositories in the application ecosystem and this project's relationship with each.

| Repository | Role / Responsibility | Relationship | Location / Repository URL | Owner / Team |
| :--- | :--- | :---: | :--- | :--- |
| **`[current-repo]`** *(Current)* | [e.g., Core business domain & REST API] | `Self` | `[https://github.com/org/current-repo]` | [Domain Team] |
| `[sibling-frontend]` | [e.g., Client web interface (Svelte / React)] | `Downstream (Consumer)` | `[https://github.com/org/frontend]` | [Frontend Team] |
| `[sibling-worker]` | [e.g., Async task processing / queues] | `Downstream (Consumer)` | `[https://github.com/org/worker]` | [Backend Team] |
| `[shared-contracts]` | [e.g., Central OpenAPI specs, types, or protobufs] | `Upstream (Dependency)` | `[https://github.com/org/contracts]` | [Platform Team] |

*(Relationships: `Self` [this repository], `Upstream (Dependency)` [this repo consumes it], `Downstream (Consumer)` [it consumes this repo], `Peer` [bidirectional communication])*

---

## 2. Shared Contracts & Source of Truth

> Declare how external data contracts and schemas are published, consumed, and kept in sync.

- **Contract Strategy:** `[Local specs/ | Git Submodule | Package Manager (NPM/PyPI) | Sibling Directory]`
- **Contract Format:** `[OpenAPI 3.1 | AsyncAPI | Protobuf / gRPC | JSON Schema | TypeScript DTOs]`
- **Sync Command / Workflow:** `[e.g., npm run sync:contracts | buf generate | make proto]`
- **Drift Prevention:** Every change affecting public payloads MUST regenerate and validate schemas before marking tasks complete.

---

## 3. Cross-Repo Interfaces Catalog

### A. Consumed by this Repository (Upstream Dependencies)

> Interfaces, services, or events this repository depends upon to function.

| Source Service | Protocol / Transport | Target Endpoint / Topic | Contract / Schema | Fallback / Blast Radius |
| :--- | :---: | :--- | :--- | :--- |
| `[auth-service]` | HTTP / REST | `POST /oauth/token` | Bearer JWT (`sub`, `roles`) | Fail-closed (HTTP 401) |
| `[event-bus]` | AMQP / Kafka | `events.billing.completed` | `BillingCompletedEvent` | Dead-letter queue retry |

### B. Exposed by this Repository (Downstream Consumers)

> Public APIs, webhooks, or published events exposed to sibling repositories.

| Route / Topic | Consumer(s) | Payload / Schema | Breaking Change Risk | Deprecation Policy |
| :--- | :--- | :--- | :---: | :--- |
| `POST /api/v1/orders` | `[sibling-frontend]`, `[mobile-app]` | `CreateOrderDto` | **HIGH** | 2 release cycles |
| `orders.status.changed`| `[sibling-worker]` | `OrderStatusChangedEvent` | **MEDIUM** | Expand & contract |

*(Risk levels: **HIGH** [external clients / mobile with delayed rollout], **MEDIUM** [internal controlled services], **LOW** [internal non-blocking logs/metrics])*

---

## 4. Blast Radius & Contract Evolution Rules

1. **Additive-First (Expand / Contract):**
   - NEVER delete, rename, or change data types of existing fields in active contracts directly.
   - Step 1: Add new field as optional.
   - Step 2: Mark old field as `@deprecated` with target decommission date.
   - Step 3: Migrate consumers to the new field.
   - Step 4: Remove deprecated field only after all consumers confirmed migrated.
2. **Hermetic Testing & Zero Cross-Repo Mutation:**
   - Automated test suites MUST NOT require live network access to sibling services.
   - Use contract-driven mocks (e.g., WireMock, MSW, Prism, or fixture recordings).
   - The agent MUST NOT attempt to edit sibling repositories directly during a single task run.
3. **Cross-Repo Task Sequencing:**
   - When a feature requires coordinated changes across repositories:
     1. Producer updates and deploys the contract additively.
     2. Record the downstream migration task in `.agent/TASK.md` or the team tracker.
     3. Consumer updates in a separate task/repository context.

---

## 5. Adaptation Checklist (delete this section when setup is done)

- [ ] Topology matrix updated with real sibling repository names and roles.
- [ ] Contract strategy and sync commands documented in Section 2.
- [ ] Active cross-repo APIs and events cataloged in Section 3.
- [ ] If this project is a standalone single-repo with zero sibling services, delete this file and remove its trigger in `AGENTS.md`.
