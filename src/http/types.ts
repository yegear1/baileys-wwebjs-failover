import type {
  EngineName,
  EngineState,
  EngineStatus,
  IWhatsAppDriver,
} from "../contracts/driver.js";
import type { FailoverOrchestrator } from "../fsm/orchestrator.js";
import type { FailoverState } from "../fsm/types.js";
import type { QueueManagerStatus, RedisQueueManager } from "../queues/manager.js";
import type { MetricsService } from "./metrics-service.js";

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthResponsePayload {
  readonly status: HealthStatus;
  readonly active_engine: EngineName | null;
  readonly fsm_state?: FailoverState | undefined;
  readonly primary: EngineStatus;
  readonly standby: EngineStatus;
  readonly queues?: QueueManagerStatus | undefined;
}

export interface QrResponsePayload {
  readonly engine: EngineName;
  readonly status: EngineState;
  readonly qr_raw?: string | undefined;
  readonly qr_svg?: string | undefined;
}

export interface IQrRenderer {
  renderSvg(text: string): Promise<string>;
}

export interface GatewayHttpServerOptions {
  readonly orchestrator: FailoverOrchestrator;
  readonly primaryDriver: IWhatsAppDriver;
  readonly standbyDriver: IWhatsAppDriver;
  readonly queueManager?: RedisQueueManager | undefined;
  readonly metricsService?: MetricsService | undefined;
  readonly qrRenderer?: IQrRenderer | undefined;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
}
