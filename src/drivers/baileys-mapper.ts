import type { AnyMessageContent, proto } from "@whiskeysockets/baileys";
import type {
  InboundMessage,
  MediaAttachment,
  MessageType,
  OutboundMessage,
} from "../contracts/messages.js";
import {
  calculateDedupHash,
  normalizeMediaDigest,
  normalizeTimestampToSeconds,
} from "../utils/dedup.js";

/**
 * Extracts numeric timestamp in seconds from Baileys message timestamp.
 */
export function extractTimestampSeconds(
  rawTs: number | { toNumber?: () => number } | bigint | null | undefined,
): number {
  if (rawTs === null || rawTs === undefined) {
    return Math.floor(Date.now() / 1000);
  }
  if (typeof rawTs === "object" && typeof rawTs.toNumber === "function") {
    return normalizeTimestampToSeconds(rawTs.toNumber());
  }
  return normalizeTimestampToSeconds(Number(rawTs));
}

interface BasicMediaInfo {
  readonly mimetype?: string | null;
  readonly fileSha256?: Uint8Array | null;
  readonly fileLength?: number | { toNumber?: () => number } | bigint | null;
  readonly url?: string | null;
  readonly caption?: string | null;
}

function extractMediaAttachment(media: BasicMediaInfo, defaultMime: string): MediaAttachment {
  const digest = normalizeMediaDigest(media.fileSha256);
  const sizeBytes =
    media.fileLength !== undefined && media.fileLength !== null
      ? typeof media.fileLength === "object" && typeof media.fileLength.toNumber === "function"
        ? media.fileLength.toNumber()
        : Number(media.fileLength)
      : undefined;

  return {
    mimeType: media.mimetype || defaultMime,
    digest,
    sizeBytes,
    caption: media.caption ?? undefined,
    url: media.url ?? undefined,
  };
}

/**
 * Maps raw Baileys WebMessageInfo to a normalized InboundMessage DTO with dedup hash.
 *
 * INVARIANT: Every inbound message must have its 10-second bucket deduplication hash calculated
 * at entry point to guarantee cross-engine idempotency when failover occurs.
 */
export function mapBaileysMessageToInbound(
  msg: proto.IWebMessageInfo,
  selfJid?: string,
): InboundMessage | null {
  const key = msg.key;
  if (!key?.remoteJid || !key.id) {
    return null;
  }

  const remoteJid = key.remoteJid;
  const fromMe = Boolean(key.fromMe);
  const senderJid = key.participant ?? (fromMe ? (selfJid ?? remoteJid) : remoteJid);
  const timestamp = extractTimestampSeconds(msg.messageTimestamp);
  const rawContent = msg.message;
  if (!rawContent) {
    return null;
  }

  const messageContent =
    rawContent.ephemeralMessage?.message ??
    rawContent.viewOnceMessage?.message ??
    rawContent.viewOnceMessageV2?.message ??
    rawContent.viewOnceMessageV2Extension?.message ??
    rawContent;

  let type: MessageType = "unknown";
  let textBody: string | undefined;
  let media: MediaAttachment | undefined;

  if (messageContent.conversation) {
    type = "text";
    textBody = messageContent.conversation;
  } else if (messageContent.extendedTextMessage?.text) {
    type = "text";
    textBody = messageContent.extendedTextMessage.text;
  } else if (messageContent.imageMessage) {
    type = "image";
    textBody = messageContent.imageMessage.caption ?? undefined;
    media = extractMediaAttachment(messageContent.imageMessage, "image/jpeg");
  } else if (messageContent.videoMessage) {
    type = "video";
    textBody = messageContent.videoMessage.caption ?? undefined;
    media = extractMediaAttachment(messageContent.videoMessage, "video/mp4");
  } else if (messageContent.audioMessage) {
    type = "audio";
    media = extractMediaAttachment(messageContent.audioMessage, "audio/ogg");
  } else if (messageContent.documentMessage) {
    type = "document";
    textBody = messageContent.documentMessage.caption ?? undefined;
    const base = extractMediaAttachment(messageContent.documentMessage, "application/octet-stream");
    media = {
      ...base,
      filename: messageContent.documentMessage.fileName ?? undefined,
    };
  } else if (messageContent.stickerMessage) {
    type = "sticker";
    media = extractMediaAttachment(messageContent.stickerMessage, "image/webp");
  } else if (messageContent.locationMessage) {
    type = "location";
    textBody =
      messageContent.locationMessage.name ?? messageContent.locationMessage.comment ?? undefined;
  } else if (messageContent.contactMessage) {
    type = "contact";
    textBody = messageContent.contactMessage.displayName ?? undefined;
  }

  // INVARIANT: If message is text quoting a media attachment (e.g. !sticker command replying
  // to a photo or sticker), populate media attachment metadata so workers receive media context.
  if (!media && messageContent.extendedTextMessage?.contextInfo?.quotedMessage) {
    const quoted = messageContent.extendedTextMessage.contextInfo.quotedMessage;
    const unwrappedQuoted =
      quoted.ephemeralMessage?.message ??
      quoted.viewOnceMessage?.message ??
      quoted.viewOnceMessageV2?.message ??
      quoted;

    if (unwrappedQuoted.imageMessage) {
      media = extractMediaAttachment(unwrappedQuoted.imageMessage, "image/jpeg");
    } else if (unwrappedQuoted.videoMessage) {
      media = extractMediaAttachment(unwrappedQuoted.videoMessage, "video/mp4");
    } else if (unwrappedQuoted.stickerMessage) {
      media = extractMediaAttachment(unwrappedQuoted.stickerMessage, "image/webp");
    } else if (unwrappedQuoted.documentMessage) {
      const base = extractMediaAttachment(
        unwrappedQuoted.documentMessage,
        "application/octet-stream",
      );
      media = {
        ...base,
        filename: unwrappedQuoted.documentMessage.fileName ?? undefined,
      };
    } else if (unwrappedQuoted.audioMessage) {
      media = extractMediaAttachment(unwrappedQuoted.audioMessage, "audio/ogg");
    }
  }

  const dedupHash = calculateDedupHash({
    remoteJid,
    senderJid,
    timestamp,
    textBody,
    mediaDigest: media?.digest,
  });

  return {
    id: key.id,
    remoteJid,
    senderJid,
    fromMe,
    timestamp,
    type,
    textBody,
    media,
    dedupHash,
  };
}

