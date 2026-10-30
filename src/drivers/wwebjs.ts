import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import pkg from "whatsapp-web.js";
import type { EngineStatus, IWhatsAppDriver, PresenceState } from "../contracts/driver.js";
import type { InboundMessage, MessageReceipt, OutboundMessage } from "../contracts/messages.js";
import { logger as defaultLogger } from "../index.js";
import { ensureSecureAuthDirectory, purgeAuthDirectory } from "./auth-utils.js";
import {
  mapOutboundToWWebJSContent,
  mapWWebJSMessageToInbound,
  toWWebJSChatId,
  type WWebJSMessageLike,
} from "./wwebjs-mapper.js";

const { Client, LocalAuth } = pkg;

export const DEFAULT_CHROMIUM_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
];

export interface WWebJSChatInterface {
  sendStateTyping?: () => Promise<void>;
  clearState?: () => Promise<void>;
}

export interface WWebJSPupProcess {
  pid?: number | undefined;
  killed?: boolean | undefined;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface WWebJSPupBrowser {
  process(): WWebJSPupProcess | null;
  isConnected?: () => boolean;
  pages?: () => Promise<unknown[]>;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface WWebJSPupPage {
  isClosed?: () => boolean;
  evaluate?: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface WWebJSClientInterface {
  info?: {
    wid?: {
      _serialized?: string;
    };
  };
  pupBrowser?: WWebJSPupBrowser;
  pupPage?: WWebJSPupPage;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: unknown,
  ): Promise<{ id?: { id?: string; _serialized?: string } }>;
  sendPresenceAvailable?: () => Promise<void>;
  getChatById?: (chatId: string) => Promise<WWebJSChatInterface>;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ChromiumHealthReport {
  readonly isHealthy: boolean;
  readonly browserConnected: boolean;
  readonly pageResponsive: boolean;
  readonly zombieDetected: boolean;
  readonly pid?: number | undefined;
  readonly restartCount: number;
  readonly error?: string | undefined;
}

export interface WWebJSDriverOptions {
  readonly authDir?: string;
  readonly logger?: Logger;
  readonly chromiumArgs?: string[];
  readonly teardownTimeoutMs?: number;
  readonly executablePath?: string;
  readonly clientFactory?: (options: pkg.ClientOptions) => WWebJSClientInterface;
  /**
   * Timeout in milliseconds waiting for WWebJS 'ready' event during connect.
   * Default: 45,000 ms (45s).
   */
  readonly readyTimeoutMs?: number;
  /**
   * Whether connect() awaits the 'ready' event before resolving.
   * Default: true.
   */
  readonly awaitReady?: boolean;
  /**
   * Interval in milliseconds for periodic dynamic Chromium health checks.
   * Default: 0 (disabled by default in tests; set e.g. 15,000 in production).
   */
  readonly healthCheckIntervalMs?: number;
  /**
   * Timeout in milliseconds for Chromium page responsiveness evaluation during health check.
   * Default: 3,000 ms (3s).
   */
  readonly pageProbeTimeoutMs?: number;
  /**
   * Whether automated Puppeteer restart recovery is enabled when browser crashes or becomes zombie.
   * Default: true.
   */
  readonly enableAutoRecovery?: boolean;
  /**
   * Maximum consecutive restart attempts before entering permanent ERROR state.
   * Default: 3.
   */
  readonly maxRestartRetries?: number;
  /**
   * Base backoff delay in milliseconds between restart recovery attempts.
   * Default: 1,000 ms (1s).
   */
  readonly restartBackoffMs?: number;
  /**
   * Whether to automatically tear down Chromium and purge invalidated LocalAuth profile
   * data when the companion device is explicitly logged out or fails authentication.
   * Default: true.
   */
  readonly autoPurgeOnLogout?: boolean;
}

/**
 * Checks if a process with given PID is alive in the OS.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Checks if a Linux process is in zombie (Z) state.
 */
export function isProcessZombie(pid: number): boolean {
  if (process.platform !== "linux" || !isProcessAlive(pid)) {
    return false;
  }
  try {
    const statusContent = readFileSync(`/proc/${pid}/status`, "utf8");
    return /State:\s+Z\s+\(zombie\)/i.test(statusContent);
  } catch {
    return false;
  }
}

/**
 * Scans an auth directory and removes orphaned Chromium lockfiles
 * (SingletonLock, SingletonCookie, SingletonSocket).
 */
export function cleanupChromiumLocks(dir: string, logger?: Logger): string[] {
  const removed: string[] = [];
  if (!existsSync(dir)) return removed;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            stack.push(fullPath);
          }
        } else if (entry.isSymbolicLink() || entry.isFile()) {
          if (
            entry.name.startsWith("SingletonLock") ||
            entry.name.startsWith("SingletonCookie") ||
            entry.name.startsWith("SingletonSocket")
          ) {
            try {
              unlinkSync(fullPath);
              removed.push(fullPath);
              logger?.debug({ path: fullPath }, "Removed stale Chromium lockfile");
            } catch (unlinkErr) {
              logger?.warn({ unlinkErr, path: fullPath }, "Failed to remove Chromium lockfile");
            }
          }
        }
      }
    } catch {
      // Ignore read errors on inaccessible subdirectories
    }
  }
  return removed;
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutErrMsg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutErrMsg)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Driver adapter for WhatsApp Web via Puppeteer / whatsapp-web.js.
 *
 * INVARIANT: WWebJS serves as the cold-standby backup engine. It must strictly
 * implement IWhatsAppDriver, enforce secure 0700 auth permissions, apply Chromium
 * container hygiene flags, proactively detect zombie browser processes, and forcefully
 * kill zombie browser processes upon disconnect to reclaim ~500MB container RAM.
 */
