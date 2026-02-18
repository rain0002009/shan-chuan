import type { ClientMessage, FileTransfer, PeerInfo, ServerMessage, TextTransfer } from "./shared";
import {
  DEFAULT_COLOR,
  HISTORY_LIMIT,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  getDataUrlSize,
  normalizeRoom,
  sanitizeColor,
  sanitizePeerId
} from "./shared";

type RoomCloseReason = "owner_closed" | "expired";

type RoomMeta = {
  roomName: string | null;
  ownerPeerId: string | null;
  roomClosed: boolean;
  roomCloseReason: RoomCloseReason | null;
  roomExpiresAt: number | null;
};

type OwnerRoomMeta = {
  room: string;
  expiresAt: number;
};

const ROOM_DURATION_MS = 60 * 60 * 1000;

type RoomEnv = {
  ROOMS: DurableObjectNamespace;
};

export class RoomDurableObject {
  private readonly state: DurableObjectState;
  private readonly env: RoomEnv;
  private readonly peers = new Map<WebSocket, PeerInfo>();
  private readonly textHistory: TextTransfer[] = [];
  private readonly joinerIndexByPeerId = new Map<string, number>();
  private nextJoinerIndex = 1;

  private roomMetaLoaded = false;
  private roomName: string | null = null;
  private ownerPeerId: string | null = null;
  private roomClosed = false;
  private roomCloseReason: RoomCloseReason | null = null;
  private roomExpiresAt: number | null = null;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;

    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment && typeof attachment === "object") {
        const peer = attachment as PeerInfo;
        if (
          typeof peer.id === "string" &&
          typeof peer.name === "string" &&
          typeof peer.color === "string" &&
          (peer.role === "owner" || peer.role === "joiner")
        ) {
          this.peers.set(socket, peer);
          if (peer.role === "owner") {
            this.ownerPeerId = peer.id;
          }
          if (peer.role === "joiner" && Number.isInteger(peer.userIndex) && (peer.userIndex ?? 0) > 0) {
            const joinerIndex = Number(peer.userIndex);
            this.joinerIndexByPeerId.set(peer.id, joinerIndex);
            this.nextJoinerIndex = Math.max(this.nextJoinerIndex, joinerIndex + 1);
          }
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/owner/allocate") {
      return this.allocateOwnerRoom(url);
    }

    if (request.method === "POST" && url.pathname === "/owner/claim") {
      return this.allocateOwnerRoom(url);
    }

    if (request.method === "POST" && url.pathname === "/owner/release") {
      return this.releaseOwnerRoomByApi(url);
    }

    if (url.pathname === "/connect") {
      return this.handleConnect(request, url);
    }

    if (url.pathname === "/control/close" && request.method === "POST") {
      await this.loadRoomMeta();
      const peerId = sanitizePeerId(url.searchParams.get("peerId") ?? "");
      const ok = await this.closeRoom("owner_closed", peerId);
      if (!ok) {
        return this.json({ ok: false, error: "无权限关闭房间" }, 403);
      }
      return this.json({ ok: true });
    }

    if (url.pathname === "/control/reopen" && request.method === "POST") {
      await this.loadRoomMeta();
      const peerId = sanitizePeerId(url.searchParams.get("peerId") ?? "");
      const result = await this.reopenRoom(peerId);
      if (!result.ok) {
        return this.json({ ok: false, error: result.error }, result.status);
      }
      return this.json({ ok: true, expiresAt: result.expiresAt });
    }

    return new Response("未找到资源", { status: 404 });
  }

  async alarm(): Promise<void> {
    const ownerMeta = await this.state.storage.get<OwnerRoomMeta>("owner_room_meta");
    if (ownerMeta) {
      if (Date.now() >= ownerMeta.expiresAt) {
        await this.state.storage.delete("owner_room_meta");
      }
      return;
    }

    await this.loadRoomMeta();
    await this.enforceExpiry();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loadRoomMeta();
    await this.enforceExpiry();

    if (this.roomClosed) {
      this.send(socket, {
        type: "room_closed",
        reason: this.roomCloseReason ?? "owner_closed",
        canReopen: this.roomCloseReason === "expired"
      });
      try {
        socket.close(4001, "room-closed");
      } catch {
        // noop
      }
      this.peers.delete(socket);
      return;
    }

    if (typeof message !== "string") {
      this.send(socket, {
        type: "error",
        message: "仅支持文本 WebSocket 帧。"
      });
      return;
    }

    const sender = this.peers.get(socket);
    if (!sender) {
      this.send(socket, {
        type: "error",
        message: "发送方身份无效，请重新连接后重试。"
      });
      return;
    }

    let payload: ClientMessage;
    try {
      payload = JSON.parse(message) as ClientMessage;
    } catch (error) {
      console.warn("Invalid websocket payload", error);
      this.send(socket, {
        type: "error",
        message: "消息内容无法解析。"
      });
      return;
    }

    if (payload.type === "text") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
        this.send(socket, {
          type: "error",
          message: "文本长度需在 1 到 4000 字之间。"
        });
        return;
      }

      const messageOut: TextTransfer = {
        id: crypto.randomUUID(),
        kind: "text",
        text,
        senderId: sender.id,
        senderName: sender.name,
        senderColor: sender.color,
        createdAt: Date.now()
      };

      this.textHistory.push(messageOut);
      if (this.textHistory.length > HISTORY_LIMIT) {
        this.textHistory.shift();
      }

      this.broadcast({
        type: "message",
        message: messageOut
      });
      return;
    }

    if (payload.type === "ping") {
      this.send(socket, {
        type: "pong",
        serverNow: Date.now()
      });
      return;
    }

    if (payload.type === "file_start") {
      const transferId = typeof payload.transferId === "string" ? payload.transferId.trim() : "";
      const fileName = typeof payload.name === "string" ? payload.name.trim().slice(0, 128) : "";
      const mime = typeof payload.mime === "string" ? payload.mime.trim().slice(0, 120) : "";
      const size = Number(payload.size);
      const totalChunks = Number(payload.totalChunks);

      if (
        !transferId ||
        !fileName ||
        !mime ||
        !Number.isFinite(size) ||
        size <= 0 ||
        size > MAX_FILE_BYTES ||
        !Number.isInteger(totalChunks) ||
        totalChunks <= 0 ||
        totalChunks > 4096
      ) {
        this.send(socket, {
          type: "error",
          message: "文件初始化数据无效。"
        });
        return;
      }

      this.broadcast({
        type: "file_start",
        transferId,
        senderId: sender.id,
        senderName: sender.name,
        senderColor: sender.color,
        fileName,
        mime,
        size,
        totalChunks,
        createdAt: Date.now()
      });
      return;
    }

    if (payload.type === "file_chunk") {
      const transferId = typeof payload.transferId === "string" ? payload.transferId.trim() : "";
      const index = Number(payload.index);
      const chunkSize = Number(payload.chunkSize);
      const data = typeof payload.data === "string" ? payload.data : "";

      if (
        !transferId ||
        !Number.isInteger(index) ||
        index < 0 ||
        !Number.isFinite(chunkSize) ||
        chunkSize <= 0 ||
        chunkSize > MAX_FILE_BYTES ||
        !data
      ) {
        this.send(socket, {
          type: "error",
          message: "文件分片数据无效。"
        });
        return;
      }

      this.broadcast({
        type: "file_chunk",
        transferId,
        senderId: sender.id,
        index,
        chunkSize,
        data
      });
      return;
    }

    if (payload.type === "file_end") {
      const transferId = typeof payload.transferId === "string" ? payload.transferId.trim() : "";
      if (!transferId) {
        this.send(socket, {
          type: "error",
          message: "文件结束标记无效。"
        });
        return;
      }

      this.broadcast({
        type: "file_end",
        transferId,
        senderId: sender.id
      });
      return;
    }

    if (payload.type === "file") {
      const fileName = typeof payload.name === "string" ? payload.name.trim().slice(0, 128) : "";
      const mime = typeof payload.mime === "string" ? payload.mime.trim().slice(0, 120) : "";
      const size = Number(payload.size);
      const data = typeof payload.data === "string" ? payload.data : "";

      if (!fileName || !mime || !Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES || !data) {
        this.send(socket, {
          type: "error",
          message: "文件数据格式无效。"
        });
        return;
      }

      const decodedSize = getDataUrlSize(data);
      if (decodedSize === null || decodedSize <= 0 || decodedSize > MAX_FILE_BYTES || Math.abs(decodedSize - size) > 32) {
        this.send(socket, {
          type: "error",
          message: "文件大小不匹配或数据格式不支持。"
        });
        return;
      }

      const messageOut: FileTransfer = {
        id: crypto.randomUUID(),
        kind: "file",
        fileName,
        mime,
        size: decodedSize,
        data,
        senderId: sender.id,
        senderName: sender.name,
        senderColor: sender.color,
        createdAt: Date.now()
      };

      this.broadcast({
        type: "message",
        message: messageOut
      });
      return;
    }

    this.send(socket, {
      type: "error",
      message: "未知消息类型。"
    });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.peers.delete(socket);
    if (!this.roomClosed) {
      this.broadcastPresence();
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.peers.delete(socket);
    if (!this.roomClosed) {
      this.broadcastPresence();
    }
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("需要 WebSocket 连接", { status: 426 });
    }

    await this.loadRoomMeta();
    await this.enforceExpiry();

    if (this.roomClosed) {
      const pair = new WebSocketPair();
      const clientSocket = pair[0];
      const serverSocket = pair[1];
      this.state.acceptWebSocket(serverSocket);
      this.send(serverSocket, {
        type: "room_closed",
        reason: this.roomCloseReason ?? "owner_closed",
        canReopen: this.roomCloseReason === "expired"
      });
      try {
        serverSocket.close(4001, "room-closed");
      } catch {
        // noop
      }
      return new Response(null, {
        status: 101,
        webSocket: clientSocket
      });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    const peerId = sanitizePeerId(url.searchParams.get("peerId") ?? crypto.randomUUID());
    const color = sanitizeColor(url.searchParams.get("color") ?? DEFAULT_COLOR);
    const role = url.searchParams.get("role") === "owner" ? "owner" : "joiner";
    const peer = this.buildPeerInfo(peerId, color, role);

    if (!peer) {
      return this.json({ error: "房主身份不匹配，无法接管房间" }, 403);
    }

    this.state.acceptWebSocket(serverSocket);
    serverSocket.serializeAttachment(peer);
    this.peers.set(serverSocket, peer);

    for (const [existingSocket, existingPeer] of this.peers.entries()) {
      if (existingSocket !== serverSocket && existingPeer.id === peer.id) {
        this.peers.delete(existingSocket);
        try {
          existingSocket.close(1000, "replaced-by-reconnect");
        } catch {
          // noop
        }
      }
    }

    const room = normalizeRoom(url.searchParams.get("room") ?? "") ?? "fangjian";
    if (this.roomName === null) {
      this.roomName = room;
    }

    if (this.roomExpiresAt === null) {
      this.roomExpiresAt = Date.now() + ROOM_DURATION_MS;
      await this.state.storage.setAlarm(this.roomExpiresAt);
    }
    await this.saveRoomMeta();

    this.send(serverSocket, {
      type: "connected",
      room,
      peerId: peer.id,
      expiresAt: this.roomExpiresAt,
      serverNow: Date.now()
    });

    this.send(serverSocket, {
      type: "history",
      messages: this.textHistory
    });

    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: clientSocket
    });
  }

  private buildPeerInfo(peerId: string, color: string, role: "owner" | "joiner"): PeerInfo | null {
    if (role === "owner") {
      if (this.ownerPeerId && this.ownerPeerId !== peerId) {
        return null;
      }
      this.ownerPeerId = peerId;
      return {
        id: peerId,
        name: "房主",
        color,
        role: "owner"
      };
    }

    let joinerIndex = this.joinerIndexByPeerId.get(peerId);
    if (!joinerIndex) {
      joinerIndex = this.nextJoinerIndex;
      this.joinerIndexByPeerId.set(peerId, joinerIndex);
      this.nextJoinerIndex += 1;
    }

    return {
      id: peerId,
      name: `用户${joinerIndex}`,
      color,
      role: "joiner",
      userIndex: joinerIndex
    };
  }

  private async loadRoomMeta(): Promise<void> {
    if (this.roomMetaLoaded) {
      return;
    }

    const saved = await this.state.storage.get<RoomMeta>("room_meta");
    if (saved) {
      this.roomName = saved.roomName ?? null;
      this.ownerPeerId = saved.ownerPeerId ?? this.ownerPeerId;
      this.roomClosed = Boolean(saved.roomClosed);
      this.roomCloseReason = saved.roomCloseReason ?? null;
      this.roomExpiresAt = typeof saved.roomExpiresAt === "number" ? saved.roomExpiresAt : null;
    }

    this.roomMetaLoaded = true;
  }

  private async saveRoomMeta(): Promise<void> {
    const meta: RoomMeta = {
      roomName: this.roomName,
      ownerPeerId: this.ownerPeerId,
      roomClosed: this.roomClosed,
      roomCloseReason: this.roomCloseReason,
      roomExpiresAt: this.roomExpiresAt
    };
    await this.state.storage.put("room_meta", meta);
  }

  private async enforceExpiry(): Promise<void> {
    if (this.roomClosed || this.roomExpiresAt === null) {
      return;
    }
    if (Date.now() < this.roomExpiresAt) {
      return;
    }
    await this.closeRoom("expired", null);
  }

  private async closeRoom(reason: RoomCloseReason, initiatorPeerId: string | null): Promise<boolean> {
    if (this.roomClosed) {
      return true;
    }

    if (reason === "owner_closed") {
      if (!this.ownerPeerId || !initiatorPeerId || initiatorPeerId !== this.ownerPeerId) {
        return false;
      }
      this.roomExpiresAt = null;
      try {
        await this.state.storage.deleteAlarm();
      } catch {
        // noop
      }
    }

    if (reason === "expired") {
      this.roomExpiresAt = Date.now();
    }

    this.roomClosed = true;
    this.roomCloseReason = reason;
    await this.saveRoomMeta();
    await this.releaseOwnerRoom();

    const message: ServerMessage = {
      type: "room_closed",
      reason,
      canReopen: reason === "expired"
    };

    for (const socket of Array.from(this.peers.keys())) {
      this.send(socket, message);
      try {
        socket.close(4001, reason);
      } catch {
        // noop
      }
      this.peers.delete(socket);
    }

    return true;
  }

  private async reopenRoom(peerId: string): Promise<{ ok: true; expiresAt: number } | { ok: false; error: string; status: number }> {
    if (!this.roomClosed || this.roomCloseReason !== "expired") {
      return {
        ok: false,
        error: "当前房间不可重新开启",
        status: 400
      };
    }

    if (!this.ownerPeerId || this.ownerPeerId !== peerId) {
      return {
        ok: false,
        error: "仅房主可以重新开启房间",
        status: 403
      };
    }

    const claimed = await this.claimOwnerRoom();
    if (!claimed) {
      return {
        ok: false,
        error: "当前设备已有其他活跃房间，无法重新开启",
        status: 409
      };
    }

    this.roomClosed = false;
    this.roomCloseReason = null;
    this.roomExpiresAt = Date.now() + ROOM_DURATION_MS;
    await this.state.storage.setAlarm(this.roomExpiresAt);
    await this.saveRoomMeta();

    return {
      ok: true,
      expiresAt: this.roomExpiresAt
    };
  }

  private async allocateOwnerRoom(url: URL): Promise<Response> {
    const room = normalizeRoom(url.searchParams.get("room") ?? "");
    if (!room) {
      return this.json({ ok: false, error: "invalid_room" }, 400);
    }

    const ttlRaw = Number(url.searchParams.get("ttlMs") ?? ROOM_DURATION_MS);
    const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, ROOM_DURATION_MS) : ROOM_DURATION_MS;
    const now = Date.now();

    const existing = await this.state.storage.get<OwnerRoomMeta>("owner_room_meta");
    if (existing && existing.expiresAt > now && existing.room !== room) {
      return this.json(
        {
          ok: false,
          error: "owner_has_active_room",
          room: existing.room,
          expiresAt: existing.expiresAt
        },
        409
      );
    }

    const next: OwnerRoomMeta = {
      room,
      expiresAt: now + ttlMs
    };
    await this.state.storage.put("owner_room_meta", next);
    await this.state.storage.setAlarm(next.expiresAt);

    return this.json({ ok: true, room: next.room, expiresAt: next.expiresAt });
  }

  private async releaseOwnerRoomByApi(url: URL): Promise<Response> {
    const room = normalizeRoom(url.searchParams.get("room") ?? "");
    if (!room) {
      return this.json({ ok: false, error: "invalid_room" }, 400);
    }

    const existing = await this.state.storage.get<OwnerRoomMeta>("owner_room_meta");
    if (existing && existing.room === room) {
      await this.state.storage.delete("owner_room_meta");
      try {
        await this.state.storage.deleteAlarm();
      } catch {
        // noop
      }
    }

    return this.json({ ok: true });
  }

  private async claimOwnerRoom(): Promise<boolean> {
    if (!this.ownerPeerId || !this.roomName) {
      return false;
    }

    const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(`owner:${this.ownerPeerId}`));
    try {
      const response = await stub.fetch(
        new Request(
          `https://state.internal/owner/claim?room=${encodeURIComponent(this.roomName)}&ttlMs=${ROOM_DURATION_MS}`,
          { method: "POST" }
        )
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async releaseOwnerRoom(): Promise<void> {
    if (!this.ownerPeerId || !this.roomName) {
      return;
    }

    const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(`owner:${this.ownerPeerId}`));
    try {
      await stub.fetch(
        new Request(`https://state.internal/owner/release?room=${encodeURIComponent(this.roomName)}`, {
          method: "POST"
        })
      );
    } catch {
      // noop
    }
  }

  private send(socket: WebSocket, message: ServerMessage): boolean {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.warn("Could not send websocket message", error);
      this.peers.delete(socket);
      return false;
    }
  }

  private broadcast(message: ServerMessage): void {
    let removed = false;
    for (const socket of Array.from(this.peers.keys())) {
      const ok = this.send(socket, message);
      if (!ok) {
        removed = true;
      }
    }
    if (removed && message.type !== "presence") {
      this.broadcastPresence();
    }
  }

  private broadcastPresence(): void {
    this.broadcast({
      type: "presence",
      count: this.peers.size
    });
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
}
