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
});
