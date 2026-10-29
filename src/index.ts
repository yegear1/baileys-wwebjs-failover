import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export interface GatewayInfo {
  readonly name: string;
  readonly version: string;
}

export function getGatewayInfo(): GatewayInfo {
  return {
    name: "baileys-wwebjs-failover",
    version: "0.1.0",
  };
}

export * from "./bootstrap/index.js";
export * from "./contracts/driver.js";
export * from "./contracts/messages.js";
export * from "./drivers/auth-utils.js";
export * from "./drivers/baileys.js";
export * from "./drivers/baileys-mapper.js";
export * from "./drivers/wwebjs.js";
export * from "./drivers/wwebjs-mapper.js";
export * from "./fsm/circuit-breaker.js";
export * from "./fsm/fencing.js";
export * from "./fsm/orchestrator.js";
export * from "./fsm/types.js";
export * from "./http/health-service.js";
export * from "./http/metrics-service.js";
export * from "./http/qr-service.js";
export * from "./http/routes.js";
export * from "./http/server.js";
export * from "./http/types.js";
export * from "./main.js";
export * from "./maintenance/daemon.js";
export * from "./maintenance/jitter.js";
export * from "./maintenance/payload.js";
export * from "./maintenance/types.js";
export * from "./queues/dedup-lock.js";
export * from "./queues/inbound-publisher.js";
export * from "./queues/manager.js";
export * from "./queues/outbound-worker.js";
export * from "./queues/types.js";
export * from "./utils/dedup.js";
export * from "./utils/host-connectivity.js";

// Automatically invoke if executed directly via node dist/index.js
if (process.argv[1]?.endsWith("index.js")) {
  void import("./main.js").then((m) => m.main());
}
