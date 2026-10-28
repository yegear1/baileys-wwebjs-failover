import pkg from "whatsapp-web.js";
import type {
  InboundMessage,
  MediaAttachment,
  MessageType,
  OutboundMessage,
} from "../contracts/messages.js";
import { calculateDedupHash, normalizeTimestampToSeconds } from "../utils/dedup.js";

const { MessageMedia } = pkg;

export interface WWebJSMessageLike {
  readonly id: {
    readonly id?: string;
    readonly _serialized?: string;
  };
  readonly from: string;
  readonly to?: string;
  readonly fromMe: boolean;
  readonly author?: string;
  readonly body?: string;
  readonly timestamp: number;
  readonly type: string;
  readonly hasMedia?: boolean;
  readonly mediaKey?: string;
  readonly hasQuotedMsg?: boolean;
  readonly duration?: string;
  readonly location?: {
    readonly latitude?: number;
    readonly longitude?: number;
    readonly description?: string;
  };
  readonly vCards?: string[];
}

export interface WWebJSSendPayload {
  readonly content: string | pkg.MessageMedia;
  readonly options?: {
    readonly caption?: string;
    readonly quotedMessageId?: string;
    readonly sendAudioAsVoice?: boolean;
  };
}

/**
 * Normalizes any WhatsApp JID to canonical format (@s.whatsapp.net for contacts, preserving @g.us).
 *
 * INVARIANT: Cross-engine deduplication hashing relies on identical JID strings.
 * WWebJS natively uses '@c.us' for contacts, whereas Baileys uses '@s.whatsapp.net'.
 * Normalizing '@c.us' to '@s.whatsapp.net' ensures identical deduplication hashes across engines.
 */
export function normalizeToCanonicalJid(jid: string): string {
  if (jid.endsWith("@c.us")) {
    return `${jid.slice(0, -5)}@s.whatsapp.net`;
  }
  if (jid.includes("@")) {
    return jid;
  }
  const cleanNumber = jid.replace(/\D/g, "");
  return `${cleanNumber}@s.whatsapp.net`;
}

/**
 * Normalizes canonical or raw recipient JID to WWebJS chat ID format (@c.us for contacts, @g.us for groups).
 */
export function toWWebJSChatId(jid: string): string {
  if (jid.endsWith("@s.whatsapp.net")) {
    return `${jid.slice(0, -15)}@c.us`;
  }
  if (jid.endsWith("@c.us") || jid.endsWith("@g.us") || jid.endsWith("@broadcast")) {
    return jid;
  }
  if (!jid.includes("@")) {
    const cleanNumber = jid.replace(/\D/g, "");
    return `${cleanNumber}@c.us`;
  }
  return jid;
}

/**
 * Maps WWebJS message type string to normalized domain MessageType.
 */
export function mapWWebJSTypeToMessageType(type: string): MessageType {
  switch (type) {
    case "chat":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "ptt":
      return "audio";
    case "document":
      return "document";
    case "sticker":
      return "sticker";
    case "location":
      return "location";
    case "vcard":
    case "multi_vcard":
      return "contact";
    default:
      return "unknown";
  }
}

/**
 * Maps WWebJS message to normalized InboundMessage DTO with dedup hash.
 *
 * INVARIANT: Inbound messages are mapped with canonical JID normalization and
 * 10-second bucket SHA-256 deduplication hashing to ensure zero duplicate delivery
 * across failover switches.
 */
export function mapWWebJSMessageToInbound(
  msg: WWebJSMessageLike,
  selfJid?: string,
): InboundMessage | null {
  const messageId = msg.id?.id ?? msg.id?._serialized;
  if (!messageId || !msg.from) {
    return null;
  }

  const remoteJid = normalizeToCanonicalJid(msg.from);
  const fromMe = Boolean(msg.fromMe);
  const senderJid = msg.author
    ? normalizeToCanonicalJid(msg.author)
    : fromMe
      ? selfJid
        ? normalizeToCanonicalJid(selfJid)
        : remoteJid
      : remoteJid;

  const timestamp = normalizeTimestampToSeconds(msg.timestamp);
  const type = mapWWebJSTypeToMessageType(msg.type);
  const textBody = msg.body && msg.body.length > 0 ? msg.body : undefined;

  let media: MediaAttachment | undefined;
  if (msg.hasMedia) {
    const defaultMime =
      type === "image"
        ? "image/jpeg"
        : type === "video"
          ? "video/mp4"
          : type === "audio"
            ? "audio/ogg"
            : "application/octet-stream";

    media = {
      mimeType: defaultMime,
      digest: msg.mediaKey ?? undefined,
      caption: textBody,
    };
  }

  const dedupHash = calculateDedupHash({
    remoteJid,
    senderJid,
    timestamp,
    textBody,
    mediaDigest: media?.digest,
  });

  return {
    id: messageId,
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
 * Maps OutboundMessage to WWebJS dispatch arguments.
 */
export async function mapOutboundToWWebJSContent(
  outbound: OutboundMessage,
): Promise<WWebJSSendPayload> {
  const caption = outbound.text ?? outbound.media?.caption;
  const quotedMessageId = outbound.quotedMessageId;

  if (outbound.type === "text") {
    return {
      content: outbound.text ?? "",
      ...(quotedMessageId !== undefined ? { options: { quotedMessageId } } : {}),
    };
  }

  if (!outbound.media?.url) {
    throw new Error(`Outbound ${outbound.type} message requires media.url`);
  }

  let mediaInstance: pkg.MessageMedia;

  if (outbound.media.url.startsWith("data:")) {
    const [header, base64Data] = outbound.media.url.split(";base64,");
    if (!header || !base64Data) {
      throw new Error("Invalid base64 data URL provided for media");
    }
    const mime = header.replace(/^data:/, "");
    mediaInstance = new MessageMedia(
      mime || outbound.media.mimeType,
      base64Data,
      outbound.media.filename ?? null,
      outbound.media.sizeBytes ?? null,
    );
  } else {
    const fromUrlOptions: { filename?: string; unsafeMime?: boolean } = {
      unsafeMime: true,
    };
    if (outbound.media.filename !== undefined) {
      fromUrlOptions.filename = outbound.media.filename;
    }
    mediaInstance = await MessageMedia.fromUrl(outbound.media.url, fromUrlOptions);
  }

  return {
    content: mediaInstance,
    options: {
      ...(caption !== undefined ? { caption } : {}),
      ...(quotedMessageId !== undefined ? { quotedMessageId } : {}),
      ...(outbound.type === "audio" ? { sendAudioAsVoice: true } : {}),
    },
  };
}
