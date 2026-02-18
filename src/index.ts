import { RoomDurableObject } from "./room-durable-object";
import { generateRoomName, jsonResponse, normalizeRoom, sanitizeColor, sanitizePeerId } from "./shared";

interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const ROOM_DURATION_MS = 60 * 60 * 1000;
const OWNER_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

function normalizeOwnerId(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!OWNER_ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/room") {
      const ownerId = normalizeOwnerId(url.searchParams.get("ownerId") ?? "");
      if (!ownerId) {
        return jsonResponse({ ok: false, error: "owner_id_invalid" }, 400);
      }

      const room = generateRoomName();
      const ownerStub = env.ROOMS.get(env.ROOMS.idFromName(`owner:${ownerId}`));
      const allocateUrl = new URL("https://state.internal/owner/allocate");
      allocateUrl.searchParams.set("room", room);
      allocateUrl.searchParams.set("ttlMs", String(ROOM_DURATION_MS));
      const allocateResponse = await ownerStub.fetch(new Request(allocateUrl.toString(), { method: "POST" }));

      if (allocateResponse.status === 409) {
        const payload = await allocateResponse.json();
        return jsonResponse(payload, 409);
      }
      if (!allocateResponse.ok) {
        return jsonResponse({ ok: false, error: "room_allocate_failed" }, 500);
      }

      return jsonResponse({ room });
    }

    const roomActionMatch = url.pathname.match(/^\/api\/room\/([a-z0-9-]{3,32})\/(close|reopen)$/);
    if (request.method === "POST" && roomActionMatch) {
      const room = normalizeRoom(roomActionMatch[1]);
      const action = roomActionMatch[2];
      const rawPeerId = url.searchParams.get("peerId") ?? "";
      if (!room || rawPeerId.trim().length === 0) {
        return jsonResponse({ ok: false, error: "缺少房间或身份参数" }, 400);
      }

      const peerId = sanitizePeerId(rawPeerId);
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(`room:${room}`));
      const doUrl = new URL(`https://room.internal/control/${action}`);
      doUrl.searchParams.set("peerId", peerId);
      return roomStub.fetch(new Request(doUrl.toString(), { method: "POST" }));
    }

    const wsMatch = url.pathname.match(/^\/ws\/([a-z0-9-]{3,32})$/);
    if (request.method === "GET" && wsMatch) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("需要 WebSocket 连接", { status: 426 });
      }

      const room = normalizeRoom(wsMatch[1]);
      if (!room) {
        return jsonResponse({ error: "房间号格式不正确" }, 400);
      }

      const peerId = sanitizePeerId(url.searchParams.get("peerId") ?? crypto.randomUUID());
      const role = url.searchParams.get("role") === "owner" ? "owner" : "joiner";
      const color = sanitizeColor(url.searchParams.get("color") ?? "#ff4d8d");

      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(`room:${room}`));
      const doUrl = new URL("https://room.internal/connect");
      doUrl.searchParams.set("room", room);
      doUrl.searchParams.set("peerId", peerId);
      doUrl.searchParams.set("role", role);
      doUrl.searchParams.set("color", color);
      return roomStub.fetch(new Request(doUrl.toString(), request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    if (request.method === "GET") {
      return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
    }

    return assetResponse;
  }
} satisfies ExportedHandler<Env>;

export { RoomDurableObject };
