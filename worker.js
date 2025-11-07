import { uniqueNamesGenerator, animals, colors } from "unique-names-generator";
import { UAParser } from "ua-parser-js";

// We will use the IP address to identify the room.
// This is not ideal as multiple users can share the same IP address.
// But it's the same logic as the original implementation.
// A better approach would be to use a room ID in the URL.
// e.g. wss://example.com/room/123
// But this would require changes in the client-side code.
// For now, we will stick to the original logic.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/server/webrtc") {
      const ip = request.headers.get("CF-Connecting-IP");
      const id = env.ROOM.idFromName(ip);
      const room = env.ROOM.get(id);
      return room.fetch(request);
    }
    // Serve static assets for all other requests
    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.lastBeat = {};
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    const peerId = Peer.uuid();
    const pair = new WebSocketPair();
    const server = pair[0];
    const client = pair[1];

    server.accept();

    const peer = new Peer(server, request, peerId);
    this.sessions.push(peer);
    this.lastBeat[peer.id] = Date.now();

    server.addEventListener("message", (event) => {
      this.onMessage(peer, event.data);
    });

    server.addEventListener("close", () => {
      this.leaveRoom(peer);
    });

    server.addEventListener("error", (error) => {
      console.error(error);
      this.leaveRoom(peer);
    });

    this.joinRoom(peer);
    this.keepAlive(peer);

    // send displayName
    this.send(peer, {
      type: "display-name",
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName,
      },
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(sender, message) {
    try {
      message = JSON.parse(message);
    } catch (e) {
      return;
    }

    switch (message.type) {
      case "disconnect":
        this.leaveRoom(sender);
        break;
      case "pong":
        this.lastBeat[sender.id] = Date.now();
        break;
    }

    if (message.to) {
      const recipient = this.sessions.find((s) => s.id === message.to);
      if (recipient) {
        delete message.to;
        message.sender = sender.id;
        this.send(recipient, message);
      }
    }
  }

  joinRoom(peer) {
    // notify all other peers
    this.sessions.forEach((otherPeer) => {
      if (otherPeer.id !== peer.id) {
        this.send(otherPeer, {
          type: "peer-joined",
          peer: peer.getInfo(),
        });
      }
    });

    // notify peer about the other peers
    const otherPeers = this.sessions
      .filter((s) => s.id !== peer.id)
      .map((s) => s.getInfo());

    this.send(peer, {
      type: "peers",
      peers: otherPeers,
    });
  }

  leaveRoom(peer) {
    this.sessions = this.sessions.filter((s) => s.id !== peer.id);
    delete this.lastBeat[peer.id];
    this.cancelKeepAlive(peer);

    // notify all other peers
    this.sessions.forEach((otherPeer) => {
      this.send(otherPeer, { type: "peer-left", peerId: peer.id });
    });
  }

  send(peer, message) {
    if (!peer) return;
    try {
      peer.socket.send(JSON.stringify(message));
    } catch (e) {
      this.leaveRoom(peer);
    }
  }

  keepAlive(peer) {
    this.cancelKeepAlive(peer);
    const timeout = 30000;
    if (Date.now() - this.lastBeat[peer.id] > 2 * timeout) {
      this.leaveRoom(peer);
      return;
    }

    this.send(peer, { type: "ping" });

    peer.timerId = setTimeout(() => this.keepAlive(peer), timeout);
  }

  cancelKeepAlive(peer) {
    if (peer && peer.timerId) {
      clearTimeout(peer.timerId);
    }
  }
}

class Peer {
  constructor(socket, request, peerId) {
    this.socket = socket;
    this.id = peerId;
    this.rtcSupported = request.url.includes("webrtc");
    this._setName(request, peerId);
    this.timerId = 0;
  }

  _setName(req, seed) {
    const ua = new UAParser(req.headers.get("user-agent")).getResult();

    let deviceName = "";

    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace("Mac OS", "Mac") + " ";
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name;
    }

    if (!deviceName) deviceName = "Unknown Device";

    const displayName = uniqueNamesGenerator({
      length: 2,
      separator: " ",
      dictionaries: [colors, animals],
      style: "capital",
      seed: seed.hashCode(),
    });

    this.name = {
      model: ua.device.model,
      os: ua.os.name,
      browser: ua.browser.name,
      type: ua.device.type,
      deviceName,
      displayName,
    };
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported,
    };
  }

  static uuid() {
    let uuid = "",
      ii;
    for (ii = 0; ii < 32; ii += 1) {
      switch (ii) {
        case 8:
        case 20:
          uuid += "-";
          uuid += ((Math.random() * 16) | 0).toString(16);
          break;
        case 12:
          uuid += "-";
          uuid += "4";
          break;
        case 16:
          uuid += "-";
          uuid += ((Math.random() * 4) | 8).toString(16);
          break;
        default:
          uuid += ((Math.random() * 16) | 0).toString(16);
      }
    }
    return uuid;
  }
}

Object.defineProperty(String.prototype, "hashCode", {
  value: function () {
    var hash = 0,
      i,
      chr;
    for (i = 0; i < this.length; i++) {
      chr = this.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  },
});
