import dns from "node:dns/promises";

export interface HostConnectivityOptions {
  /**
   * Target host to verify WAN resolution/connectivity.
   * Default: "dns.google"
   */
  readonly host?: string;
  /**
   * Timeout in milliseconds before treating host as unreachable.
   * Default: 3000ms
   */
  readonly timeoutMs?: number;
  /**
   * Custom lookup function for dependency injection in tests.
   */
  readonly lookupFn?: (host: string) => Promise<unknown>;
}

/**
 * Probes host network WAN connectivity.
 * Returns true if WAN DNS resolution succeeds, false if offline or timed out.
 *
 * INVARIANT: Used by FailoverOrchestrator to prevent false failovers to WWebJS
 * during host WAN outages. If host has no internet, WWebJS will fail too;
 * launching Chromium wastes 500MB+ RAM and causes unnecessary thrashing.
 */
export async function checkHostConnectivity(
  options: HostConnectivityOptions = {},
): Promise<boolean> {
  const host = options.host ?? "dns.google";
  const timeoutMs = options.timeoutMs ?? 3000;
  const lookup = options.lookupFn ?? ((target: string) => dns.lookup(target));

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Host connectivity probe timed out")), timeoutMs);
      timer.unref?.();
    });

    await Promise.race([lookup(host), timeoutPromise]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
