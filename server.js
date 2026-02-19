const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const cors = require("cors");

// ── App 1: Socket.io on port 5000 ────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", rooms: rooms.size }));

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

// roomId -> { peers: Map<socketId, peerId> }
const rooms = new Map();

io.on("connection", (socket) => {
    let currentRoom = null;
    let currentPeerId = null;

    // Flutter socket_io_client sends args as an array [roomId, peerId]
    // Browser socket.io sends them as separate args (roomId, peerId)
    socket.on("join-room", (arg1, arg2) => {
        const roomId = Array.isArray(arg1) ? arg1[0] : arg1;
        const peerId = Array.isArray(arg1) ? arg1[1] : arg2;

        // ── MAX 2 PEERS per room ──────────────────────────────────────────────
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        if (room.size >= 2) {
            console.log(`[room:${roomId}] FULL — rejecting ${peerId}`);
            socket.emit("room-full", roomId);
            return; // do NOT join
        }

        // Leave any previous room first
        if (currentRoom) {
            leaveRoom(socket, currentRoom, currentPeerId);
        }

        currentRoom = roomId;
        currentPeerId = peerId;
        socket.join(roomId);
        room.set(socket.id, peerId);

        // Tell existing peer(s) about the new joiner (send socket.id so replies can be targeted)
        socket.to(roomId).emit("user-connected", { peerId, socketId: socket.id });

        // Tell new joiner the current count
        socket.emit("room-count", room.size);

        console.log(`[room:${roomId}] ${peerId.slice(0, 8)}… joined (${room.size} total)`);
    });

    // Explicit clean exit — called by client before navigating away
    // This ensures room is cleared BEFORE the socket disconnects
    socket.on("leave-room", () => {
        if (currentRoom && currentPeerId) {
            leaveRoom(socket, currentRoom, currentPeerId);
            currentRoom = null;
            currentPeerId = null;
        }
    });

    socket.on("disconnect", () => {
        if (currentRoom && currentPeerId) {
            leaveRoom(socket, currentRoom, currentPeerId);
        }
    });

    // ── WebRTC SDP relay — targeted to the other peer only ───────────────────

    // Offer carries the target socket id so we relay only to them
    socket.on("offer", (data) => {
        if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("offer", { ...data, fromSocketId: socket.id });
        } else {
            socket.to(data.roomId).emit("offer", { ...data, fromSocketId: socket.id });
        }
    });

    socket.on("answer", (data) => {
        if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("answer", data);
        } else {
            socket.to(data.roomId).emit("answer", data);
        }
    });

    socket.on("ice-candidate", (data) => {
        if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("ice-candidate", data);
        } else {
            socket.to(data.roomId).emit("ice-candidate", data);
        }
    });
});

function leaveRoom(socket, roomId, peerId) {
    try {
        socket.to(roomId).emit("user-disconnected", peerId);
        const room = rooms.get(roomId);
        if (room) {
            room.delete(socket.id);
            if (room.size === 0) rooms.delete(roomId);
        }
        socket.leave(roomId);
        const label = (peerId && typeof peerId === 'string') ? peerId.slice(0, 8) : String(peerId);
        console.log(`[room:${roomId}] ${label}… left`);
    } catch (err) {
        console.error("[leaveRoom] error:", err);
    }
}

const SOCKET_PORT = process.env.SOCKET_PORT || 5000;
httpServer.listen(SOCKET_PORT, () => {
    console.log(`🔌 Socket.io server  →  http://localhost:${SOCKET_PORT}`);
});

// ── App 2: PeerJS server on port 9000 (kept for future use) ──────────────────
const peerApp = express();
const peerHttpServer = createServer(peerApp);
peerApp.use(cors({ origin: "*" }));

const peerServer = ExpressPeerServer(peerHttpServer, { debug: false, path: "/" });
peerApp.use("/peerjs", peerServer);
peerApp.get("/", (_req, res) => res.json({ status: "peerjs-ok" }));

const PEER_PORT = process.env.PEER_PORT || 9000;
peerHttpServer.listen(PEER_PORT, () => {
    console.log(`🤝 PeerJS server      →  http://localhost:${PEER_PORT}/peerjs`);
});
