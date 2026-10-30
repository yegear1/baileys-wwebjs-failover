import { createClient } from "redis";
import type { IWhatsAppDriver } from "../contracts/driver.js";
import { ensureSecureAuthDirectory } from "../drivers/auth-utils.js";
import { BaileysDriver } from "../drivers/baileys.js";
import { WWebJSDriver } from "../drivers/wwebjs.js";
import { RedisFencingLock } from "../fsm/fencing.js";
import { FailoverOrchestrator } from "../fsm/orchestrator.js";
import { GatewayHttpServer } from "../http/server.js";
import { logger } from "../index.js";
import { StandbyMaintenanceDaemon } from "../maintenance/daemon.js";
import { RedisQueueManager } from "../queues/manager.js";
import type { IRedisClient } from "../queues/types.js";
import { type GatewayConfig, loadGatewayConfig } from "./config.js";

export interface GatewayApplicationOptions {
  readonly config?: GatewayConfig | undefined;
  readonly primaryDriver?: IWhatsAppDriver | undefined;
  readonly standbyDriver?: IWhatsAppDriver | undefined;
  readonly redisClient?: IRedisClient | undefined;
  readonly blockingRedisClient?: IRedisClient | undefined;
  readonly disableBackgroundProbeTimer?: boolean | undefined;
  readonly hostConnectivityProbe?: (() => Promise<boolean>) | undefined;
  readonly enableHostConnectivityGuard?: boolean | undefined;
  readonly onExit?: ((code: number) => void) | undefined;
}

/**
 * Top-level application coordinator bootstrapping the failover gateway stack:
 * - Ensures segregated auth directories (0700)
 * - Initializes Redis connection & fencing locks
 * - Wires up Baileys (primary) and WWebJS (standby) drivers
 * - Boots FailoverOrchestrator finite state machine
 * - Starts RedisQueueManager (inbound deduplicator + outbound priority consumer)
 * - Schedules StandbyMaintenanceDaemon keep-alive cycles
 * - Mounts GatewayHttpServer observability and QR endpoints
 * - Traps OS signals (SIGTERM, SIGINT) for graceful shutdown
 */
export class GatewayApplication {
  private readonly config: GatewayConfig;
  private readonly primaryDriver: IWhatsAppDriver;
  private readonly standbyDriver: IWhatsAppDriver;
  private readonly redisClient: IRedisClient;
  private readonly blockingRedisClient: IRedisClient;
  private readonly orchestrator: FailoverOrchestrator;
  private readonly queueManager: RedisQueueManager;
  private readonly maintenanceDaemon: StandbyMaintenanceDaemon;
  private readonly httpServer: GatewayHttpServer;
  private readonly onExit: (code: number) => void;

  private isStarted = false;
  private isStopping = false;
  private signalHandler: ((signal: NodeJS.Signals) => void) | null = null;