export class WWebJSDriver implements IWhatsAppDriver {
  public readonly name = "wwebjs" as const;

  private readonly authDir: string;
  private readonly logger: Logger;
  private readonly chromiumArgs: string[];
  private readonly teardownTimeoutMs: number;
  private readonly executablePath: string | undefined;
  private readonly clientFactory: (options: pkg.ClientOptions) => WWebJSClientInterface;
  private readonly readyTimeoutMs: number;
  private readonly awaitReady: boolean;
  private readonly healthCheckIntervalMs: number;
  private readonly pageProbeTimeoutMs: number;
  private readonly enableAutoRecovery: boolean;
  private readonly maxRestartRetries: number;
  private readonly restartBackoffMs: number;
  private readonly autoPurgeOnLogout: boolean;

  private client: WWebJSClientInterface | null = null;
  private qrCode: string | undefined = undefined;
  private status: EngineStatus = {
    engine: "wwebjs",
    state: "DISCONNECTED",
    connected: false,
    restartCount: 0,
    isHealthy: true,
  };

  private restartCount = 0;
  private totalRestarts = 0;
  private isRecovering = false;
  private isExplicitDisconnect = false;
  private lastKnownPid: number | undefined = undefined;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private recoveryRetryTimer: NodeJS.Timeout | null = null;

  private readonly messageHandlers: Set<(msg: InboundMessage) => Promise<void>> = new Set();
  private readonly statusHandlers: Set<(status: EngineStatus) => void> = new Set();

