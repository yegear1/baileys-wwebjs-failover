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
