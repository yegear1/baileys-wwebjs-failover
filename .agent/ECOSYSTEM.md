# Multi-Repository Ecosystem Topology & Contracts (ECOSYSTEM.md)

> 🎯 **Purpose:** Canonical source of truth for topology, sibling services, shared contracts, and cross-repo boundaries in the WhatsApp automation ecosystem.
>
> ⚠️ **Mandatory Rules for the Agent:**
> 1. You MUST NOT break active contracts consumed by sibling repositories without an expand/contract deprecation period.
> 2. You MUST NOT attempt to directly inspect or mutate files outside this repository directory.
> 3. You MUST mock external service interactions in local automated tests.

---

## 1. Repository Topology Matrix

| Repository | Role / Responsibility | Relationship | Location / Repository URL | Owner / Team |
| :--- | :--- | :---: | :--- | :--- |
| **`baileys-wwebjs-failover`** *(Current)* | High-availability dual-engine WhatsApp gateway & failover orchestrator. | `Self` | `https://github.com/yegear1/baileys-wwebjs-failover` | Core Gateway Dev |
| `whatsapp-api` | Full bot platform, command router, AI logic, and Web UI. Consumes this gateway. | `Downstream (Consumer)` | `https://github.com/yegear1/whatsapp-api` | Platform Dev |
| `infra-victoria-logs` | Organization-wide observability engine (VictoriaLogs + Vector) ingesting NDJSON logs. | `Upstream (Dependency)` | `https://github.com/ye-sandbox/infra-victoria-logs` | Infra Team |

*(Relationships: `Self` [this repository], `Upstream (Dependency)` [this repo consumes it], `Downstream (Consumer)` [it consumes this repo], `Peer` [bidirectional communication])*

---

## 2. Shared Contracts & Source of Truth

- **Contract Strategy:** Standardized Redis Queues and TypeScript DTOs.
- **Contract Format:** Strict TypeScript Interfaces & Zod validation schemas.
- **Sync Command / Workflow:** Compatible with the canonical `whatsapp:receive:inbox` and `whatsapp:send:priority` schemas defined in `whatsapp-api`.
- **Drift Prevention:** Inbound and outbound payloads comply with the canonical schemas in `.agent/NOTES.md` and are verified by unit tests.

---

## 3. Cross-Repo Interfaces Catalog

### A. Consumed by this Repository (Upstream Dependencies)

| Source Service | Protocol / Transport | Target Endpoint / Topic | Contract / Schema | Fallback / Blast Radius |
| :--- | :---: | :--- | :--- | :--- |
| `redis` | TCP / Redis Protocol | `whatsapp:send:priority` | `SendMessagePayload` | Reconnect retry; buffered in Redis |
| `infra-victoria-logs` | Stdout / NDJSON | Docker `json-file` log driver | VictoriaLogs Ingestion Schema | Local stdout fallback; no crash |

### B. Exposed by this Repository (Downstream Consumers)

| Route / Topic | Consumer(s) | Payload / Schema | Breaking Change Risk | Deprecation Policy |
| :--- | :--- | :--- | :---: | :--- |
| `whatsapp:receive:inbox` | `whatsapp-api` (`logic-worker-py`) | `InboundMessagePayload` | **HIGH** | 2 release cycles |
| `GET /health` | Orchestrators, Docker healthcheck | `{ status, active_engine, primary, standby }` | **LOW** | Additive-first |
| `GET /qr/baileys` | Web UI, Admin QR pairing | `{ engine, status, qr_raw, qr_svg }` | **LOW** | Backward-compatible |
| `GET /qr/wwebjs` | Web UI, Admin QR pairing | `{ engine, status, qr_raw, qr_svg }` | **LOW** | Backward-compatible |