  constructor(options: GatewayApplicationOptions = {}) {
    this.config = options.config ?? loadGatewayConfig();
    this.onExit = options.onExit ?? ((code: number) => process.exit(code));

    // INVARIANT: Allow injecting drivers and clients to enable hermetic test suites
    this.redisClient =
      options.redisClient ??
      (createClient({ url: this.config.redisUrl }) as unknown as IRedisClient);

    this.blockingRedisClient =
      options.blockingRedisClient ??
      (typeof this.redisClient.duplicate === "function"
        ? (this.redisClient.duplicate() as unknown as IRedisClient)
        : this.redisClient);

    this.primaryDriver =
      options.primaryDriver ??
      new BaileysDriver({
        authDir: this.config.authDirBaileys,
        printQR: false,
        sendMessageTimeoutMs: this.config.sendMessageTimeoutMs,
      });

    this.standbyDriver =
      options.standbyDriver ??
      new WWebJSDriver({
        authDir: this.config.authDirWWebJS,
        executablePath: this.config.puppeteerExecutablePath,
      });

    const fencingLock = new RedisFencingLock({
      client: this.redisClient,
      key: this.config.fencingLockKey,
    });

    this.orchestrator = new FailoverOrchestrator({
      primaryDriver: this.primaryDriver,
      standbyDriver: this.standbyDriver,
      fencingLock,
      circuitBreakerOptions: {
        failureThreshold: this.config.failoverErrorThreshold,
        probeSuccessThreshold: 2,
        windowMs: this.config.probeStabilityWindowSec * 1000,
      },
      probeIntervalMs: this.config.probeIntervalMs,
      enableHostConnectivityGuard:
        options.enableHostConnectivityGuard ?? this.config.enableHostConnectivityGuard,
      ...(options.hostConnectivityProbe
        ? { hostConnectivityProbe: options.hostConnectivityProbe }
        : {}),
      ...(options.disableBackgroundProbeTimer !== undefined
        ? { disableBackgroundProbeTimer: options.disableBackgroundProbeTimer }
        : {}),
    });

    this.queueManager = new RedisQueueManager({
      client: this.redisClient,
      blockingClient: this.blockingRedisClient,
      orchestrator: this.orchestrator,
      inboxQueueKey: this.config.inboxQueueKey,
      outboundQueueKey: this.config.outboundQueueKey,
      lowPriorityOutboundQueueKey: this.config.lowPriorityOutboundQueueKey,
      dlqQueueKey: this.config.dlqQueueKey,
      maxSendRetries: this.config.maxSendRetries,
      blpopTimeoutSeconds: this.config.blpopTimeoutSeconds,
      enableTypingPresence: this.config.enableTypingPresence,
      delayConfig: {
        urgent: {
          minMs: this.config.urgentDelayMinMs,
          maxMs: this.config.urgentDelayMaxMs,
        },
        normal: {
          minMs: this.config.normalDelayMinMs,
          maxMs: this.config.normalDelayMaxMs,
        },
        low: {
          minMs: this.config.lowDelayMinMs,
          maxMs: this.config.lowDelayMaxMs,
        },
      },
    });

    this.maintenanceDaemon = new StandbyMaintenanceDaemon({
      orchestrator: this.orchestrator,
      standbyDriver: this.standbyDriver,
      scheduleConfig: {
        minDays: this.config.keepaliveIntervalDaysMin,
        maxDays: this.config.keepaliveIntervalDaysMax,
      },
      ...(this.config.selfChatJid ? { selfChatJid: this.config.selfChatJid } : {}),
      autoStart: false,
    });

    this.httpServer = new GatewayHttpServer({
      port: this.config.port,
      host: this.config.host,
      orchestrator: this.orchestrator,
      primaryDriver: this.primaryDriver,
      standbyDriver: this.standbyDriver,
      queueManager: this.queueManager,
    });
  }

