import type { EngineName, EngineStatus, IWhatsAppDriver } from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";
import { logger } from "../index.js";
import { checkHostConnectivity } from "../utils/host-connectivity.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { type IFencingLock, InMemoryFencingLock } from "./fencing.js";
import type {
  FailoverEvent,
  FailoverSnapshot,
  FailoverState,
  StateChangeListener,
} from "./types.js";

interface BufferedOutboundItem {
  to: string;
  content: OutboundMessage;
  resolve: (receipt: MessageReceipt) => void;
  reject: (err: unknown) => void;
}

export interface FailoverOrchestratorOptions {
  readonly primaryDriver: IWhatsAppDriver;
  readonly standbyDriver: IWhatsAppDriver;
  readonly fencingLock?: IFencingLock;
  readonly circuitBreakerOptions?: CircuitBreakerOptions;
  /**
   * Probe check interval in milliseconds during FALLBACK_ACTIVE.
   * Default: 10,000 ms (10s).
   */
  readonly probeIntervalMs?: number;
  /**
   * Deterministic timeout in milliseconds waiting for primary driver to connect during silent probe.
   * Default: 5,000 ms (5s).
   */
  readonly probeTimeoutMs?: number;
  /**
   * Whether to disable automated background probe timer (useful in tests).
   * Default: false.
   */
  readonly disableBackgroundProbeTimer?: boolean;
  /**
   * Optional custom probe to check host WAN internet connectivity.
   * Default: checkHostConnectivity()
   */
  readonly hostConnectivityProbe?: () => Promise<boolean>;
  /**
   * Whether to check host connectivity before triggering failover.
   * Default: true if hostConnectivityProbe is provided, false if plain unit test, or true when configured.
   */
  readonly enableHostConnectivityGuard?: boolean;
}

export class FailoverOrchestrator {
  private readonly primary: IWhatsAppDriver;
  private readonly standby: IWhatsAppDriver;
  private readonly fencingLock: IFencingLock;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly disableBackgroundProbeTimer: boolean;
  private readonly hostConnectivityProbe: () => Promise<boolean>;
  private readonly enableHostConnectivityGuard: boolean;

  private state: FailoverState = "PRIMARY_ACTIVE";
  private activeEngine: EngineName | null = "baileys";
  private lastTransitionAt: Date = new Date();
  private lastError: string | undefined = undefined;
  private failoverCount = 0;
  private failbackCount = 0;
  private readonly lastEngineLatencySeconds: Record<EngineName, number> = {
    baileys: 0,
    wwebjs: 0,
  };

  private readonly stateListeners: Set<StateChangeListener> = new Set();
  private readonly messageListeners: Set<(msg: InboundMessage) => Promise<void>> = new Set();
  private readonly probeStatusListeners: Set<(status: EngineStatus) => void> = new Set();
  private readonly outboundBuffer: BufferedOutboundItem[] = [];

  private probeTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private isTransitioning = false;
  private isProbing = false;
  private isShuttingDown = false;

  constructor(options: FailoverOrchestratorOptions) {
    this.primary = options.primaryDriver;
    this.standby = options.standbyDriver;
    this.fencingLock = options.fencingLock ?? new InMemoryFencingLock();
    this.circuitBreaker = new CircuitBreaker(options.circuitBreakerOptions);
    this.probeIntervalMs = options.probeIntervalMs ?? 10_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    this.disableBackgroundProbeTimer = options.disableBackgroundProbeTimer ?? false;
    this.enableHostConnectivityGuard =
      options.enableHostConnectivityGuard ?? options.hostConnectivityProbe !== undefined;
    this.hostConnectivityProbe = options.hostConnectivityProbe ?? checkHostConnectivity;

    this.setupDriverListeners();
  }

  getState(): FailoverState {
    return this.state;
  }

  getActiveEngine(): EngineName | null {
    return this.activeEngine;
  }

  getPrimaryDriver(): IWhatsAppDriver {
    return this.primary;
  }

  getStandbyDriver(): IWhatsAppDriver {
    return this.standby;
  }