  constructor(options: WWebJSDriverOptions = {}) {
    this.authDir = options.authDir ?? process.env.AUTH_DIR_WWEBJS ?? "/data/auth/wwebjs";
    this.logger = options.logger ?? defaultLogger;
    this.chromiumArgs = options.chromiumArgs ?? DEFAULT_CHROMIUM_FLAGS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? 5000;
    this.executablePath = options.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH;
    this.clientFactory =
      options.clientFactory ??
      ((opts: pkg.ClientOptions) => new Client(opts) as unknown as WWebJSClientInterface);
    this.readyTimeoutMs = options.readyTimeoutMs ?? 45_000;
    this.awaitReady = options.awaitReady ?? true;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 0;
    this.pageProbeTimeoutMs = options.pageProbeTimeoutMs ?? 3000;
    this.enableAutoRecovery = options.enableAutoRecovery ?? true;
    this.maxRestartRetries = options.maxRestartRetries ?? 3;
    this.restartBackoffMs = options.restartBackoffMs ?? 1000;
    this.autoPurgeOnLogout = options.autoPurgeOnLogout ?? true;
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  public getQrCode(): string | undefined {
    return this.qrCode;
  }

  public getSelfJid(): string | undefined {
    return this.client?.info?.wid?._serialized;
  }

  public getRestartCount(): number {
    return this.restartCount;
  }

  public getTotalRestarts(): number {
    return this.totalRestarts;
  }

  public async sendPresence(to: string, state: PresenceState): Promise<void> {
    if (!this.client || !this.status.connected) {
      throw new Error("Cannot send presence: WWebJS driver is not connected");
    }

    const targetChatId = toWWebJSChatId(to);

    try {
      if (this.client.getChatById) {
        const chat = await this.client.getChatById(targetChatId);
        if (state === "composing") {
          await chat.sendStateTyping?.();
        } else {
          await chat.clearState?.();
        }
      } else if (state === "composing" && this.client.sendPresenceAvailable) {
        await this.client.sendPresenceAvailable();
      }
    } catch (err) {
      this.logger.warn({ err, to, state }, "Failed to send presence state in WWebJS");
    }
  }

  public onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.add(handler);
  }

  public onStatusChange(handler: (status: EngineStatus) => void): void {
    this.statusHandlers.add(handler);
  }

  public async connect(): Promise<void> {
    ensureSecureAuthDirectory(this.authDir);
    this.isExplicitDisconnect = false;

    this.updateStatus({
      engine: "wwebjs",
      state: "CONNECTING",
      connected: false,
      restartCount: this.restartCount,
      isHealthy: false,
    });

    try {
      const client = this.clientFactory({
        authStrategy: new LocalAuth({
          dataPath: this.authDir,
        }),
        puppeteer: {
          headless: true,
          args: [...this.chromiumArgs],
          ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        },
        takeoverOnConflict: true,
      });

      this.client = client;
      const initialPid = client.pupBrowser?.process?.()?.pid;
      if (initialPid) {
        this.lastKnownPid = initialPid;
      }
      this.wireClientEvents(client);

      if (!this.awaitReady) {
        await client.initialize();
        return;
      }

      // INVARIANT: Callers must only proceed when the driver is genuinely ready to send and receive messages
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          client.on("ready", () => {});
        };

        const onReady = () => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        };

