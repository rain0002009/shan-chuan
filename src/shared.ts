export type PeerInfo = {
  id: string;
  name: string;
  color: string;
  role: "owner" | "joiner";
  userIndex?: number;
};

type BaseTransfer = {
  id: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  createdAt: number;
};

export type TextTransfer = BaseTransfer & {
  kind: "text";
  text: string;
};

export type FileTransfer = BaseTransfer & {
  kind: "file";
  fileName: string;
  mime: string;
  size: number;
  data: string;
};

export type TransferMessage = TextTransfer | FileTransfer;

export type ClientMessage =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "ping";
    }
  | {
      type: "file_start";
      transferId: string;
      name: string;
      mime: string;
      size: number;
      totalChunks: number;
    }
  | {
      type: "file_chunk";
      transferId: string;
      index: number;
      chunkSize: number;
      data: string;
    }
  | {
      type: "file_end";
      transferId: string;
    }
  | {
      type: "file";
      name: string;
      mime: string;
      size: number;
      data: string;
    };

export type ServerMessage =
  | {
      type: "connected";
      room: string;
      peerId: string;
      expiresAt: number | null;
      serverNow: number;
    }
  | {
      type: "pong";
      serverNow: number;
    }
  | {
      type: "presence";
      count: number;
    }
  | {
      type: "history";
      messages: TextTransfer[];
    }
  | {
      type: "message";
      message: TransferMessage;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "room_closed";
      reason: "owner_closed" | "expired";
      canReopen: boolean;
    }
  | {
      type: "file_start";
      transferId: string;
      senderId: string;
      senderName: string;
      senderColor: string;
      fileName: string;
      mime: string;
      size: number;
      totalChunks: number;
      createdAt: number;
    }
  | {
      type: "file_chunk";
      transferId: string;
      senderId: string;
      index: number;
      chunkSize: number;
      data: string;
    }
  | {
      type: "file_end";
      transferId: string;
      senderId: string;
    };

const ROOM_PATTERN = /^(?!-)[a-z0-9-]{3,32}(?<!-)$/;
const PEER_PATTERN = /[^a-zA-Z0-9-]/g;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DATA_URL_PATTERN = /^data:[a-zA-Z0-9!#$&.+\-^_]+\/[a-zA-Z0-9!#$&.+\-^_]+;base64,[A-Za-z0-9+/=]+$/;

export const MAX_TEXT_CHARS = 4000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const HISTORY_LIMIT = 40;
export const DEFAULT_COLOR = "#ff4d8d";

const ADJECTIVES = [
  "huoli",
  "liuguang",
  "yuncai",
  "qingxin",
  "yangguang",
  "xinghe",
  "duoba",
  "qingliang",
  "yuedong",
  "xuancai"
];

const NOUNS = [
  "xingqiu",
  "haifeng",
  "huohua",
  "yunhai",
  "guangdian",
  "bowen",
  "langchao",
  "mengjing",
  "linyin",
  "qingkong"
];

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export function normalizeRoom(rawValue: string): string | null {
  const room = rawValue.trim().toLowerCase();
  if (!ROOM_PATTERN.test(room)) {
    return null;
  }
  return room;
}

export function sanitizePeerId(rawValue: string): string {
  const cleaned = rawValue.replace(PEER_PATTERN, "").toLowerCase();
  if (cleaned.length < 8) {
    return crypto.randomUUID();
  }
  return cleaned.slice(0, 64);
}

export function sanitizeColor(rawValue: string): string {
  if (COLOR_PATTERN.test(rawValue)) {
    return rawValue.toLowerCase();
  }
  return DEFAULT_COLOR;
}

export function getDataUrlSize(rawValue: string): number | null {
  if (!DATA_URL_PATTERN.test(rawValue)) {
    return null;
  }
  const commaIndex = rawValue.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const base64 = rawValue.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function generateRoomName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${adjective}-${noun}-${suffix}`;
}
