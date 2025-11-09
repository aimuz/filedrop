import { UserAgent } from "@std/http/user-agent";
import { serveDir } from "@std/http/file-server";
import { getCookies } from "@std/http/cookie";
import { faker } from "@faker-js/faker";
import { matchSubnets } from "@std/net/unstable-ip";

// --- Configuration constants ---
const KEEPALIVE_INTERVAL = 30000; // 30 seconds

// --- Logging utility ---
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogMeta = Record<string, unknown>;

const LOG_LEVEL_PRIORITIES: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

function resolveActiveLogLevel(): LogLevel {
  const envLevel = Deno.env.get("LOG_LEVEL")?.toUpperCase();
  if (envLevel && envLevel in LOG_LEVEL_PRIORITIES) {
    return envLevel as LogLevel;
  }
  return "INFO";
}

const ACTIVE_LOG_LEVEL = resolveActiveLogLevel();

const levelToConsole: Record<LogLevel, (...args: unknown[]) => void> = {
  DEBUG: console.debug,
  INFO: console.log,
  WARN: console.warn,
  ERROR: console.error,
};

function log(level: LogLevel, message: string, meta?: LogMeta): void {
  if (
    LOG_LEVEL_PRIORITIES[level] < LOG_LEVEL_PRIORITIES[ACTIVE_LOG_LEVEL]
  ) {
    return;
  }
  const timestamp = new Date().toISOString();
  const formattedMeta = meta && Object.keys(meta).length > 0 ? meta : undefined;
  levelToConsole[level](
    `[${timestamp}] [${level}] ${message}`,
    ...(formattedMeta ? [formattedMeta] : []),
  );
}

const logger = {
  debug: (message: string, meta?: LogMeta) => log("DEBUG", message, meta),
  info: (message: string, meta?: LogMeta) => log("INFO", message, meta),
  warn: (message: string, meta?: LogMeta) => log("WARN", message, meta),
  error: (message: string, meta?: LogMeta) => log("ERROR", message, meta),
};

// --- Type definitions ---
// Define clear types for messages passed over WebSocket
type PeerInfo = {
  id: string;
  name: {
    deviceName: string;
    displayName: string;
  };
  rtcSupported: boolean;
};

type MessagePayload =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "display-name"; message: PeerInfo["name"] }
  | { type: "peerid"; message: string }
  | { type: "peers"; peers: PeerInfo[] }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "disconnect" }
  | { to: string; sender?: string; [key: string]: unknown }; // For relayed messages

// --- Peer class ---
// Represents a connected client, encapsulating its state and behavior
class Peer {
  public readonly id: string;
  public readonly ip: string;
  public readonly rtcSupported: boolean;
  public readonly name: {
    deviceName: string;
    displayName: string;
  };
  public readonly socket: WebSocket;

  private keepAliveTimerId: number | undefined;
  private lastBeat: number = Date.now();
  private onDisconnect: () => void;

  constructor(
    socket: WebSocket,
    req: Request,
    ip: string,
    onDisconnect: () => void,
  ) {
    this.socket = socket;
    this.ip = ip;
    this.onDisconnect = onDisconnect;
    this.id = getCookies(req.headers).peerid || crypto.randomUUID();
    this.rtcSupported = req.url.includes("webrtc");
    this.name = this.parseName(req);

    this.startKeepAlive();
  }

  // Parse device and display name from the request
  private parseName(req: Request): Peer["name"] {
    const ua = new UserAgent(req.headers.get("user-agent") ?? "");
    let deviceName = "";

    if (ua.os?.name) {
      deviceName = ua.os.name.replace("Mac OS", "Mac") + " ";
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name ?? "Browser";
    }

    return {
      deviceName: deviceName.trim() || "Unknown Device",
      displayName: faker.person.fullName(),
    };
  }

  // Send message to this Peer
  public send(message: MessagePayload): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  // Return a simplified info object safe to send to other clients
  public getInfo(): PeerInfo {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported,
    };
  }

  // Start keep-alive mechanism
  private startKeepAlive(): void {
    this.keepAliveTimerId = setInterval(() => {
      // If no pong received within 2 intervals, consider the connection lost
      if (Date.now() - this.lastBeat > KEEPALIVE_INTERVAL * 2) {
        this.close();
        return;
      }
      this.send({ type: "ping" });
    }, KEEPALIVE_INTERVAL);
  }

  // Record pong message and update last beat time
  public handlePong(): void {
    this.lastBeat = Date.now();
  }

  // Close connection and clean up resources
  public close(): void {
    if (this.keepAliveTimerId) {
      clearInterval(this.keepAliveTimerId);
    }
    if (this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
    // Call the onDisconnect callback registered in Room to remove itself
    this.onDisconnect();
  }
}

// --- Room class ---
// Encapsulates all logic for a room
class Room {
  private peers = new Map<string, Peer>();