        const onAuthFailure = (err: unknown) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`WWebJS authentication failed: ${String(err)}`));
          }
        };

        const onDisconnected = (reason: unknown) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`WWebJS disconnected before ready: ${String(reason)}`));
          }
        };

        client.on("ready", onReady);
        client.on("auth_failure", onAuthFailure);
        client.on("disconnected", onDisconnected);

        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `WWebJS connect timed out waiting for 'ready' event after ${this.readyTimeoutMs}ms`,
              ),
            );
          }
        }, this.readyTimeoutMs);
        timer.unref?.();

        client.initialize().catch((err) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        });
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.updateStatus({
        engine: "wwebjs",
        state: "ERROR",
        connected: false,
        error: errorMessage,
        restartCount: this.restartCount,
        isHealthy: false,
      });
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    this.isExplicitDisconnect = true;
    this.isRecovering = false;
    this.stopHealthCheckTimer();
    this.clearRecoveryRetryTimer();

    if (this.client) {
      const client = this.client;
      this.client = null;
      this.qrCode = undefined;

      const browserProcess = client.pupBrowser?.process?.();
      const pid = browserProcess?.pid ?? this.lastKnownPid;

      try {
        await runWithTimeout(client.destroy(), this.teardownTimeoutMs, "Client destroy timeout");
      } catch (err) {
        this.logger.warn(
          { err },
          "WWebJS client.destroy() timed out or failed; proceeding to process-tree SIGKILL",
        );
      }

      // INVARIANT: Chromium child processes can survive client.destroy() as orphaned zombie processes;
      // forceful process-tree SIGKILL guarantees freeing ~500MB of container memory.
      if (pid && (isProcessAlive(pid) || !browserProcess?.killed)) {
        this.terminateProcessTree(pid);
      }
    }

    this.cleanupStandbyHygiene();

    this.updateStatus({
      engine: "wwebjs",
      state: "DISCONNECTED",
      connected: false,
      restartCount: this.restartCount,
      isHealthy: true,
    });
  }

  public async sendMessage(to: string, content: OutboundMessage): Promise<MessageReceipt> {
    if (!this.client || !this.status.connected) {
      throw new Error("Cannot send message: WWebJS driver is not connected");
    }

    const targetChatId = toWWebJSChatId(to);
    const { content: wwebContent, options } = await mapOutboundToWWebJSContent(content);

    const sent = await this.client.sendMessage(targetChatId, wwebContent, options);
    const messageId = sent?.id?.id ?? sent?.id?._serialized ?? randomUUID();

    return {
      id: messageId,
      to,
      timestamp: Date.now(),
      status: "SENT",
    };
  }

  /**
   * Proactively inspects the Chromium instance, verifying process liveness,
   * browser CDP connectivity, and page execution responsiveness.
   */
  public async checkHealth(): Promise<ChromiumHealthReport> {
    if (!this.client) {
      const isStandbyOrDisconnected =
        this.status.state === "DISCONNECTED" || this.status.state === "STANDBY";
      return {
        isHealthy: isStandbyOrDisconnected,
        browserConnected: false,
        pageResponsive: false,
        zombieDetected: false,
        restartCount: this.restartCount,
        ...(isStandbyOrDisconnected
          ? {}
          : { error: "No active WWebJS client instance found in non-disconnected state" }),
      };
    }

    const browser = this.client.pupBrowser;
    const browserProcess = browser?.process?.();
    const pid = browserProcess?.pid ?? this.lastKnownPid;

    // 1. Check process liveness & zombie state
    const processAlive = pid !== undefined ? isProcessAlive(pid) : false;
    const zombieDetected = pid !== undefined ? isProcessZombie(pid) : false;

    // 2. Check browser CDP connection
    const browserConnected =
      browser && typeof browser.isConnected === "function" ? browser.isConnected() : processAlive;

    // 3. Check page responsiveness
    let pageResponsive = false;
    const page = this.client.pupPage;
    if (page) {
      if (typeof page.isClosed === "function" && page.isClosed()) {
        pageResponsive = false;
      } else if (typeof page.evaluate === "function") {
        try {
          await runWithTimeout(
            page.evaluate(() => 1),
            this.pageProbeTimeoutMs,
            "Page probe timeout",
          );
          pageResponsive = true;
        } catch {
          pageResponsive = false;
        }
      } else {
        pageResponsive = browserConnected;
      }
    } else {
      pageResponsive = browserConnected && processAlive && !zombieDetected;
    }

    const isHealthy = Boolean(
      this.status.connected &&
        browserConnected &&
        processAlive &&
        !zombieDetected &&
        pageResponsive,
    );

    let errorDetail: string | undefined;
    if (!isHealthy) {
      if (!this.status.connected) {
        errorDetail = `Driver status state is ${this.status.state}`;
      } else if (zombieDetected) {
        errorDetail = `Zombie Chromium process detected (PID ${pid})`;
      } else if (!processAlive) {
        errorDetail = `Chromium process terminated unexpectedly (PID ${pid ?? "unknown"})`;
      } else if (!browserConnected) {
        errorDetail = "Chromium CDP browser connection disconnected";
      } else if (!pageResponsive) {
        errorDetail = "Chromium page execution is unresponsive";
      }
    }

    return {
      isHealthy,
      browserConnected,
      pageResponsive,
      zombieDetected,
      pid,
      restartCount: this.restartCount,
      ...(errorDetail ? { error: errorDetail } : {}),
    };
  }

  /**
   * Recovers an unhealthy Chromium instance by forcefully terminating lingering processes,
   * removing stale lockfiles, and gracefully relaunching Puppeteer.
   */
  public async recover(reason = "Unhealthy Chromium detected"): Promise<void> {
    if (this.isExplicitDisconnect || this.status.state === "DISCONNECTED") {
      this.logger.info("Skipping Chromium recovery: driver is intentionally disconnected");
      return;
    }

    if (this.isRecovering) {
      this.logger.debug("Chromium recovery already in progress; skipping duplicate trigger");
      return;
    }

    if (this.restartCount >= this.maxRestartRetries) {
      this.logger.error(
        { restartCount: this.restartCount, maxRetries: this.maxRestartRetries, reason },
        "Exceeded max Chromium restart retries; transitioning to ERROR state",
      );
      this.stopHealthCheckTimer();
      this.updateStatus({
        engine: "wwebjs",
        state: "ERROR",
        connected: false,
        error: `Exceeded max restart retries (${this.maxRestartRetries}): ${reason}`,
        restartCount: this.restartCount,
        isHealthy: false,
      });
      return;
    }

    this.isRecovering = true;
    this.stopHealthCheckTimer();
    const attempt = this.restartCount + 1;

    this.logger.warn(
      { attempt, maxRetries: this.maxRestartRetries, reason },
      "Initiating graceful Puppeteer / Chromium restart recovery",
    );

    this.updateStatus({
      engine: "wwebjs",
      state: "DEGRADED",
      connected: false,
      error: `Recovering Chromium (${reason}); attempt ${attempt}/${this.maxRestartRetries}`,
      restartCount: this.restartCount,
      isHealthy: false,
    });

    try {
      // 1. Force kill existing browser process tree
      const browserProcess = this.client?.pupBrowser?.process?.();
      const pid = browserProcess?.pid ?? this.lastKnownPid;
      if (pid) {
        this.terminateProcessTree(pid);
      }

      // 2. Safe client destroy with timeout
      if (this.client) {
        const clientToDestroy = this.client;
        this.client = null;
        try {
          await runWithTimeout(
            clientToDestroy.destroy(),
            this.teardownTimeoutMs,
            "Client destroy timeout during recovery",
          );
        } catch (destroyErr) {
          this.logger.debug({ destroyErr }, "Ignored error during client destroy in recovery");
        }
      }

      // 3. Clean up stale lockfiles
      cleanupChromiumLocks(this.authDir, this.logger);

      // 4. Backoff delay
      const backoffMs = this.restartBackoffMs * attempt;
      if (backoffMs > 0) {
        await new Promise((res) => setTimeout(res, backoffMs));
      }

      if (this.isExplicitDisconnect) {
        this.logger.info("Driver was disconnected during recovery backoff; halting recovery");
        return;
      }

      // 5. Update restart tracking
      this.restartCount = attempt;
      this.totalRestarts++;

      // 6. Reconnect
      await this.connect();

      this.logger.info(
        { restartCount: this.restartCount, totalRestarts: this.totalRestarts },
        "Puppeteer / Chromium restart recovery succeeded",
      );
    } catch (err) {
      this.logger.error(
        { err, attempt, maxRetries: this.maxRestartRetries },
        "Failed during Chromium restart recovery attempt",
      );

      if (this.restartCount < this.maxRestartRetries && !this.isExplicitDisconnect) {
        this.clearRecoveryRetryTimer();
        this.recoveryRetryTimer = setTimeout(() => {
          this.recoveryRetryTimer = null;
          void this.recover(`Subsequent retry after failed attempt: ${String(err)}`);
        }, this.restartBackoffMs);
        this.recoveryRetryTimer.unref?.();
      } else {
        this.updateStatus({
          engine: "wwebjs",
          state: "ERROR",
          connected: false,
          error: `Exceeded max restart retries (${this.maxRestartRetries}): ${String(err)}`,
          restartCount: this.restartCount,
          isHealthy: false,
        });
      }
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Explicit restart trigger adhering to IWhatsAppDriver contract.
   */
  public async restart(): Promise<void> {
    this.restartCount = 0;
    await this.recover("Manual restart requested");
  }

  /**
   * Standby hygiene routine ensuring no lingering zombie processes or stale lockfiles exist.
   */
  public cleanupStandbyHygiene(): {
    locksRemoved: string[];
    zombiePidsTerminated: number[];
  } {
    const terminatedPids: number[] = [];
    const locksRemoved = cleanupChromiumLocks(this.authDir, this.logger);

    if (this.lastKnownPid && isProcessAlive(this.lastKnownPid)) {
      this.logger.warn(
        { pid: this.lastKnownPid },
        "Terminating lingering Chromium process detected during standby hygiene",
      );
      this.terminateProcessTree(this.lastKnownPid);
      terminatedPids.push(this.lastKnownPid);
      this.lastKnownPid = undefined;
    }

    return { locksRemoved, zombiePidsTerminated: terminatedPids };
  }

  private wireClientEvents(client: WWebJSClientInterface): void {
    client.on("qr", (qr: unknown) => {
      if (typeof qr === "string") {
        this.qrCode = qr;
        this.updateStatus({
          engine: "wwebjs",
          state: "PAIRING_QR_READY",
          connected: false,
          restartCount: this.restartCount,
          isHealthy: false,
        });
      }
    });

    client.on("ready", () => {
      this.qrCode = undefined;
      const browserPid = client.pupBrowser?.process?.()?.pid;
      if (browserPid) {
        this.lastKnownPid = browserPid;
      }
      this.updateStatus({
        engine: "wwebjs",
        state: "CONNECTED",
        connected: true,
        lastSeen: new Date(),
        restartCount: this.restartCount,
        isHealthy: true,
      });
      this.startHealthCheckTimer();
    });

    client.on("authenticated", () => {
      this.qrCode = undefined;
    });

    client.on("auth_failure", (msg: unknown) => {
      const error = typeof msg === "string" ? msg : "Authentication failed";
      this.handleCompanionLogout(client, error);
    });

    client.on("disconnected", (reason: unknown) => {
      this.qrCode = undefined;
      const reasonStr = typeof reason === "string" ? reason : "Disconnected";
      const upperReason = reasonStr.toUpperCase();
      const isLoggedOut = upperReason.includes("LOGOUT") || upperReason.includes("NAVIGATION");

      if (isLoggedOut) {
        this.handleCompanionLogout(client, reasonStr);
      } else {
        this.handleUnexpectedBrowserTermination(reasonStr);
      }
    });

    client.on("change_battery", (batteryInfo: unknown) => {
      if (
        batteryInfo &&
        typeof batteryInfo === "object" &&
        "battery" in batteryInfo &&
        typeof batteryInfo.battery === "number"
      ) {
        this.updateStatus({
          ...this.status,
          batteryLevel: batteryInfo.battery,
        });
      }
    });

    client.on("message", async (rawMessage: unknown) => {
      if (this.messageHandlers.size === 0 || !rawMessage || typeof rawMessage !== "object") {
        return;
      }

      const selfJid = client.info?.wid?._serialized;
      const inbound = mapWWebJSMessageToInbound(rawMessage as WWebJSMessageLike, selfJid);
      if (inbound) {
        for (const handler of this.messageHandlers) {
          try {
            await handler(inbound);
          } catch (err) {
            this.logger.error({ err, msgId: inbound.id }, "Error in messageHandler for WWebJS");
          }
        }
      }
    });

    // Wire deep Chromium browser process & page lifecycle listeners
    if (client.pupBrowser && typeof client.pupBrowser.on === "function") {
      client.pupBrowser.on("disconnected", () => {
        this.logger.warn("Chromium pupBrowser emitted 'disconnected' event");
        this.handleUnexpectedBrowserTermination("Browser disconnected");
      });
    }

    const browserProcess = client.pupBrowser?.process?.();
    if (browserProcess && typeof browserProcess.on === "function") {
      browserProcess.on("exit", (code, signal) => {
        this.logger.warn({ code, signal }, "Chromium child process emitted 'exit' event");
        this.handleUnexpectedBrowserTermination(
          `Browser process exited with code ${String(code)}, signal ${String(signal)}`,
        );
      });
    }

    if (client.pupPage && typeof client.pupPage.on === "function") {
      client.pupPage.on("error", (err: unknown) => {
        this.logger.error({ err }, "Chromium page crashed (error event)");
        this.handleUnexpectedBrowserTermination("Page crashed");
      });
      client.pupPage.on("close", () => {
        if (this.status.connected && !this.isExplicitDisconnect && !this.isRecovering) {
          this.logger.warn("Chromium main page closed unexpectedly");
          this.handleUnexpectedBrowserTermination("Page closed");
        }
      });
    }
  }

  private handleCompanionLogout(client: WWebJSClientInterface, reason: string): void {
    this.qrCode = undefined;
    this.stopHealthCheckTimer();
    this.clearRecoveryRetryTimer();

    if (this.autoPurgeOnLogout) {
      this.logger.warn(
        { authDir: this.authDir, reason },
        "WWebJS companion device logged out or failed auth; purging invalidated profile state",
      );
      try {
        purgeAuthDirectory(this.authDir);
      } catch (purgeErr) {
        this.logger.error({ purgeErr, authDir: this.authDir }, "Failed to purge WWebJS authDir");
      }
    }

    this.updateStatus({
      engine: "wwebjs",
      state: "UNPAIRED",
      connected: false,
      error: reason,
      restartCount: this.restartCount,
      isHealthy: false,
    });

    if (this.autoPurgeOnLogout) {
      void this.teardownLoggedOutClient(client);
    }
  }

  private async teardownLoggedOutClient(client: WWebJSClientInterface): Promise<void> {
    if (this.client === client) {
      this.client = null;
    }

    const browserProcess = client.pupBrowser?.process?.();
    const pid = browserProcess?.pid ?? this.lastKnownPid;

    try {
      await runWithTimeout(
        client.destroy(),
        this.teardownTimeoutMs,
        "Client destroy timeout on logout",
      );
    } catch (err) {
      this.logger.debug({ err }, "WWebJS client.destroy() failed during logout teardown");
    }

    if (pid && (isProcessAlive(pid) || !browserProcess?.killed)) {
      this.terminateProcessTree(pid);
    }

    // INVARIANT: Re-purge after Chromium teardown in case the browser process flushed lockfiles
    // or LevelDB state during shutdown.
    try {
      purgeAuthDirectory(this.authDir);
    } catch {
      // Ignore post-teardown purge errors
    }
  }

  private handleUnexpectedBrowserTermination(reason: string): void {
    if (
      this.isExplicitDisconnect ||
      this.status.state === "DISCONNECTED" ||
      this.status.state === "UNPAIRED"
    ) {
      return;
    }
    if (this.isRecovering) {
      return;
    }

    this.logger.warn({ reason }, "Unexpected Chromium browser termination or failure detected");

    if (this.enableAutoRecovery) {
      void this.recover(reason);
    } else {
      this.updateStatus({
        engine: "wwebjs",
        state: "ERROR",
        connected: false,
        error: reason,
        restartCount: this.restartCount,
        isHealthy: false,
      });
    }
  }

  private startHealthCheckTimer(): void {
    if (this.healthCheckIntervalMs <= 0 || this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      void this.executePeriodicHealthCheck();
    }, this.healthCheckIntervalMs);
    this.healthCheckTimer.unref?.();
  }

  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private clearRecoveryRetryTimer(): void {
    if (this.recoveryRetryTimer) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
  }

  private async executePeriodicHealthCheck(): Promise<void> {
    if (!this.status.connected || this.isRecovering || this.isExplicitDisconnect) {
      return;
    }

    const health = await this.checkHealth();
    if (!health.isHealthy) {
      this.logger.warn({ health }, "Periodic Chromium health check reported unhealthy state");
      this.handleUnexpectedBrowserTermination(health.error ?? "Periodic health check failed");
    }
  }

  private terminateProcessTree(pid: number): void {
    if (!pid || pid <= 1 || pid === process.pid) return;
    try {
      // INVARIANT: Process group kill (-pid) signals Chromium master and all spawned renderer/GPU sub-processes.
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already terminated cleanly
      }
    }
  }

  private updateStatus(newStatus: EngineStatus): void {
    this.status = {
      restartCount: this.restartCount,
      isHealthy: newStatus.state === "CONNECTED" || newStatus.state === "DISCONNECTED",
      ...newStatus,
    };
    for (const handler of this.statusHandlers) {
      try {
        handler(this.status);
      } catch (err) {
        this.logger.error({ err }, "Error in statusHandler callback");
      }
    }
  }
}
