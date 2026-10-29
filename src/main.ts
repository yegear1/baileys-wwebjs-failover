import { GatewayApplication } from "./bootstrap/app.js";
import { loadGatewayConfig } from "./bootstrap/config.js";
import { logger } from "./index.js";

/**
 * Main application executable entrypoint.
 */
export async function main(): Promise<void> {
  try {
    const config = loadGatewayConfig();
    const app = new GatewayApplication({ config });
    app.setupSignalHandlers();
    await app.start();
  } catch (error: unknown) {
    logger.fatal(
      { err: error },
      "Gateway failed during bootstrap initialization; terminating process",
    );
    process.exit(1);
  }
}

// Automatically invoke if executed directly via node dist/main.js
if (process.argv[1]?.endsWith("main.js")) {
  void main();
}
