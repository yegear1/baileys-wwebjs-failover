# VictoriaLogs Canonical Operational Queries (LogsQL)

All gateway logs are emitted via `createGatewayLogger()` as single-line NDJSON (`NO_COLOR=1`) with canonical fields:
- Stream / low-cardinality fields: `service`, `app`, `env`
- Event fields: `timestamp` (ISO-8601 UTC), `level` (`debug` | `info` | `warn` | `error` | `fatal`), `message`, plus structured context (`id`, `remoteJid`, `from`, `to`, `event`, `queue`, `err`).

---

## 1. Error & Fatal Triage (Last 30m)
```logsql
service:baileys-wwebjs-failover _time:30m level:in(error, fatal)
```

## 2. Failover & Failback FSM Transitions
```logsql
service:baileys-wwebjs-failover _time:24h message:"FSM transition" | fields timestamp, from, to, event, reason
```

## 3. Inbound Deduplication Drops & Strategy Audit
```logsql
service:baileys-wwebjs-failover _time:1h message:"Inbound message discarded by deduplication lock" | fields timestamp, id, remoteJid, dedupStrategy, dedupHash
```

## 4. Dead-Letter Queue (DLQ) & Retry Exhaustion
```logsql
service:baileys-wwebjs-failover _time:24h (message:"DLQ" OR message:"re-queued" OR level:error) | fields timestamp, level, message, queue, retryCount, err.message
```

## 5. Redis BLPOP Backoff & Degradation Storms
```logsql
service:baileys-wwebjs-failover _time:1h (message:"backing off" OR message:"Redis") level:in(warn, error)
```

## 6. Signal Decryption Healing & Companion Logout Purges
```logsql
service:baileys-wwebjs-failover _time:24h (message:"decryption" OR message:"purge" OR message:"loggedOut" OR message:"Chromium")
```

## 7. High-Level Error Rate Summary by Message
```logsql
service:baileys-wwebjs-failover _time:1h level:in(warn, error, fatal) | stats by (level, message) count() as hits | sort by (hits desc)
```
