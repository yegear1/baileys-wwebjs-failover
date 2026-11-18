# Production Rollout & Operational Verification Runbook

This runbook defines pre-deployment checks, post-deploy verification, and rollback criteria for `baileys-wwebjs-failover`.

---

## 1. Pre-Rollout Checks

1. **Validate Docker Compose & Environment Perimeter**
   ```bash
   docker compose -f docker-compose.yml --env-file .env config --quiet
   ```
2. **Verify Redis Persistence Hygiene**
   Ensure Redis is configured strictly with AOF (`--appendonly yes`) and RDB snapshots disabled (`--save "" --stop-writes-on-bgsave-error no`) to avoid `fork()` SIGKILL or write lockouts:
   ```bash
   docker compose exec redis redis-cli CONFIG GET save appendonly stop-writes-on-bgsave-error
   ```
3. **Verify Auth Storage Isolation**
   Confirm `/data/auth/baileys` and `/data/auth/wwebjs` (when `GATEWAY_MODE=failover`) exist with `0700` permissions on segregated volumes.

---

## 2. Deployment & Rollout Verification

1. **Deploy Updated Image**
   ```bash
   docker compose build gateway
   docker compose up -d
   ```
2. **Run Automated Rollout Verification**
   Build the TypeScript CLI (or run inside the container) and execute `verify:rollout`:
   ```bash
   pnpm build
   pnpm verify:rollout -- --url http://127.0.0.1:3000
   ```
   Optional flags:
   - `--allow-degraded`: Permit `status="degraded"` (e.g., while `FALLBACK_ACTIVE` during primary recovery).
   - `--allow-unpaired`: Permit `UNPAIRED` / `PAIRING_QR_READY` on fresh provisioning before QR scan.
   - `--max-dlq <N>`: Allow up to `<N>` existing messages in `whatsapp:send:dlq` (default `0`).

   The verifier exits `0` only when:
   - `GET /health` returns HTTP `200`, `queues.isOpen === true`, and `status === "ok"`.
   - `GET /metrics` returns HTTP `200` (`text/plain; version=0.0.4`) with all 18 required metric families and `queue_length{queue="dlq"} <= maxDlqMessages`.
   - `GET /qr/baileys` returns HTTP `200` with `status="CONNECTED"`.
   - `GET /qr/wwebjs` returns HTTP `404` (`status="DISABLED"`) in `baileys_only` mode, or HTTP `200` (`STANDBY_READY` / `CONNECTED`) in `failover` mode.

3. **Verify VictoriaLogs NDJSON Ingestion**
   Run the LogsQL triage query in `docs/observability/victorialogs-queries.md`:
   - Confirm `Bootstrapping baileys-wwebjs-failover gateway` and `Gateway bootstrap completed successfully` appear under `service:baileys-wwebjs-failover`.
   - Confirm zero unexpected `level:error` or `level:fatal` entries within the first 5 minutes post-rollout.

4. **Verify Prometheus Scrape & Alert Rules**
   - Load `docs/observability/prometheus-alerts.yml` into Prometheus / Alertmanager.
   - Import `docs/observability/grafana-dashboard.json` into Grafana.
   - Confirm `gateway_health_status{status="ok"} == 1` and `fsm_state{state="PRIMARY_ACTIVE"} == 1`.

---

## 3. Rollback Criteria & Procedure

Trigger an immediate rollback to the previous image tag if any of the following occur within 15 minutes of rollout:
- `GatewayDown` (`gateway_health_status{status="down"} == 1`) persists > 1m.
- `GatewayFailoverFlapping` (`increase(failover_events_total[15m]) >= 3`).
- `GatewayChromiumRestartLoop` (`increase(chromium_restarts_total[15m]) >= 3`).
- Unbounded DLQ growth (`dlq_messages_total` increasing continuously on valid payloads).

Rollback command (preserving auth & Redis volumes — **never** run `docker compose down -v`):
```bash
docker compose pull gateway
docker compose up -d --no-deps gateway
```