  getSnapshot(): FailoverSnapshot {
    return {
      state: this.state,
      activeEngine: this.activeEngine,
      primaryStatus: this.primary.getStatus(),
      standbyStatus: this.standby.getStatus(),
      bufferedMessagesCount: this.outboundBuffer.length,
      failureCount: this.circuitBreaker.getConsecutiveFailures(),
      failoverCount: this.failoverCount,
      failbackCount: this.failbackCount,
      lastTransitionAt: this.lastTransitionAt,
      lastError: this.lastError,
    };
  }

  getFailoverCount(): number {
    return this.failoverCount;
  }

  getFailbackCount(): number {
    return this.failbackCount;
  }

  getEngineLatencies(): Record<EngineName, number> {
    return { ...this.lastEngineLatencySeconds };
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): () => void {
    this.messageListeners.add(handler);
    return () => this.messageListeners.delete(handler);
  }

  /**
   * Starts the orchestrator, initializing primary driver and securing primary fencing lock.
   */
  async start(): Promise<void> {
    if (this.isShuttingDown || this.state === "SHUTDOWN") {
      throw new Error("Cannot start: FailoverOrchestrator is shutting down");
    }
    logger.info("Starting FailoverOrchestrator in PRIMARY_ACTIVE state");
    await this.fencingLock.acquire("baileys");
    this.activeEngine = "baileys";
    this.state = "PRIMARY_ACTIVE";
    this.lastTransitionAt = new Date();
    await this.primary.connect();
  }

  /**
   * Immediately rejects and drains all pending items in the outbound buffer.
   * Prevents deadlocks during worker and orchestrator shutdown.
   */
  drainOutboundBuffer(reason = "FailoverOrchestrator buffer cancelled"): number {
    const count = this.outboundBuffer.length;
    while (this.outboundBuffer.length > 0) {
      const item = this.outboundBuffer.shift();
      item?.reject(new Error(reason));
    }
    return count;
  }

  /**
   * Sends an outbound message. Routes directly to active engine or buffers if transitioning.
   */
  async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (this.isShuttingDown || this.state === "SHUTDOWN") {
      throw new Error("Cannot send message: FailoverOrchestrator is shutting down");
    }

    if (this.isBufferingState()) {
      return new Promise<MessageReceipt>((resolve, reject) => {
        this.outboundBuffer.push({ to, content, resolve, reject });
      });
    }

    const currentDriver = this.getCurrentActiveDriver();
    if (!currentDriver) {
      throw new Error(`Cannot send message: no active driver available in state ${this.state}`);
    }

