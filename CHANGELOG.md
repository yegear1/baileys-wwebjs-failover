# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-02

### Added
- Hybrid active-passive gateway pairing Baileys (primary WebSocket) with WhatsApp-Web.js (standby Puppeteer) for high availability.
- Strict finite state machine (`FailoverOrchestrator`) managing automated fencing, cold-start, fallback activation, and recovery swap.
- Redis multi-tier outbound priority queues (`whatsapp:send:priority`, `whatsapp:send:low`, `whatsapp:send:dlq`) with randomized anti-ban jitter delays and composing typing presence.
- Cross-engine inbound message deduplication filter using 10-second bucketed SHA-256 digests.
- Dedicated QR pairing endpoints (`/qr/baileys`, `/qr/wwebjs`) with lazy, on-demand detached Chromium lifecycle for standby pairing.
- Automated session directory purge and instant QR regeneration upon companion device logout or session invalidation.
- Administrative manual recovery endpoint (`POST /failback`) with primary connection state validation.
- Observability suite featuring VictoriaLogs canonical NDJSON structured logging, granular multi-engine `/health` status, and Prometheus `/metrics` exporter.
