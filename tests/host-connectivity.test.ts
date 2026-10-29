import { describe, expect, it, vi } from "vitest";
import { checkHostConnectivity } from "../src/utils/host-connectivity.js";

describe("checkHostConnectivity", () => {
  it("returns true when DNS lookup succeeds within timeout", async () => {
    const mockLookup = vi.fn().mockResolvedValue({ address: "8.8.8.8", family: 4 });

    const result = await checkHostConnectivity({
      lookupFn: mockLookup,
      timeoutMs: 1000,
    });

    expect(result).toBe(true);
    expect(mockLookup).toHaveBeenCalledWith("dns.google");
  });

  it("returns false when DNS lookup fails with network error", async () => {
    const mockLookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));

    const result = await checkHostConnectivity({
      lookupFn: mockLookup,
      timeoutMs: 1000,
    });

    expect(result).toBe(false);
  });

  it("returns false when DNS lookup times out", async () => {
    const mockLookup = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));

    const result = await checkHostConnectivity({
      lookupFn: mockLookup,
      timeoutMs: 50,
    });

    expect(result).toBe(false);
  });
});
