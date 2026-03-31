const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",                    // Flutter, Web, Mobile সব থেকে আসবে
    methods: ["GET", "POST"],
    credentials: true
  }
});

const rooms = new Map();   // roomId => Map<socketId, peerId>

io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    let currentRoom = null;
    let currentPeerId = null;

    // ====================== JOIN ROOM ======================
    socket.on("join-room", (arg1, arg2) => {
        const roomId = Array.isArray(arg1) ? arg1[0] : arg1;
        const peerId = Array.isArray(arg1) ? arg1[1] : (arg2 ?? socket.id);

        if (!roomId) return socket.emit("error", "Room ID required");

        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        // 2 person limit
        if (room.size >= 2) {
            socket.emit("room-full", roomId);
            return;
        }

        // Leave previous room if any
        if (currentRoom) leaveRoom(socket, currentRoom, currentPeerId);

        currentRoom = roomId;
        currentPeerId = peerId;

        socket.join(roomId);
        room.set(socket.id, peerId);

        // Notify other user
        socket.to(roomId).emit("user-connected", { 
            peerId, 
            socketId: socket.id 
        });

        socket.emit("room-count", room.size);
        console.log(`[Room ${roomId}] ${peerId} joined (${room.size}/2)`);
    });

    // ====================== WEBRTC SIGNALING ======================
    socket.on("offer", (data) => {
        if (data.roomId) {
            socket.to(data.roomId).emit("offer", { ...data, from: socket.id });
        } else if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("offer", { ...data, from: socket.id });
        }
    });

    socket.on("answer", (data) => {
        if (data.roomId) {
            socket.to(data.roomId).emit("answer", { ...data, from: socket.id });
        } else if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("answer", { ...data, from: socket.id });
        }
    });

    socket.on("ice-candidate", (data) => {
        if (data.roomId) {
            socket.to(data.roomId).emit("ice-candidate", { ...data, from: socket.id });
        } else if (data.targetSocketId) {
            io.to(data.targetSocketId).emit("ice-candidate", { ...data, from: socket.id });
        }
    });

    // Extra call events
    socket.on("call-rejected", (data) => socket.to(data.roomId).emit("call-rejected", data));
    socket.on("call-busy", (data) => socket.to(data.roomId).emit("call-busy", data));
    socket.on("call-accepted", (data) => socket.to(data.roomId).emit("call-accepted", data));

    // ====================== LEAVE ======================
    socket.on("leave-room", () => {
        if (currentRoom) {
            leaveRoom(socket, currentRoom, currentPeerId);
            currentRoom = currentPeerId = null;
        }
    });

    socket.on("disconnect", () => {
        if (currentRoom) {
            leaveRoom(socket, currentRoom, currentPeerId);
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

function leaveRoom(socket, roomId, peerId) {
    socket.to(roomId).emit("user-disconnected", peerId);

    const room = rooms.get(roomId);
    if (room) {
        room.delete(socket.id);
        if (room.size === 0) rooms.delete(roomId);
    }
    socket.leave(roomId);
    console.log(`[Room ${roomId}] ${peerId} left`);
}

// Start Server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`✅ Signaling Server running on port ${PORT}`);
});
