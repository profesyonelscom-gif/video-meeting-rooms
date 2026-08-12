const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOMS = ['oda-1', 'oda-2', 'oda-3', 'oda-4'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rooms', (_req, res) => {
  const rooms = ROOMS.map((id) => ({
    id,
    name: id.replace('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    participants: io.sockets.adapter.rooms.get(id)?.size || 0,
  }));
  res.json(rooms);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: ROOMS.length });
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, userName }, callback) => {
    if (!ROOMS.includes(roomId)) {
      callback?.({ ok: false, error: 'Geçersiz oda' });
      return;
    }

    if (currentRoom) {
      socket.leave(currentRoom);
    }

    currentRoom = roomId;
    socket.join(roomId);

    const peers = [...io.sockets.adapter.rooms.get(roomId)]
      .filter((id) => id !== socket.id)
      .map((id) => {
        const peer = io.sockets.sockets.get(id);
        return {
          socketId: id,
          userName: peer?.data.userName || 'Anonim',
        };
      });

    socket.data.userName = (userName || 'Anonim').trim().slice(0, 32) || 'Anonim';

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName: socket.data.userName,
    });

    callback?.({
      ok: true,
      socketId: socket.id,
      roomId,
      peers,
      userName: socket.data.userName,
    });
  });

  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', {
      from: socket.id,
      signal,
      userName: socket.data.userName,
    });
  });

  socket.on('leave-room', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('user-left', { socketId: socket.id });
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', { socketId: socket.id });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu çalışıyor: http://0.0.0.0:${PORT}`);
  console.log(`Odalar: ${ROOMS.join(', ')}`);
});
