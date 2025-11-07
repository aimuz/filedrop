import { UserAgent } from "@std/http/user-agent";
import { serveDir } from "@std/http/file-server";
import { getCookies, setCookie } from "@std/http/cookie";
import { faker } from '@faker-js/faker';

Deno.serve((req, info) => {
  if (
    req.url.includes("/server/webrtc") || req.url.includes("/server/fallback")
  ) {
    if (req.headers.get("upgrade") != "websocket") {
      return new Response(null, { status: 426 });
    }
    return websocket(req, info.remoteAddr.hostname as "");
  }
  return serveDir(req, {
    fsRoot: "public",
    urlRoot: "",
  });
});

const websocket = (req: Request, ip: string) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const headers = new Headers(response.headers)
  const peer = new Peer(socket, req, ip);
  if (!peer.id) {
    const uuid = self.crypto.randomUUID();
    peer.id = uuid;
    setCookie(headers, {
      name: "peerid",
      value: uuid,
      sameSite: "Strict",
      secure: true,
    });
  }
  const editableResponse = new Response(response.body, {
    headers: headers,
    status: response.status,
    statusText: response.statusText,
  })

  socket.addEventListener("open", () => {
    joinRoom(peer);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        onMessage(peer, message);
      } catch {
        return;
      }
    });
    // send displayName
    send(peer, {
      type: "display-name",
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName,
      },
    });
  });
  return editableResponse;
};

const rooms: { [key: string]: { [key: string]: Peer } } = {};

const joinRoom = (peer: Peer) => {
  if (!rooms[peer.ip]) {
    rooms[peer.ip] = {};
  }
  for (const otherPeerId in rooms[peer.ip]) {
    const otherPeer = rooms[peer.ip][otherPeerId];
    send(otherPeer, {
      type: "peer-joined",
      peer: peer.getInfo(),
    });
  }

  // notify peer about the other peers
  const otherPeers = [];
  for (const otherPeerId in rooms[peer.ip]) {
    otherPeers.push(rooms[peer.ip][otherPeerId].getInfo());
  }

  send(peer, {
    type: "peers",
    peers: otherPeers,
  });

  // add peer to room
  rooms[peer.ip][peer.id] = peer;
};

const leaveRoom = (peer: Peer) => {
  if (!rooms[peer.ip] || !rooms[peer.ip][peer.id]) return;
  peer.cancelKeepAlive();

  // delete the peer
  delete rooms[peer.ip][peer.id];

  peer.socket.close();
  //if room is empty, delete the room
  if (!Object.keys(rooms[peer.ip]).length) {
    delete rooms[peer.ip];
  } else {
    // notify all other peers
    for (const otherPeerId in rooms[peer.ip]) {
      const otherPeer = rooms[peer.ip][otherPeerId];
      send(otherPeer, { type: "peer-left", peerId: peer.id });
    }
  }
};

const send = (peer: Peer, msg: any) => {
  if (!peer) return;
  if (peer.socket.readyState != peer.socket.OPEN) return;
  peer.socket.send(JSON.stringify(msg));
};

const onMessage = (sender: Peer, message: any) => {
  switch (message.type) {
    case "disconnect":
      leaveRoom(sender);
      break;
    case "pong":
      sender.lastBeat = Date.now();
      break;
  }

  // relay message to recipient
  if (message.to && rooms[sender.ip]) {
    const recipientId = message.to; // TODO: sanitize
    const recipient = rooms[sender.ip][recipientId];
    delete message.to;
    // add sender id
    message.sender = sender.id;
    send(recipient, message);
    return;
  }
};

class Peer {
  public id: string;
  public ip: string;
  public rtcSupported: boolean;
  public name: {
    model: string | undefined;
    os: string | undefined;
    browser: string | undefined;
    type: string | undefined;
    deviceName: string;
    displayName: string;
  };
  public socket: WebSocket;
  public timerId = 0;
  public lastBeat: number;
  constructor(
    socket: WebSocket,
    req: Request,
    ip: string,
  ) {
    this.socket = socket;
    this.id = this._getID(req);
    this.ip = ip;
    this.rtcSupported = req.url.indexOf("webrtc") > -1;
    this.name = this._getName(req);
    this.lastBeat = Date.now();
  }

  _getID(req: Request) {
    const { peerid } = getCookies(req.headers);
    return peerid;
  }

  _getName(req: Request) {
    const ua = new UserAgent(req.headers.get("user-agent") ?? "");

    let deviceName = "";

    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace("Mac OS", "Mac") + " ";
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name;
    }
    if (!deviceName) {
      deviceName = "Unknown Device";
    }

    const displayName = faker.person.fullName();
    return {
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
  keepAlive() {
    this.cancelKeepAlive();
    let timeout = 30000;
    if (!this.lastBeat) {
      this.lastBeat = Date.now();
    }
    if (Date.now() - this.lastBeat > 2 * timeout) {
      leaveRoom(this);
      return;
    }
    send(this, { type: "ping" });
    this.timerId = setTimeout(() => this.keepAlive, timeout);
  }
  cancelKeepAlive() {
    if (this.timerId) {
      clearTimeout(this.timerId);
    }
  }
}
