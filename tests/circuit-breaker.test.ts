import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/fsm/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("initializes in CLOSED state with zero failures", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getProbeSuccesses()).toBe(0);
  });

  it("trips to OPEN after consecutive failures reach threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    expect(cb.recordFailure("socket error 1")).toBe(false);
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getConsecutiveFailures()).toBe(1);

    expect(cb.recordFailure("socket error 2")).toBe(false);
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getConsecutiveFailures()).toBe(2);

    expect(cb.recordFailure("socket error 3")).toBe(true);
    expect(cb.getState()).toBe("OPEN");
    expect(cb.getConsecutiveFailures()).toBe(3);
    expect(cb.getLastError()).toBe("socket error 3");
  });

  it("resets consecutive failures when a success is recorded in CLOSED state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    cb.recordFailure("temporary error");
    expect(cb.getConsecutiveFailures()).toBe(1);

    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("transitions to HALF_OPEN and recovers after probe success threshold is met", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, probeSuccessThreshold: 3 });
    cb.trip("manual trip");
    expect(cb.getState()).toBe("OPEN");

    cb.startProbe();
    expect(cb.getState()).toBe("HALF_OPEN");

    expect(cb.recordSuccess()).toBe(false);
    expect(cb.getProbeSuccesses()).toBe(1);

    expect(cb.recordSuccess()).toBe(false);
    expect(cb.getProbeSuccesses()).toBe(2);

    // 3rd success completes recovery
    expect(cb.recordSuccess()).toBe(true);
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getProbeSuccesses()).toBe(0);
    expect(cb.getConsecutiveFailures()).toBe(0);
  });

  it("aborts HALF_OPEN and reverts to OPEN immediately if a probe fails", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, probeSuccessThreshold: 3 });
    cb.trip("manual trip");
    cb.startProbe();
    cb.recordSuccess();
    expect(cb.getProbeSuccesses()).toBe(1);

    expect(cb.recordFailure("probe timed out")).toBe(true);
    expect(cb.getState()).toBe("OPEN");
    expect(cb.getProbeSuccesses()).toBe(0);
  });

  it("resets manually via reset()", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure("err");
    cb.trip("manual");
    expect(cb.getState()).toBe("OPEN");

    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getLastError()).toBeUndefined();
  });

  describe("window decay consistency", () => {
    it("decays expired failures so spaced-out failures do not trip the circuit", () => {
      // 3 failures required within 60,000ms window
      const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000 });
      const t0 = 1_000_000;

      // Failure 1 at t0
      expect(cb.recordFailure("err 1", t0)).toBe(false);
      expect(cb.getConsecutiveFailures(t0)).toBe(1);

      // Failure 2 at t0 + 70s (failure 1 has expired since 70s > 60s window)
      const t1 = t0 + 70_000;
      expect(cb.recordFailure("err 2", t1)).toBe(false);
      expect(cb.getConsecutiveFailures(t1)).toBe(1);

      // Failure 3 at t0 + 140s (failure 2 has expired)
      const t2 = t1 + 70_000;
      expect(cb.recordFailure("err 3", t2)).toBe(false);
      expect(cb.getConsecutiveFailures(t2)).toBe(1);
      expect(cb.getState()).toBe("CLOSED");
    });

    it("partially decays failures when only some fall outside the sliding window", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000 });
      const t0 = 1_000_000;

      // Failures 1 and 2 in close proximity
      cb.recordFailure("err 1", t0);
      cb.recordFailure("err 2", t0 + 10_000);
      expect(cb.getConsecutiveFailures(t0 + 10_000)).toBe(2);

      // At t0 + 65s: failure 1 (at t0) has expired (>60s), but failure 2 (at t0+10s) is still valid (55s old)
      const t2 = t0 + 65_000;
      expect(cb.recordFailure("err 3", t2)).toBe(false);
      // Failures in window: err 2 (at t0+10s) and err 3 (at t0+65s) -> count = 2
      expect(cb.getConsecutiveFailures(t2)).toBe(2);
      expect(cb.getState()).toBe("CLOSED");

      // Failure 4 at t0 + 68s (within window of err 2 and err 3)
      const t3 = t0 + 68_000;
      expect(cb.recordFailure("err 4", t3)).toBe(true);
      // Now 3 failures in window: err 2 (t0+10s), err 3 (t0+65s), err 4 (t0+68s) (span = 58s <= 60s)
      expect(cb.getConsecutiveFailures(t3)).toBe(3);
      expect(cb.getState()).toBe("OPEN");
    });

    it("decays consecutive failures count to 0 after an idle period", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 30_000 });
      const t0 = 1_000_000;

      cb.recordFailure("err 1", t0);
      cb.recordFailure("err 2", t0 + 5_000);
      expect(cb.getConsecutiveFailures(t0 + 5_000)).toBe(2);

      // Idle period: query after 40 seconds
      const tIdle = t0 + 40_000;
      expect(cb.getConsecutiveFailures(tIdle)).toBe(0);
      expect(cb.getState()).toBe("CLOSED");
    });
  });
});
