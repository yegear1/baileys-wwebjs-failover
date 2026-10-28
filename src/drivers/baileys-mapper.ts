import { Buffer } from "node:buffer";
import type { AnyMessageContent, proto } from "@whiskeysockets/baileys";
import type {
  InboundMessage,
  MediaAttachment,
  MessageType,
  OutboundMessage,
} from "../contracts/messages.js";
import { calculateDedupHash, normalizeTimestampToSeconds } from "../utils/dedup.js";

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
  const digest = media.fileSha256 ? Buffer.from(media.fileSha256).toString("hex") : undefined;
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
 * Maps unified OutboundMessage to Baileys AnyMessageContent.
 */
export function mapOutboundToBaileysContent(outbound: OutboundMessage): AnyMessageContent {
  const caption = outbound.text ?? outbound.media?.caption;

  switch (outbound.type) {
    case "text":
      return { text: outbound.text ?? "" };

    case "image": {
      if (!outbound.media?.url) {
        throw new Error("Outbound image message requires media.url");
      }
      return {
        image: { url: outbound.media.url },
        mimetype: outbound.media.mimeType ?? "image/jpeg",
        ...(caption !== undefined ? { caption } : {}),
      };
    }

    case "video": {
      if (!outbound.media?.url) {
        throw new Error("Outbound video message requires media.url");
      }
      return {
        video: { url: outbound.media.url },
        mimetype: outbound.media.mimeType ?? "video/mp4",
        ...(caption !== undefined ? { caption } : {}),
      };
    }

    case "audio": {
      if (!outbound.media?.url) {
        throw new Error("Outbound audio message requires media.url");
      }
      return {
        audio: { url: outbound.media.url },
        mimetype: outbound.media.mimeType ?? "audio/ogg",
      };
    }

    case "document": {
      if (!outbound.media?.url) {
        throw new Error("Outbound document message requires media.url");
      }
      return {
        document: { url: outbound.media.url },
        mimetype: outbound.media.mimeType ?? "application/octet-stream",
        ...(caption !== undefined ? { caption } : {}),
        ...(outbound.media.filename !== undefined ? { fileName: outbound.media.filename } : {}),
      };
    }

    default:
      throw new Error(`Unsupported outbound message type: ${outbound.type}`);
  }
}
