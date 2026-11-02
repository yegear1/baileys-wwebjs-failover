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
  const messageContent = msg.message;

  if (!messageContent) {
    return null;
  }

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
