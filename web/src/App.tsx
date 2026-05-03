import { useEffect, useMemo, useRef, useState } from "react";
import { useEventListener, useInterval, useLatest, useLocalStorageState, useMemoizedFn, useUnmount } from "ahooks";
import type { ClientMessage, FileTransfer, PendingTransfer, RoomRole, ServerMessage, TransferMessage } from "./types";

const ROOM_PATTERN = /^(?!-)[a-z0-9-]{3,32}(?<!-)$/;
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const BASE64_CHUNK_SIZE = 24 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ROOM_DURATION_MS = 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const COLOR_POOL = ["#ff4d8d", "#4f7cff", "#00b894", "#ff9f1c", "#8c5bff", "#00c6ff", "#ff5858"];

function sanitizeRoom(value: string): string | null {
  const room = String(value ?? "").trim().toLowerCase();
  return ROOM_PATTERN.test(room) ? room : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 字节";
  }
  const units = ["字节", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const decimals = value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function base64ByteLength(base64Chunk: string): number {
  const normalized = String(base64Chunk || "");
  if (!normalized) {
    return 0;
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const step = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    const chunk = bytes.subarray(offset, offset + step);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function toSafeLink(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function transferKey(senderId: string, transferId: string): string {
  return `${senderId}:${transferId}`;
}

function randomColor(): string {
  return COLOR_POOL[Math.floor(Math.random() * COLOR_POOL.length)];
}

function renderTextWithLinks(text: string): Array<string | { text: string; href: string }> {
  const raw = String(text || "");
  const output: Array<string | { text: string; href: string }> = [];
  let lastIndex = 0;

  URL_PATTERN.lastIndex = 0;
  let match = URL_PATTERN.exec(raw);
  while (match) {
    const matchedText = match[0];
    const start = match.index;
    if (start > lastIndex) {
      output.push(raw.slice(lastIndex, start));
    }
    output.push({ text: matchedText, href: toSafeLink(matchedText) });
    lastIndex = start + matchedText.length;
    match = URL_PATTERN.exec(raw);
  }

  if (lastIndex < raw.length) {
    output.push(raw.slice(lastIndex));
  }

  return output;
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const serverOffsetRef = useRef(0);
  const ownerCloseSentRef = useRef(false);
  const transferMapRef = useRef<Map<string, PendingTransfer>>(new Map());
  const connectRef = useRef<(targetRoom: string, isReconnect: boolean) => Promise<void>>(async () => undefined);

  const [peerId, setPeerId] = useLocalStorageState<string>("dopamine-transfer-peer-id", {
    defaultValue: crypto.randomUUID()
  });
  const [color, setColor] = useLocalStorageState<string>("dopamine-transfer-color", {
    defaultValue: randomColor()
  });
  const [role, setRole] = useState<RoomRole | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [room, setRoom] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [statusText, setStatusText] = useState("离线");
  const [isConnected, setIsConnected] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [roomClosed, setRoomClosed] = useState(false);
  const [roomCloseReason, setRoomCloseReason] = useState<"owner_closed" | "expired" | "">("");
  const [roomExpiresAt, setRoomExpiresAt] = useState<number | null>(null);
  const [textValue, setTextValue] = useState("");
  const [messages, setMessages] = useState<TransferMessage[]>([]);
  const [pendingTransfers, setPendingTransfers] = useState<PendingTransfer[]>([]);
  const [qrModalLink, setQrModalLink] = useState<string>("");
  const [clockTick, setClockTick] = useState(Date.now());

  const roomRef = useLatest(room);
  const roleRef = useLatest(role);
  const roomClosedRef = useLatest(roomClosed);
  const peerIdRef = useLatest(peerId ?? "");
  const colorRef = useLatest(color ?? "");

  useInterval(() => {
    setClockTick(Date.now());
  }, 1000);

  useEffect(() => {
    if (!peerId || peerId.length < 8) {
      setPeerId(crypto.randomUUID());
    }
  }, [peerId, setPeerId]);

  useEffect(() => {
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      setColor(randomColor());
    }
  }, [color, setColor]);

  useEffect(() => {
    const updateViewportHeight = (): void => {
      const viewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
      document.documentElement.style.setProperty("--app-vh", `${viewportHeight}px`);
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    window.visualViewport?.addEventListener("resize", updateViewportHeight);
    window.visualViewport?.addEventListener("scroll", updateViewportHeight);

    return () => {
      window.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("scroll", updateViewportHeight);
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 170)}px`;
  }, [textValue]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const roomFromUrl = sanitizeRoom(url.searchParams.get("room") || "");
    if (!roomFromUrl) {
      return;
    }
    setRole("joiner");
    setRoomInput(roomFromUrl);
    void connectRef.current(roomFromUrl, false);
  }, []);

  useUnmount(() => {
    if (wsRef.current && wsRef.current.readyState < WebSocket.CLOSING) {
      wsRef.current.close(1000, "cleanup");
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
    }
  });

  const canSend = isConnected && !roomClosed && participantCount >= 2;
  const isOwner = role === "owner";
  const showCloseRoom = isOwner && isConnected && !roomClosed;
  const showReopenRoom = isOwner && roomClosed && roomCloseReason === "expired";
  const showCopyLink = Boolean(shareLink) && isConnected && !roomClosed;
  const showQrCard = Boolean(shareLink) && !roomClosed;

  const remainingMs = roomExpiresAt ? Math.max(0, roomExpiresAt - (clockTick + serverOffsetRef.current)) : null;
  const timerProgress = remainingMs === null ? 0 : Math.max(0, Math.min(100, Math.round((remainingMs / ROOM_DURATION_MS) * 100)));
  const timerUrgent = remainingMs !== null && remainingMs <= 5 * 60 * 1000;

  useEffect(() => {
    if (remainingMs === null || remainingMs > 0 || roomClosed) {
      return;
    }
    setRoomClosed(true);
    setRoomCloseReason("expired");
    setIsConnected(false);
    setParticipantCount(0);

    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setStatusText(isOwner ? "房间已到期，可再次开启" : "房间已到期，等待房主开启");
  }, [isOwner, remainingMs, roomClosed]);

  function syncServerClock(serverNow: number): void {
    const parsed = Number(serverNow);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    serverOffsetRef.current = parsed - Date.now();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function refreshPendingTransfers(): void {
    setPendingTransfers(Array.from(transferMapRef.current.values()).sort((a, b) => a.createdAt - b.createdAt));
  }

  function appendMessage(message: TransferMessage): void {
    setMessages((prev) => {
      if (prev.some((item) => item.id === message.id)) {
        return prev;
      }
      return [...prev, message];
    });
  }

  function updateShareLink(nextRoom: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set("room", nextRoom);
    const nextPath = `${url.pathname}?${url.searchParams.toString()}`;
    window.history.replaceState({}, "", nextPath);
    setShareLink(`${window.location.origin}${nextPath}`);
  }

  function setRoomOpen(expiresAt: number | null): void {
    setRoomClosed(false);
    setRoomCloseReason("");
    setRoomExpiresAt(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null);
  }

  function setRoomClosedState(reason: "owner_closed" | "expired", canReopen: boolean): void {
    setRoomClosed(true);
    setRoomCloseReason(reason);
    setIsConnected(false);
    setParticipantCount(0);
    stopHeartbeat();
    clearReconnectTimer();

    if (reason === "owner_closed") {
      setStatusText("房间已关闭，无法重新连接");
    } else {
      setStatusText(isOwner && canReopen ? "房间已到期，可再次开启" : "房间已到期，等待房主开启");
    }
  }

  function sendPayload(payload: ClientMessage): boolean {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusText("房间未连接");
      return false;
    }
    wsRef.current.send(JSON.stringify(payload));
    return true;
  }

  function scheduleReconnect(): void {
    if (!roomRef.current || roomClosedRef.current || reconnectTimerRef.current) {
      return;
    }

    const base = Math.min(30000, 1000 * 2 ** reconnectAttemptRef.current);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
    const delay = base + jitter;

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;
      void connectToRoom(roomRef.current, true);
    }, delay);

    setStatusText("连接已断开，正在自动重连...");
  }

  function startHeartbeat(ws: WebSocket): void {
    stopHeartbeat();
    heartbeatTimerRef.current = window.setInterval(() => {
      if (!wsRef.current || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
      }
      heartbeatTimeoutRef.current = window.setTimeout(() => {
        if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, "heartbeat-timeout");
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function onFileStart(payload: Extract<ServerMessage, { type: "file_start" }>): void {
    const key = transferKey(payload.senderId, payload.transferId);
    if (transferMapRef.current.has(key)) {
      return;
    }
    transferMapRef.current.set(key, {
      key,
      transferId: payload.transferId,
      senderId: payload.senderId,
      senderName: payload.senderName,
      senderColor: payload.senderColor,
      fileName: payload.fileName,
      mime: payload.mime,
      size: payload.size,
      createdAt: payload.createdAt,
      totalChunks: payload.totalChunks,
      chunks: new Array(payload.totalChunks).fill(""),
      receivedBytes: 0
    });
    refreshPendingTransfers();
  }

  function onFileChunk(payload: Extract<ServerMessage, { type: "file_chunk" }>): void {
    const key = transferKey(payload.senderId, payload.transferId);
    const task = transferMapRef.current.get(key);
    if (!task) {
      return;
    }

    if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= task.totalChunks) {
      return;
    }

    if (task.chunks[payload.index]) {
      return;
    }

    task.chunks[payload.index] = payload.data;
    task.receivedBytes += Number(payload.chunkSize || 0);
    transferMapRef.current.set(key, task);
    refreshPendingTransfers();
  }

  function onFileEnd(payload: Extract<ServerMessage, { type: "file_end" }>): void {
    const key = transferKey(payload.senderId, payload.transferId);
    const task = transferMapRef.current.get(key);
    if (!task) {
      return;
    }

    transferMapRef.current.delete(key);
    refreshPendingTransfers();

    const data = `data:${task.mime};base64,${task.chunks.join("")}`;
    const finalMessage: FileTransfer = {
      id: crypto.randomUUID(),
      kind: "file",
      fileName: task.fileName,
      mime: task.mime,
      size: task.size,
      data,
      senderId: task.senderId,
      senderName: task.senderName,
      senderColor: task.senderColor,
      createdAt: task.createdAt
    };
    appendMessage(finalMessage);
  }

  function handleServerMessage(raw: unknown): void {
    let payload: ServerMessage;
    try {
      payload = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "connected") {
      syncServerClock(payload.serverNow);
      setRoom(payload.room);
      setRoomInput(payload.room);
      setRoomOpen(payload.expiresAt);
      setIsConnected(true);
      setStatusText("已连接");
      setParticipantCount((current) => Math.max(current, 1));
      ownerCloseSentRef.current = false;
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      updateShareLink(payload.room);
      return;
    }

    if (payload.type === "pong") {
      syncServerClock(payload.serverNow);
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      return;
    }

    if (payload.type === "presence") {
      setParticipantCount(Number(payload.count || 0));
      return;
    }

    if (payload.type === "history") {
      setMessages((prev) => {
        const map = new Map(prev.map((item) => [item.id, item]));
        for (const item of payload.messages) {
          map.set(item.id, item);
        }
        return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
      });
      return;
    }

    if (payload.type === "message") {
      appendMessage(payload.message);
      return;
    }

    if (payload.type === "room_closed") {
      setRoomClosedState(payload.reason, payload.canReopen);
      return;
    }

    if (payload.type === "file_start") {
      onFileStart(payload);
      return;
    }

    if (payload.type === "file_chunk") {
      onFileChunk(payload);
      return;
    }

    if (payload.type === "file_end") {
      onFileEnd(payload);
      return;
    }

    if (payload.type === "error") {
      setStatusText(payload.message || "请求失败");
    }
  }

  async function connectToRoom(targetRoom: string, isReconnect: boolean): Promise<void> {
    const normalized = sanitizeRoom(targetRoom);
    if (!normalized) {
      setStatusText("房间号格式不正确");
      return;
    }

    if (!isReconnect) {
      setRoomClosed(false);
      setRoomCloseReason("");
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
    }

    if (wsRef.current && wsRef.current.readyState < WebSocket.CLOSING) {
      wsRef.current.close(1000, "switch-room");
    }

    setRoom(normalized);
    setRoomInput(normalized);
    setParticipantCount(0);
    setIsConnected(false);
    setStatusText(isReconnect ? "重连中..." : "连接中...");

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const roleValue = roleRef.current === "owner" ? "owner" : "joiner";
    const wsUrl = `${protocol}://${window.location.host}/ws/${encodeURIComponent(normalized)}?peerId=${encodeURIComponent(peerIdRef.current)}&role=${encodeURIComponent(roleValue)}&color=${encodeURIComponent(colorRef.current)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setIsConnected(true);
      setStatusText("已连接");
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      startHeartbeat(ws);
    });

    ws.addEventListener("message", (event) => {
      handleServerMessage(event.data);
    });

    ws.addEventListener("close", () => {
      if (wsRef.current === ws) {
        stopHeartbeat();
        setIsConnected(false);
        if (!roomClosedRef.current) {
          setStatusText("连接已断开");
          setParticipantCount(0);
          scheduleReconnect();
        }
      }
    });

    ws.addEventListener("error", () => {
      if (wsRef.current === ws) {
        setIsConnected(false);
        if (!roomClosedRef.current) {
          setStatusText("网络异常");
          scheduleReconnect();
        }
      }
    });
  }

  connectRef.current = connectToRoom;

  async function closeRoomByOwner(useBeacon = false): Promise<boolean> {
    if (!room || !peerId || ownerCloseSentRef.current) {
      return false;
    }
    const endpoint = `/api/room/${encodeURIComponent(room)}/close?peerId=${encodeURIComponent(peerId)}`;

    if (useBeacon && navigator.sendBeacon) {
      ownerCloseSentRef.current = true;
      return navigator.sendBeacon(endpoint, "");
    }

    const response = await fetch(endpoint, { method: "POST", keepalive: true });
    if (!response.ok) {
      return false;
    }
    ownerCloseSentRef.current = true;
    return true;
  }

  async function reopenRoomByOwner(): Promise<boolean> {
    if (!room || !peerId) {
      return false;
    }
    const response = await fetch(`/api/room/${encodeURIComponent(room)}/reopen?peerId=${encodeURIComponent(peerId)}`, {
      method: "POST"
    });
    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    const expiresAt = Number(payload.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return false;
    }

    ownerCloseSentRef.current = false;
    setRoomOpen(expiresAt);
    await connectToRoom(room, false);
    return true;
  }

  async function createRoom(): Promise<void> {
    setRole("owner");
    try {
      const response = await fetch(`/api/room?ownerId=${encodeURIComponent(peerId)}`, { method: "POST" });
      const payload = await response.json();

      if (response.ok && typeof payload.room === "string") {
        await connectToRoom(payload.room, false);
        return;
      }

      if (response.status === 409 && payload?.error === "owner_has_active_room" && typeof payload.room === "string") {
        setStatusText("当前设备已有活跃房间，已进入该房间");
        await connectToRoom(payload.room, false);
        return;
      }

      setStatusText("创建房间失败，请稍后重试");
    } catch {
      setStatusText("创建房间失败，请稍后重试");
    }
  }

  async function sendFileInChunks(file: File): Promise<void> {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusText("房间未连接");
      return;
    }

    const transferId = crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const totalChunks = Math.max(1, Math.ceil(base64.length / BASE64_CHUNK_SIZE));

    if (
      !sendPayload({
        type: "file_start",
        transferId,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        totalChunks
      })
    ) {
      return;
    }

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * BASE64_CHUNK_SIZE;
      const end = start + BASE64_CHUNK_SIZE;
      const data = base64.slice(start, end);
      const chunkSize = base64ByteLength(data);
      const ok = sendPayload({
        type: "file_chunk",
        transferId,
        index,
        chunkSize,
        data
      });
      if (!ok) {
        return;
      }

      while (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && wsRef.current.bufferedAmount > 512 * 1024) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    sendPayload({
      type: "file_end",
      transferId
    });
  }

  const onBeforeUnload = useMemoizedFn((event: Event) => {
    if (!isOwner || !isConnected || roomClosed) {
      return;
    }
    const unloadEvent = event as BeforeUnloadEvent;
    unloadEvent.preventDefault();
    unloadEvent.returnValue = "离开页面会关闭房间并断开所有用户连接。";
  });

  const onPageHide = useMemoizedFn(() => {
    if (!isOwner || !isConnected || roomClosed) {
      return;
    }
    const activeRoom = roomRef.current;
    const activePeer = peerIdRef.current;
    if (!activeRoom || !activePeer || ownerCloseSentRef.current) {
      return;
    }
    const endpoint = `/api/room/${encodeURIComponent(activeRoom)}/close?peerId=${encodeURIComponent(activePeer)}`;
    if (navigator.sendBeacon) {
      ownerCloseSentRef.current = true;
      navigator.sendBeacon(endpoint, "");
    }
  });

  useEventListener("beforeunload", onBeforeUnload);
  useEventListener("pagehide", onPageHide);

  const sortedMessages = useMemo(() => {
    return [...messages].sort((a, b) => a.createdAt - b.createdAt);
  }, [messages]);

  const qrImageSrc = shareLink
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=6&data=${encodeURIComponent(shareLink)}`
    : "";

  return (
    <div className="app-bg">
      <div className="shell">
        <aside className="panel">
          <h1>闪传</h1>
          <p className="sub">无需登录，创建房间后即可实时互传文字、图片和文件。</p>
          <div className={`badge ${isConnected ? "online" : ""}`}>{statusText}</div>

          <div className="stack">
            <input
              type="text"
              maxLength={32}
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value)}
              placeholder="房间号示例：huoli-xingqiu-123"
            />

            <div className="row">
              {role !== "joiner" && (
                <button className="btn btn-primary" type="button" onClick={() => void createRoom()}>
                  创建房间
                </button>
              )}
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setRole("joiner");
                  void connectToRoom(roomInput, false);
                }}
              >
                加入房间
              </button>
            </div>

            {showCloseRoom && (
              <button
                className="btn btn-mute"
                type="button"
                onClick={async () => {
                  const accepted = window.confirm("关闭后所有人会断开，且无法重新连接。确定关闭房间吗？");
                  if (!accepted) {
                    return;
                  }
                  const ok = await closeRoomByOwner(false);
                  if (!ok) {
                    setStatusText("关闭房间失败，请重试");
                  }
                }}
              >
                关闭房间
              </button>
            )}

            {showReopenRoom && (
              <button
                className="btn btn-primary"
                type="button"
                onClick={async () => {
                  const ok = await reopenRoomByOwner();
                  if (!ok) {
                    setStatusText("重新开启失败，请重试");
                  }
                }}
              >
                再次开启该房间
              </button>
            )}
          </div>

          <div className="share">
            <div className="share-link">{shareLink || "创建或加入房间后生成分享链接。"}</div>
            {showCopyLink && (
              <button
                className="btn btn-mute"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareLink);
                    setStatusText("链接已复制");
                  } catch {
                    setStatusText("复制失败，请手动复制");
                  }
                }}
              >
                复制链接
              </button>
            )}

            {showQrCard && (
              <button className="qr-card" type="button" onClick={() => setQrModalLink(shareLink)}>
                <img className="qr-image" src={qrImageSrc} alt="房间二维码" />
                <p className="note">手机扫码即可进入当前房间。</p>
              </button>
            )}

            <div className="timer-card">
              <div className={`timer-ring ${timerUrgent ? "urgent" : ""}`} style={{ ["--progress" as string]: timerProgress }}>
                <div className="timer-core">
                  <span className="timer-text">{remainingMs === null ? "--:--" : formatCountdown(remainingMs)}</span>
                </div>
              </div>
              <p className="note">{remainingMs === null ? "房间有效期：01:00:00" : "房间倒计时中"}</p>
            </div>
          </div>

          <p className="note">在线人数：{participantCount}</p>
          <p className="note">单个文件大小上限：8MB。</p>
        </aside>

        <section className="main">
          <div className="feed">
            {sortedMessages.length === 0 && pendingTransfers.length === 0 && (
              <div className="welcome">
                像 IM 里的传输助手一样使用：把房间链接或二维码发给对方，双方即可实时收发文字、图片和文件。
              </div>
            )}

            {sortedMessages.map((message) => (
              <article className={`msg ${message.senderId === peerId ? "mine" : ""}`} key={message.id}>
                <div className="msg-head">
                  <span className="sender" style={{ color: message.senderColor }}>
                    {message.senderName}
                  </span>
                  <span>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>

                {message.kind === "text" ? (
                  <p className="text">
                    {renderTextWithLinks(message.text).map((part, index) => {
                      if (typeof part === "string") {
                        return <span key={`${message.id}-text-${index}`}>{part}</span>;
                      }
                      return (
                        <a key={`${message.id}-link-${index}`} className="text-link" href={part.href} target="_blank" rel="noreferrer">
                          {part.text}
                        </a>
                      );
                    })}
                  </p>
                ) : (
                  <div className="file">
                    <div className="file-line">
                      <strong>{message.fileName || "文件"}</strong>
                      <span>{formatBytes(message.size)}</span>
                    </div>
                    {message.mime.startsWith("image/") && <img className="preview" src={message.data} alt={message.fileName} />}
                    <a className="download" href={message.data} download={message.fileName || "下载文件"}>
                      下载文件
                    </a>
                  </div>
                )}
              </article>
            ))}

            {pendingTransfers.map((transfer) => {
              const progress = transfer.size > 0 ? Math.min(100, Math.round((transfer.receivedBytes / transfer.size) * 100)) : 0;
              const isMine = transfer.senderId === peerId;
              return (
                <article className={`msg ${isMine ? "mine" : ""}`} key={transfer.key}>
                  <div className="msg-head">
                    <span className="sender" style={{ color: transfer.senderColor }}>
                      {transfer.senderName}
                    </span>
                    <span>{new Date(transfer.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>

                  <div className="file">
                    <div className="file-line">
                      <strong>{transfer.fileName}</strong>
                      <span>{formatBytes(transfer.size)}</span>
                    </div>
                    <div className="progress-meta">
                      <span>{isMine ? "发送中" : "接收中"}</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="actions">
            <div className="composer">
              <textarea
                ref={textareaRef}
                maxLength={4000}
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                onInput={(event) => {
                  const target = event.currentTarget;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 170)}px`;
                }}
                placeholder="输入要发送的内容"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!textValue.trim()) {
                      return;
                    }
                    if (sendPayload({ type: "text", text: textValue.trim() })) {
                      setTextValue("");
                    }
                  }
                }}
              />

              <button
                className="btn btn-primary"
                type="button"
                disabled={!canSend}
                onClick={() => {
                  const value = textValue.trim();
                  if (!value) {
                    return;
                  }
                  if (sendPayload({ type: "text", text: value })) {
                    setTextValue("");
                  }
                }}
              >
                发送文字
              </button>

              <button
                className="btn btn-secondary"
                type="button"
                disabled={!canSend}
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              >
                发送文件
              </button>

              <input
                ref={fileInputRef}
                type="file"
                hidden
                disabled={!canSend}
                onChange={async (event) => {
                  const files = Array.from(event.target.files || []);
                  event.currentTarget.value = "";
                  for (const file of files) {
                    if (file.size > MAX_FILE_BYTES) {
                      setStatusText("文件过大（最大 8MB）");
                      continue;
                    }
                    try {
                      await sendFileInChunks(file);
                    } catch {
                      setStatusText("文件读取失败");
                    }
                  }
                }}
              />
            </div>
          </div>
        </section>
      </div>

      {qrModalLink && (
        <div className="qr-modal">
          <div className="qr-modal-card">
            <p className="qr-modal-title">房间二维码</p>
            <img
              className="qr-modal-image"
              src={`https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=${encodeURIComponent(qrModalLink)}`}
              alt="房间二维码"
            />
            <button className="qr-modal-close" type="button" onClick={() => setQrModalLink("")}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
