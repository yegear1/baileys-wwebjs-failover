import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { logger as defaultLogger } from "../index.js";
import { HealthService } from "./health-service.js";
import { DefaultQrRenderer, QrService } from "./qr-service.js";
import { RequestRouter } from "./routes.js";
import type { GatewayHttpServerOptions } from "./types.js";

/**
 * Standard HTTP server exposing granular health diagnostics and dual-engine QR pairing endpoints.
 *
 * INVARIANT: Implemented on standard node:http with zero heavy web framework overhead.
 * Operates purely as a decoupled observability and pairing gateway.
 */
export class GatewayHttpServer {
  private readonly server: Server;
  private readonly router: RequestRouter;
  private readonly healthService: HealthService;
  private readonly qrService: QrService;
  private readonly port: number;
  private readonly host: string;
  private boundPort: number | undefined;

  constructor(options: GatewayHttpServerOptions) {
    this.port = options.port ?? Number(process.env.PORT ?? 3000);
    this.host = options.host ?? process.env.HOST ?? "0.0.0.0";

    this.healthService = new HealthService({
      orchestrator: options.orchestrator,
      primaryDriver: options.primaryDriver,
      standbyDriver: options.standbyDriver,
      queueManager: options.queueManager,
    });

    this.qrService = new QrService(options.qrRenderer ?? new DefaultQrRenderer());

    this.router = new RequestRouter({
      healthService: this.healthService,
      qrService: this.qrService,
      primaryDriver: options.primaryDriver,
      standbyDriver: options.standbyDriver,
    });

    this.server = http.createServer((req, res) => {
      this.router.handleRequest(req, res).catch((err) => {
        defaultLogger.error({ err }, "Unhandled error during HTTP request processing");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    });
  }

  public async start(port?: number, host?: string): Promise<number> {
    const targetPort = port ?? this.port;
    const targetHost = host ?? this.host;

    return new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(targetPort, targetHost, () => {
        this.server.removeListener("error", reject);
        const address = this.server.address() as AddressInfo | null;
        this.boundPort = address?.port ?? targetPort;
        defaultLogger.info(
          { port: this.boundPort, host: targetHost },
          "Gateway HTTP observability server listening",
        );
        resolve(this.boundPort);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.boundPort = undefined;
          resolve();
        }
      });
    });
  }

  public getPort(): number | undefined {
    return this.boundPort;
  }

  public getHttpServer(): Server {
    return this.server;
  }

  public getHealthService(): HealthService {
    return this.healthService;
  }

  public getQrService(): QrService {
    return this.qrService;
  }
}
