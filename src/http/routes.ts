import type { IncomingMessage, ServerResponse } from "node:http";
import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { HealthService } from "./health-service.js";
import type { MetricsService } from "./metrics-service.js";
import type { QrService } from "./qr-service.js";

export interface RequestRouterDependencies {
  readonly healthService: HealthService;
  readonly qrService: QrService;
  readonly metricsService: MetricsService;
  readonly primaryDriver: IWhatsAppDriver;
  readonly standbyDriver: IWhatsAppDriver;
}

/**
 * Pure HTTP request dispatcher handling gateway observability and QR pairing endpoints.
 */
export class RequestRouter {
  private readonly healthService: HealthService;
  private readonly qrService: QrService;
  private readonly metricsService: MetricsService;
  private readonly primaryDriver: IWhatsAppDriver;
  private readonly standbyDriver: IWhatsAppDriver;

  constructor(dependencies: RequestRouterDependencies) {
    this.healthService = dependencies.healthService;
    this.qrService = dependencies.qrService;
    this.metricsService = dependencies.metricsService;
    this.primaryDriver = dependencies.primaryDriver;
    this.standbyDriver = dependencies.standbyDriver;
  }

  public async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const [path] = rawUrl.split("?");
    const method = (req.method ?? "GET").toUpperCase();

    // Enforce JSON content type and CORS baseline for observability clients
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method !== "GET") {
      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      switch (path) {
        case "/metrics": {
          const metrics = await this.metricsService.getMetrics();
          res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
          res.writeHead(200);
          res.end(metrics);
          return;
        }

        case "/health": {
          const health = this.healthService.getHealth();
          const statusCode = health.status === "down" ? 503 : 200;
          res.writeHead(statusCode);
          res.end(JSON.stringify(health));
          return;
        }

        case "/qr/baileys": {
          const qrData = await this.qrService.getQrStatus(this.primaryDriver);
          res.writeHead(200);
          res.end(JSON.stringify(qrData));
          return;
        }

        case "/qr/wwebjs": {
          const qrData = await this.qrService.getQrStatus(this.standbyDriver);
          res.writeHead(200);
          res.end(JSON.stringify(qrData));
          return;
        }

        default: {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }
      }
    } catch (err) {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
