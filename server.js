const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const httpServer = createServer(app);

// Allow all origins in dev; set ALLOWED_ORIGINS in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : "*";

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Health check — Railway/Render ping this
app.get("/", (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) => res.json({ status: "ok", rooms: rooms.size }));

const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    // Allow both ws and polling so mobile clients work behind proxies
    transports: ["websocket", "polling"],
});

// roomId -> Map<socketId, peerId>
const rooms = new Map();

io.on("connection", (socket) => {
    let currentRoom = null;
    let currentPeerId = null;

    // Flutter sends [roomId, peerId] as array; browser sends separate args
    socket.on("join-room", (arg1, arg2) => {
        const roomId = Array.isArray(arg1) ? arg1[0] : arg1;
        const peerId = Array.isArray(arg1) ? arg1[1] : (arg2 ?? socket.id);

        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        if (room.size >= 2) {
            console.log(`[room:${roomId}] FULL`);
            socket.emit("room-full", roomId);
            return;
        }

        if (currentRoom) leaveRoom(socket, currentRoom, currentPeerId);

        currentRoom = roomId;
        currentPeerId = peerId;
        socket.join(roomId);
        room.set(socket.id, peerId);

        socket.to(roomId).emit("user-connected", { peerId, socketId: socket.id });
        socket.emit("room-count", room.size);

        console.log(`[room:${roomId}] joined (${room.size}/2)`);
    });

    // Client sends this BEFORE disconnecting to guarantee fast room cleanup
    socket.on("leave-room", () => {
        if (currentRoom) {
            leaveRoom(socket, currentRoom, currentPeerId);
            currentRoom = currentPeerId = null;
        }
    });

    socket.on("disconnect", () => {
        if (currentRoom) leaveRoom(socket, currentRoom, currentPeerId);
    });

    // ── WebRTC signaling relay ────────────────────────────────────────────────
    socket.on("offer", (data) => {
        const target = data.targetSocketId;
        const payload = { ...data, fromSocketId: socket.id };
        target ? io.to(target).emit("offer", payload)
            : socket.to(data.roomId).emit("offer", payload);
    });

    socket.on("answer", (data) => {
        const target = data.targetSocketId;
        target ? io.to(target).emit("answer", data)
            : socket.to(data.roomId).emit("answer", data);
    });

    socket.on("ice-candidate", (data) => {
        const target = data.targetSocketId;
        target ? io.to(target).emit("ice-candidate", data)
            : socket.to(data.roomId).emit("ice-candidate", data);
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
        console.log(`[room:${roomId}] left (${rooms.get(roomId)?.size ?? 0}/2)`);
    } catch (err) {
        console.error("[leaveRoom]", err.message);
    }
}

// Railway assigns PORT automatically; fallback to 5000 locally
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`🔌 Signaling server running on port ${PORT}`);
});
