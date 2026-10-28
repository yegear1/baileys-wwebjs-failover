export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures within sliding window required to trip.
   * Default: 3 (recommended: 3 to 5).
   */
  readonly failureThreshold?: number;

  /**
   * Duration of sliding window in milliseconds.
   * Default: 60,000 ms (1 minute).
   */
  readonly windowMs?: number;

  /**
   * Number of consecutive successful probes required to verify recovery.
   * Default: 3.
   */
  readonly probeSuccessThreshold?: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly probeSuccessThreshold: number;

  private state: CircuitState = "CLOSED";
  private failureTimestamps: number[] = [];
  private consecutiveFailures = 0;
  private probeSuccesses = 0;
  private lastError: string | undefined = undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 60_000;
    this.probeSuccessThreshold = options.probeSuccessThreshold ?? 3;
  }

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    this.pruneExpiredFailures();
    return this.consecutiveFailures;
  }

  getProbeSuccesses(): number {
    return this.probeSuccesses;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Records a successful operation or probe.
   * Returns true if a recovery threshold was reached in HALF_OPEN state.
   */
  recordSuccess(): boolean {
    if (this.state === "CLOSED") {
      this.consecutiveFailures = 0;
      this.failureTimestamps = [];
      return false;
    }

    if (this.state === "HALF_OPEN") {
      this.probeSuccesses += 1;
      // INVARIANT: Recovery requires consecutive successful probes to prevent flapping
      if (this.probeSuccesses >= this.probeSuccessThreshold) {
        this.reset();
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * Records a failure in the sliding window.
   * Returns true if this failure caused the circuit to trip to OPEN.
   */
  recordFailure(error?: unknown): boolean {
    const now = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error ?? "Unknown error");
    this.failureTimestamps.push(now);
    this.pruneExpiredFailures(now);
    this.consecutiveFailures += 1;

    if (this.state === "HALF_OPEN") {
      // INVARIANT: Any probe failure immediately aborts probe recovery and returns to OPEN
      this.probeSuccesses = 0;
      this.state = "OPEN";
      return true;
    }

    if (this.state === "CLOSED" && this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
      return true;
    }

    return false;
  }

  /**
   * Initiates half-open probe mode from OPEN state.
   */
  startProbe(): void {
    if (this.state === "OPEN") {
      this.state = "HALF_OPEN";
      this.probeSuccesses = 0;
    }
  }

  /**
   * Forces the circuit into OPEN state.
   */
  trip(reason?: string): void {
    this.state = "OPEN";
    if (reason) {
      this.lastError = reason;
    }
  }

  /**
   * Resets the circuit to CLOSED and clears counters.
   */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.failureTimestamps = [];
    this.probeSuccesses = 0;
    this.lastError = undefined;
  }

  private pruneExpiredFailures(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    const initialCount = this.failureTimestamps.length;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);

    // If all failures expired, reset consecutive failure count
    if (this.failureTimestamps.length === 0 && initialCount > 0) {
      this.consecutiveFailures = 0;
    }
  }
}