/**
 * Resolves media attachment to either a Node.js Buffer or URL object for Baileys.
 */
function resolveMediaPayload(media?: MediaAttachment, type = "media"): Buffer | { url: string } {
  if (media?.data) {
    if (typeof media.data === "string") {
      const parts = media.data.split(";base64,");
      const cleanBase64 = parts[1] ?? media.data;
      return Buffer.from(cleanBase64, "base64");
    }
    return Buffer.from(media.data);
  }
  if (media?.url) {
    if (media.url.startsWith("data:")) {
      const [, base64] = media.url.split(";base64,");
      if (base64) {
        return Buffer.from(base64, "base64");
      }
    }
    return { url: media.url };
  }
  throw new Error(`Outbound ${type} message requires media.url`);
}

/**
 * Validates that sticker payload adheres strictly to WebP format.
 *
 * INVARIANT: Baileys stickerMessage strictly expects pre-encoded WebP buffers (k-013).
 * Passing raw JPEG/PNG/MP4 buffers causes WhatsApp to silently fail or render blank stickers.
 */
export function validateWebpPayload(payload: Buffer | { url: string }, mimeType?: string): void {
  if (
    mimeType !== undefined &&
    mimeType !== null &&
    mimeType.toLowerCase().trim() !== "image/webp"
  ) {
    throw new Error(
      `Invalid sticker payload: strictly expected WebP format (image/webp), got "${mimeType}"`,
    );
  }

  if (Buffer.isBuffer(payload)) {
    if (payload.length < 12) {
      throw new Error("Invalid sticker payload: Buffer is too small to be a valid WebP");
    }

    const riff = payload.subarray(0, 4).toString("ascii");
    const webp = payload.subarray(8, 12).toString("ascii");
    if (riff !== "RIFF" || webp !== "WEBP") {
      throw new Error("Invalid sticker payload: strictly expected WebP format (RIFF....WEBP)");
    }
  }
}

/**
 * Maps unified OutboundMessage to Baileys AnyMessageContent.
 */
export function mapOutboundToBaileysContent(outbound: OutboundMessage): AnyMessageContent {
  const caption = outbound.text ?? outbound.media?.caption;
  const mentions =
    outbound.mentions && outbound.mentions.length > 0 ? outbound.mentions : undefined;

  switch (outbound.type) {
    case "text":
      return {
        text: outbound.text ?? "",
        ...(mentions !== undefined ? { mentions } : {}),
      };

    case "sticker": {
      const payload = resolveMediaPayload(outbound.media, outbound.type);
      validateWebpPayload(payload, outbound.media?.mimeType);
      return {
        sticker: payload,
        mimetype: outbound.media?.mimeType ?? "image/webp",
      };
    }

    case "image": {
      const payload = resolveMediaPayload(outbound.media, outbound.type);
      return {
        image: payload,
        mimetype: outbound.media?.mimeType ?? "image/jpeg",
        ...(caption !== undefined ? { caption } : {}),
        ...(mentions !== undefined ? { mentions } : {}),
      };
    }

    case "video": {
      const payload = resolveMediaPayload(outbound.media, outbound.type);
      return {
        video: payload,
        mimetype: outbound.media?.mimeType ?? "video/mp4",
        ...(caption !== undefined ? { caption } : {}),
        ...(mentions !== undefined ? { mentions } : {}),
      };
    }

    case "audio": {
      const payload = resolveMediaPayload(outbound.media, outbound.type);
      return {
        audio: payload,
        mimetype: outbound.media?.mimeType ?? "audio/ogg",
      };
    }

    case "document": {
      const payload = resolveMediaPayload(outbound.media, outbound.type);
      return {
        document: payload,
        mimetype: outbound.media?.mimeType ?? "application/octet-stream",
        ...(caption !== undefined ? { caption } : {}),
        ...(outbound.media?.filename !== undefined ? { fileName: outbound.media.filename } : {}),
        ...(mentions !== undefined ? { mentions } : {}),
      };
    }

    default:
      throw new Error(`Unsupported outbound message type: ${outbound.type}`);
  }
}
