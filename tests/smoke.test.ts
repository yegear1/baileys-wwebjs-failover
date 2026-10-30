import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createGatewayLogger, getGatewayInfo, logger } from "../src/index.js";

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

  it("emits canonical single-line NDJSON matching VictoriaLogs contract", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });

    const testLogger = createGatewayLogger({
      level: "info",
      service: "baileys-wwebjs-failover",
      env: "production",
      destination,
    });

    testLogger.info({ request_id: "req-101", trace_id: "tr-202" }, "Failover probe completed");

    expect(lines).toHaveLength(1);
    const rawLine = lines[0];
    expect(rawLine).toBeDefined();
    expect(rawLine?.endsWith("\n")).toBe(true);
    expect(rawLine?.trim().includes("\n")).toBe(false);

    const parsed = JSON.parse(rawLine ?? "{}") as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.service).toBe("baileys-wwebjs-failover");
    expect(parsed.app).toBe("baileys-wwebjs-failover");
    expect(parsed.env).toBe("production");
    expect(parsed.message).toBe("Failover probe completed");
    expect(parsed.msg).toBeUndefined();
    expect(parsed.request_id).toBe("req-101");
    expect(parsed.trace_id).toBe("tr-202");
    expect(typeof parsed.timestamp).toBe("string");
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(parsed.timestamp))).toBe(
      true,
    );
  });
});
