import { UserAgent } from "@std/http/user-agent";
import { serveDir } from "@std/http/file-server";
import { type Cookie, getCookies, setCookie } from "@std/http/cookie";
import { faker } from "@faker-js/faker";

// --- Configuration constants ---
const KEEPALIVE_INTERVAL = 30000; // 30 seconds

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
    console.log(`Peer joined: ${peer.id}, room size: ${this.peers.size}`);
  }

  // Handle logic when a peer leaves the room
  public removePeer(peerId: string): void {
    if (this.peers.has(peerId)) {
      this.peers.delete(peerId);
      this.broadcast({ type: "peer-left", peerId: peerId });
      console.log(`Peer left: ${peerId}, room size: ${this.peers.size}`);
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
      console.log(`Room for IP ${ip} is empty and has been removed.`);
    }
  }
}

const roomManager = new RoomManager();

// --- WebSocket connection handler ---
function handleWebSocket(req: Request, remoteAddr: Deno.NetAddr): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ip = remoteAddr.hostname;

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
        console.error("Failed to parse message:", error);
      }
    });

    // Use 'close' event to handle disconnections; more reliable than custom 'disconnect' message
    socket.addEventListener("close", () => {
      peer.close(); // Trigger onDisconnect callback
    });

    socket.addEventListener("error", (err) => {
      console.error(`WebSocket error for peer ${peer.id}:`, err);
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
  console.log(
    `Incoming request: ${url.pathname} from ${info.remoteAddr.hostname}`,
    "header",
    req.headers,
    "info",
    info.remoteAddr,
  );
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

console.log("Server listening on http://localhost:8000");
