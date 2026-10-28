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
export * from "./maintenance/daemon.js";
export * from "./maintenance/jitter.js";
export * from "./maintenance/payload.js";
export * from "./maintenance/types.js";
export * from "./utils/dedup.js";