  public async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }
    logger.info({ config: this.config }, "Bootstrapping baileys-wwebjs-failover gateway");

    // INVARIANT: Auth dirs must enforce 0700 permissions to protect multi-device session secrets
    await ensureSecureAuthDirectory(this.config.authDirBaileys);
    await ensureSecureAuthDirectory(this.config.authDirWWebJS);

    await this.connectRedisClients();
    await this.queueManager.start();
    await this.orchestrator.start();
    this.maintenanceDaemon.start();

    const boundPort = await this.httpServer.start(this.config.port, this.config.host);

    this.isStarted = true;
    logger.info(
      {
        port: boundPort,
        host: this.config.host,
        activeEngine: this.orchestrator.getActiveEngine(),
        fsmState: this.orchestrator.getState(),
      },
      "Gateway bootstrap completed successfully",
    );
  }

  public async stop(): Promise<void> {
    if (this.isStopping || !this.isStarted) {
      return;
    }
    this.isStopping = true;
    logger.info("Initiating graceful shutdown of baileys-wwebjs-failover gateway");

    // Remove OS signal listeners immediately to prevent listener leaks and redundant triggers
    this.removeSignalHandlers();

    // Orderly teardown: HTTP -> Maintenance -> Buffer Drain -> Queues -> Orchestrator/Drivers
    await this.safeStep(() => this.httpServer.stop(), "GatewayHttpServer");
    this.safeSyncStep(() => this.maintenanceDaemon.stop(), "StandbyMaintenanceDaemon");

    // INVARIANT: Drain/reject pending orchestrator buffer items before stopping queue manager
    // to prevent worker deadlock when a message is awaiting buffer resolution during shutdown.
    this.safeSyncStep(
      () => this.orchestrator.drainOutboundBuffer("Gateway is shutting down"),
      "FailoverOrchestrator.drainOutboundBuffer",
    );

    await this.safeStep(() => this.queueManager.stop(), "RedisQueueManager");
    await this.safeStep(() => this.orchestrator.shutdown(), "FailoverOrchestrator");

    this.isStarted = false;
    this.isStopping = false;
    logger.info("Graceful shutdown completed successfully");
  }

  public setupSignalHandlers(): void {
    if (this.signalHandler) {
      return;
    }

    this.signalHandler = (signal: NodeJS.Signals) => {
      logger.info({ signal }, "Received OS termination signal; initiating graceful teardown");

      const forceExitTimer = setTimeout(() => {
        logger.fatal(
          { timeoutMs: this.config.shutdownTimeoutMs },
          "Graceful shutdown timed out; forcing process exit",
        );
        this.onExit(1);
      }, this.config.shutdownTimeoutMs);

      // Unref ensures the timer does not delay exit once teardown finishes
      if (typeof forceExitTimer.unref === "function") {
        forceExitTimer.unref();
      }

      this.stop()
        .then(() => {
          clearTimeout(forceExitTimer);
          logger.info("Gateway cleanly stopped; exiting process");
          this.onExit(0);
        })
        .catch((err: unknown) => {
          clearTimeout(forceExitTimer);
          logger.fatal({ err }, "Fatal error during graceful shutdown; exiting");
          this.onExit(1);
        });
    };

    process.once("SIGTERM", this.signalHandler);
    process.once("SIGINT", this.signalHandler);
  }

  public removeSignalHandlers(): void {
    if (!this.signalHandler) {
      return;
    }
    process.removeListener("SIGTERM", this.signalHandler);
    process.removeListener("SIGINT", this.signalHandler);
    this.signalHandler = null;
  }

  public isRunning(): boolean {
    return this.isStarted && !this.isStopping;
  }

  public getConfig(): GatewayConfig {
    return this.config;
  }

  public getOrchestrator(): FailoverOrchestrator {
    return this.orchestrator;
  }

  public getQueueManager(): RedisQueueManager {
    return this.queueManager;
  }

  public getMaintenanceDaemon(): StandbyMaintenanceDaemon {
    return this.maintenanceDaemon;
  }

  public getHttpServer(): GatewayHttpServer {
    return this.httpServer;
  }

  public getPrimaryDriver(): IWhatsAppDriver {
    return this.primaryDriver;
  }

  public getStandbyDriver(): IWhatsAppDriver {
    return this.standbyDriver;
  }

  private async connectRedisClients(): Promise<void> {
    if (!this.redisClient.isOpen && typeof this.redisClient.connect === "function") {
      await this.redisClient.connect();
    }
    if (
      this.blockingRedisClient !== this.redisClient &&
      !this.blockingRedisClient.isOpen &&
      typeof this.blockingRedisClient.connect === "function"
    ) {
      await this.blockingRedisClient.connect();
    }
  }

  private async safeStep(action: () => Promise<unknown>, stepName: string): Promise<void> {
    try {
      await action();
    } catch (err: unknown) {
      logger.error({ err, stepName }, "Error during shutdown step");
    }
  }

  private safeSyncStep(action: () => void, stepName: string): void {
    try {
      action();
    } catch (err: unknown) {
      logger.error({ err, stepName }, "Error during shutdown step");
    }
  }
}
