export type RoomRole = "owner" | "joiner";

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

export type PendingTransfer = {
  key: string;
  transferId: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  fileName: string;
  mime: string;
  size: number;
  createdAt: number;
  totalChunks: number;
  chunks: string[];
  receivedBytes: number;
};