    const startTime = Date.now();
    try {
      const receipt = await currentDriver.sendMessage(to, content);
      this.lastEngineLatencySeconds[currentDriver.name] = (Date.now() - startTime) / 1000;
      this.circuitBreaker.recordSuccess();
      return receipt;
    } catch (error) {
      this.lastEngineLatencySeconds[currentDriver.name] = (Date.now() - startTime) / 1000;
      this.lastError = error instanceof Error ? error.message : String(error);
      const tripped = this.circuitBreaker.recordFailure(error);
      if (tripped && this.state === "PRIMARY_ACTIVE") {
        logger.warn({ error }, "Circuit breaker tripped on send failure; initiating failover");
        void this.triggerFailover("Consecutive send failures exceeded threshold");
      }
      throw error;
    }
  }

  /**
   * Triggers automated or manual failover from primary to standby.
   */
  async triggerFailover(reason = "Failover triggered"): Promise<void> {
    if (this.isTransitioning || this.isShuttingDown || this.state === "SHUTDOWN") return;

    if (this.enableHostConnectivityGuard) {
      try {
        const isOnline = await this.hostConnectivityProbe();
        if (!isOnline) {
          logger.warn(
            { reason },
            "Host WAN connectivity probe failed (network offline); suppressing failover to WWebJS standby",
          );
          return;
        }
      } catch (probeErr) {
        logger.warn(
          { probeErr, reason },
          "Host WAN connectivity probe threw an error; treating as offline and suppressing failover",
        );
        return;
      }
    }

    this.isTransitioning = true;
    this.circuitBreaker.trip(reason);

    try {
      // Step 1: FENCING - Disconnect primary and isolate before promoting standby
      await this.transitionTo("FENCING", "TRIP_CIRCUIT", reason);
      this.activeEngine = null;
      await this.disconnectPrimarySafely();

      await this.fencingLock.release("baileys");
      await this.fencingLock.acquire("wwebjs");

      // Step 2: COLD_START_STANDBY - Launch Chromium / WWebJS
      await this.transitionTo(
        "COLD_START_STANDBY",
        "FENCING_COMPLETE",
        "Standby cold-start started",
      );
      await this.standby.connect();

      // Step 3: FALLBACK_ACTIVE - Promote WWebJS as active engine
      this.activeEngine = "wwebjs";
      await this.transitionTo("FALLBACK_ACTIVE", "STANDBY_READY", "Standby promoted to active");

      // Flush outbound buffer through standby
      await this.flushOutboundBuffer();

      // Start silent probe failback loop
      this.startSilentProbeLoop();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Failed during failover transition");
      throw error;
    } finally {
      this.isTransitioning = false;
    }
  }

  /**
   * Manual or probe-triggered failback to primary engine via RECOVERY_SWAP.
   */
  async triggerFailback(reason = "Failback triggered"): Promise<void> {
    if (this.state !== "FALLBACK_ACTIVE" || this.isTransitioning || this.isShuttingDown) {
      return;
    }
    this.isTransitioning = true;
    this.stopSilentProbeLoop();

    try {
      // Step 1: RECOVERY_SWAP - Buffer outbound and teardown standby
      await this.transitionTo("RECOVERY_SWAP", "PROBE_STABLE", reason);
      this.activeEngine = null;

      // INVARIANT: Standby Chromium must be cleanly destroyed to reclaim memory before primary activation
      await this.standby.disconnect();
      await this.fencingLock.release("wwebjs");
      await this.fencingLock.acquire("baileys");

      // Ensure primary is fully connected
      await this.primary.connect();

      // Step 2: PRIMARY_ACTIVE restored
      this.activeEngine = "baileys";
      this.circuitBreaker.reset();
      await this.transitionTo(
        "PRIMARY_ACTIVE",
        "RECOVERY_COMPLETE",
        "Failback to primary completed",
      );

      // Flush buffered outbound through primary
      await this.flushOutboundBuffer();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Failed during recovery swap failback");
      throw error;
    } finally {
      this.isTransitioning = false;
    }
  }

  /**
   * Enters temporary maintenance keepalive mode (for standby anti-expiration daemon).
   */
  async enterMaintenanceKeepalive(): Promise<void> {
    if (this.state !== "PRIMARY_ACTIVE" || this.isTransitioning) {
      throw new Error(`Cannot enter maintenance keepalive from state ${this.state}`);
    }
    await this.transitionTo(
      "MAINTENANCE_KEEPALIVE",
      "ENTER_MAINTENANCE",
      "Periodic standby keep-alive maintenance",
    );
    await this.standby.connect();
  }

  /**
   * Exits maintenance keepalive mode, destroying standby Chromium instance.
   */
  async exitMaintenanceKeepalive(): Promise<void> {
    if (this.state !== "MAINTENANCE_KEEPALIVE" || this.isTransitioning) {
      throw new Error(`Cannot exit maintenance keepalive from state ${this.state}`);
    }
    // INVARIANT: Teardown standby immediately after maintenance keepalive to release RAM
    await this.standby.disconnect();
    await this.transitionTo("PRIMARY_ACTIVE", "EXIT_MAINTENANCE", "Standby keep-alive finished");
  }

  /**
   * Executes a single silent probe against primary driver.
   * Returns true if the probe succeeds.
   */
  async executeSilentProbe(): Promise<boolean> {
    if (this.state !== "FALLBACK_ACTIVE" || this.isProbing || this.isShuttingDown) return false;
    this.isProbing = true;

    try {
      this.circuitBreaker.startProbe();

      // INVARIANT: Inspect existing primary connection state before attempting reconnection
      const currentStatus = this.primary.getStatus();
      if (currentStatus.connected) {
        const recovered = this.circuitBreaker.recordSuccess();
        logger.info(
          { probeSuccesses: this.circuitBreaker.getProbeSuccesses() },
          "Silent probe confirmed already-connected primary stability",
        );
        if (recovered) {
          logger.info("Silent probe confirmed primary stability; initiating recovery swap");
          void this.triggerFailback("Silent probe verified primary stability");
        }
        return true;
      }

      // If disconnected, await connection completion (CONNECTED state) with deterministic timeout
      const connectPromise = this.primary.connect();
      const connected = await this.waitForPrimaryConnected(connectPromise);

      if (connected) {
        const recovered = this.circuitBreaker.recordSuccess();
        logger.info(
          { probeSuccesses: this.circuitBreaker.getProbeSuccesses() },
          "Silent probe to primary succeeded",
        );
        if (recovered) {
          logger.info("Silent probe confirmed primary stability; initiating recovery swap");
          void this.triggerFailback("Silent probe verified primary stability");
        }
        return true;
      }

      // Probe failed or timed out: safely teardown probe sockets to prevent leaks
      this.circuitBreaker.recordFailure("Primary status not connected during probe");
      await this.disconnectPrimarySafely();
      return false;
    } catch (error) {
      this.circuitBreaker.recordFailure(error);
      await this.disconnectPrimarySafely();
      return false;
    } finally {
      this.isProbing = false;
    }
  }

  private async waitForPrimaryConnected(connectPromise: Promise<void>): Promise<boolean> {
    if (this.primary.getStatus().connected) {
      return true;
    }

    await connectPromise;

    if (this.primary.getStatus().connected) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (result: boolean) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          this.probeStatusListeners.delete(onStatus);
          resolve(result);
        }
      };

      const onStatus = (status: EngineStatus) => {
        if (status.connected) {
          finish(true);
        } else if (status.state === "ERROR" || status.state === "UNPAIRED") {
          finish(false);
        }
      };

      this.probeStatusListeners.add(onStatus);

      timer = setTimeout(() => {
        finish(false);
      }, this.probeTimeoutMs);
      timer.unref?.();
    });
  }

  /**
   * Shuts down the orchestrator, cancelling timers, rejecting buffer, and disconnecting drivers.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown || this.state === "SHUTDOWN") {
      return;
    }
    logger.info("Shutting down FailoverOrchestrator");
    this.isShuttingDown = true;
    this.stopSilentProbeLoop();

    // INVARIANT: Drain/reject buffer immediately so in-flight callers do not hang
    this.drainOutboundBuffer("FailoverOrchestrator is shutting down");

    await this.transitionTo("SHUTDOWN", "SHUTDOWN", "FailoverOrchestrator shutdown initiated");

    await Promise.allSettled([
      this.primary.disconnect(),
      this.standby.disconnect(),
      this.fencingLock.release("baileys"),
      this.fencingLock.release("wwebjs"),
    ]);

    this.activeEngine = null;
  }

  private setupDriverListeners(): void {
    // Primary driver message routing
    this.primary.onMessage(async (msg) => {
      // INVARIANT: Drop primary inbound messages unless primary is the active engine
      if (this.activeEngine === "baileys") {
        await this.dispatchInboundMessage(msg);
      }
    });

    // Standby driver message routing
    this.standby.onMessage(async (msg) => {
      // INVARIANT: Drop standby inbound messages unless standby is the active engine
      if (this.activeEngine === "wwebjs") {
        await this.dispatchInboundMessage(msg);
      }
    });

    // Primary driver health monitoring & probe status subscription
    this.primary.onStatusChange((status) => {
      if (this.isShuttingDown) return;

      for (const listener of this.probeStatusListeners) {
        try {
          listener(status);
        } catch (err) {
          logger.error({ err }, "Error in probeStatusListener callback");
        }
      }

      if (
        this.state === "PRIMARY_ACTIVE" &&
        (status.state === "ERROR" || status.state === "DISCONNECTED")
      ) {
        const tripped = this.circuitBreaker.recordFailure(status.error ?? "Primary socket dropped");
        if (tripped) {
          logger.warn({ status }, "Circuit breaker tripped due to primary driver status change");
          void this.triggerFailover("Primary socket degraded/disconnected");
        }
      }
    });

    // Standby driver health monitoring during FALLBACK_ACTIVE
    this.standby.onStatusChange((status) => {
      if (this.isShuttingDown) return;

      if (this.state === "FALLBACK_ACTIVE") {
        if (status.state === "CONNECTED") {
          logger.info("Standby driver connected/recovered; flushing outbound buffer");
          void this.flushOutboundBuffer();
        } else if (status.state === "DEGRADED") {
          logger.warn(
            { status },
            "Standby driver degraded (recovering); outbound messages will buffer",
          );
        } else if (
          status.state === "ERROR" ||
          status.state === "DISCONNECTED" ||
          status.state === "UNPAIRED"
        ) {
          this.lastError = status.error ?? `Standby driver status changed to ${status.state}`;
          logger.error(
            { status, state: this.state },
            "Standby driver degraded or disconnected during FALLBACK_ACTIVE",
          );

          if (this.primary.getStatus().connected) {
            logger.info("Primary driver is connected; triggering immediate failback recovery");
            void this.triggerFailback("Standby crashed and primary is healthy");
          } else {
            void this.executeSilentProbe();
          }
        }
      }
    });
  }

  private async dispatchInboundMessage(msg: InboundMessage): Promise<void> {
    for (const listener of this.messageListeners) {
      try {
        await listener(msg);
      } catch (err) {
        logger.error({ err }, "Error in inbound message listener");
      }
    }
  }

  private async disconnectPrimarySafely(): Promise<void> {
    try {
      await this.primary.disconnect();
    } catch (err) {
      logger.warn({ err }, "Error disconnecting primary during fencing; proceeding");
    }
  }

  private startSilentProbeLoop(): void {
    if (this.disableBackgroundProbeTimer || this.probeTimer) return;
    this.probeTimer = setInterval(() => {
      void this.executeSilentProbe();
    }, this.probeIntervalMs);
  }

  private stopSilentProbeLoop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  private async flushOutboundBuffer(): Promise<void> {
    if (this.isShuttingDown || this.state === "SHUTDOWN") {
      this.drainOutboundBuffer("FailoverOrchestrator is shutting down");
      return;
    }

    const driver = this.getCurrentActiveDriver();
    if (!driver) return;

    while (this.outboundBuffer.length > 0) {
      const item = this.outboundBuffer.shift();
      if (!item) continue;
      try {
        const receipt = await driver.sendMessage(item.to, item.content);
        item.resolve(receipt);
      } catch (err) {
        item.reject(err);
      }
    }
  }

  private isBufferingState(): boolean {
    return (
      this.state === "FENCING" ||
      this.state === "COLD_START_STANDBY" ||
      this.state === "RECOVERY_SWAP" ||
      (this.state === "FALLBACK_ACTIVE" && this.standby.getStatus().state === "DEGRADED")
    );
  }

  private getCurrentActiveDriver(): IWhatsAppDriver | null {
    if (this.activeEngine === "baileys") return this.primary;
    if (this.activeEngine === "wwebjs") return this.standby;
    return null;
  }

  private async transitionTo(
    nextState: FailoverState,
    event: FailoverEvent,
    reason?: string,
  ): Promise<void> {
    const from = this.state;
    this.state = nextState;
    this.lastTransitionAt = new Date();

    if (nextState === "FALLBACK_ACTIVE" && from !== "FALLBACK_ACTIVE") {
      this.failoverCount++;
    }
    if (nextState === "PRIMARY_ACTIVE" && from === "RECOVERY_SWAP") {
      this.failbackCount++;
    }

    logger.info({ from, to: nextState, event, reason }, "FSM transition");

    for (const listener of this.stateListeners) {
      try {
        listener(from, nextState, event, reason);
      } catch (err) {
        logger.error({ err }, "Error in state change listener");
      }
    }
  }
}
