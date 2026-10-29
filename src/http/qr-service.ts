import QRCode from "qrcode";
import type { IWhatsAppDriver } from "../contracts/driver.js";
import type { IQrRenderer, QrResponsePayload } from "./types.js";

/**
 * Default SVG QR code renderer backed by the battle-tested 'qrcode' library.
 */
export class DefaultQrRenderer implements IQrRenderer {
  async renderSvg(text: string): Promise<string> {
    return QRCode.toString(text, {
      type: "svg",
      margin: 2,
    });
  }
}

/**
 * Service managing pairing QR code generation and presentation for WhatsApp companion drivers.
 */
export class QrService {
  private readonly renderer: IQrRenderer;

  constructor(renderer: IQrRenderer = new DefaultQrRenderer()) {
    this.renderer = renderer;
  }

  async getQrStatus(driver: IWhatsAppDriver): Promise<QrResponsePayload> {
    const status = driver.getStatus();
    const qrRaw = typeof driver.getQrCode === "function" ? driver.getQrCode() : undefined;

    // INVARIANT: When a QR pairing code is available, generate an SVG alongside the raw token
    // for direct browser and HTML client rendering.
    if (qrRaw) {
      try {
        const qrSvg = await this.renderer.renderSvg(qrRaw);
        return {
          engine: driver.name,
          status: status.state,
          qr_raw: qrRaw,
          qr_svg: qrSvg,
        };
      } catch {
        // Degrade gracefully to raw token if SVG rendering fails
        return {
          engine: driver.name,
          status: status.state,
          qr_raw: qrRaw,
        };
      }
    }

    return {
      engine: driver.name,
      status: status.state,
    };
  }
}