  // Broadcast message to all peers in the room, optionally exclude a peer
  private broadcast(message: MessagePayload, excludeId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.id !== excludeId) {
        peer.send(message);
      }
    }
  }

  // Handle logic when a peer joins a room
  public addPeer(peer: Peer): void {
    // 1. Notify others in the room that a new peer joined
    this.broadcast(
      {
        type: "peer-joined",
        peer: peer.getInfo(),
      },
      peer.id,
    );

    // 2. Send the existing peers list to the new peer
    const existingPeers = [...this.peers.values()].map((p) => p.getInfo());
    peer.send({
      type: "peers",
      peers: existingPeers,
    });

    // 3. Add the new peer to the room
    this.peers.set(peer.id, peer);
    logger.info("Peer joined", {
      peerId: peer.id,
      peerIp: peer.ip,
      roomSize: this.peers.size,
    });
  }

  // Handle logic when a peer leaves the room
  public removePeer(peerId: string): void {
    if (this.peers.has(peerId)) {
      this.peers.delete(peerId);
      this.broadcast({ type: "peer-left", peerId: peerId });
      logger.info("Peer left", {
        peerId,
        roomSize: this.peers.size,
      });
    }
  }

  public getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  public isEmpty(): boolean {
    return this.peers.size === 0;
  }
}

// --- RoomManager class ---
// Manage all room instances, organized by IP address
class RoomManager {
  private rooms = new Map<string, Room>();

  public getOrCreateRoom(ip: string): Room {
    if (!this.rooms.has(ip)) {
      this.rooms.set(ip, new Room());
    }
    return this.rooms.get(ip)!;
  }

  public removeRoomIfEmpty(ip: string): void {
    const room = this.rooms.get(ip);
    if (room && room.isEmpty()) {
      this.rooms.delete(ip);
      logger.info("Room removed after last peer left", { roomIp: ip });
    }
  }
}

// --- Proxy whitelist handling ---
const proxyWhitelist = (Deno.env.get("PROXY_WHITELIST") ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function isTrustedProxyIP(ip: string): boolean {
  return matchSubnets(ip, proxyWhitelist);
}

function getClientIp(req: Request, remoteAddr: Deno.NetAddr): string {
  const headerIp = req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Real-IP") ??
    req.headers.get("X-Forwarded-For");

  const isTrustedProxy = isTrustedProxyIP(remoteAddr.hostname);

  if (isTrustedProxy && headerIp) {
    return headerIp.split(",")[0].trim();
  }

  return remoteAddr.hostname;
}

const roomManager = new RoomManager();

// --- WebSocket connection handler ---
function handleWebSocket(req: Request, remoteAddr: Deno.NetAddr): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  const ip = getClientIp(req, remoteAddr);

  socket.addEventListener("open", () => {
    const room = roomManager.getOrCreateRoom(ip);

    // Create a Peer instance with an onDisconnect callback
    // This callback ensures the peer is removed from the room when closed
    const peer = new Peer(socket, req, ip, () => {
      room.removePeer(peer.id);
      roomManager.removeRoomIfEmpty(ip);
    });

    // Handle messages from the client
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data) as MessagePayload;
        handleMessage(peer, message, room);
      } catch (error) {
        logger.error("Failed to parse client message", {
          peerId: peer.id,
          rawData: event.data,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });

    // Use 'close' event to handle disconnections; more reliable than custom 'disconnect' message
    socket.addEventListener("close", () => {
      peer.close(); // Trigger onDisconnect callback
    });

    socket.addEventListener("error", (err) => {
      logger.error("WebSocket transport error", {
        peerId: peer.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });

    // Add peer to the room
    room.addPeer(peer);

    // Send initial displayName
    peer.send({
      type: "display-name",
      message: peer.name,
    });

    // If it's a new peer, set a cookie
    if (!getCookies(req.headers).peerid) {
      peer.send({
        type: "peerid",
        message: peer.id,
      });
    }
  });

  return response;
}

// --- Message handler ---
// Decide how to handle different types of received messages
function handleMessage(
  sender: Peer,
  message: MessagePayload,
  room: Room,
): void {
  switch (message.type) {
    case "pong":
      sender.handlePong();
      break;

    // 'disconnect' message as a fallback, prefer 'close' event
    case "disconnect":
      sender.close();
      break;

    // Default behavior: relay message to specified recipient
    default:
      if ("to" in message && message.to) {
        const recipient = room.getPeer(message.to);
        if (recipient) {
          // Attach sender ID and forward
          message.sender = sender.id;
          recipient.send(message);
        }
      }
  }
}

// --- HTTP server ---
// Route: WebSocket connections
Deno.serve((req, info) => {
  const url = new URL(req.url);
  logger.info("Incoming request", {
    method: req.method,
    path: url.pathname,
    upgrade: req.headers.get("upgrade") ?? "",
  });
  logger.debug("Request headers", {
    headers: [...req.headers],
    remoteHost: info.remoteAddr.hostname,
  });
  if (
    url.pathname.startsWith("/server/webrtc") ||
    url.pathname.startsWith("/server/fallback")
  ) {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Upgrade required", { status: 426 });
    }
    return handleWebSocket(req, info.remoteAddr as Deno.NetAddr);
  }

  // Route: static file serving
  return serveDir(req, {
    fsRoot: "public",
    urlRoot: "",
    quiet: true,
  });
});

logger.info("Server listening", { url: "http://localhost:8000" });
