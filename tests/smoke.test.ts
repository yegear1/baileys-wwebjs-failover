import { describe, expect, it } from "vitest";
import { getGatewayInfo, logger } from "../src/index.js";

describe("Gateway bootstrap smoke test", () => {
  it("returns project metadata matching package.json", () => {
    const info = getGatewayInfo();
    expect(info.name).toBe("baileys-wwebjs-failover");
    expect(info.version).toBe("0.1.0");
  });

  it("initializes pino logger instance", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });
});
