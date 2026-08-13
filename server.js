const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const roomStore = require('./lib/rooms');
const settingsStore = require('./lib/settings');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json({ limit: '3mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

function sendIndexPage(_req, res) {
  const templatePath = path.join(__dirname, 'public', 'index.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  const roomsJson = JSON.stringify(mapRoomsForApi()).replace(/</g, '\\u003c');
  const html = template.replace('__ROOMS_JSON__', roomsJson);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
}

app.get('/', sendIndexPage);
app.get('/index.html', (_req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function getParticipantCount(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size || 0;
}

function mapRoomsForApi() {
  return roomStore.getAll().map((room) => ({
    id: room.id,
    name: room.name,
    participants: getParticipantCount(room.id),
  }));
}

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === ADMIN_PASSWORD;
}

function broadcastRoomsChanged() {
  io.emit('rooms-changed', mapRoomsForApi());
}

app.get('/api/rooms', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(mapRoomsForApi());
});

app.get('/api/settings', (_req, res) => {
  res.json(settingsStore.getPublicSettings());
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ ok: false, error: 'Hatalı şifre' });
});

app.post('/api/admin/rooms', (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
    return;
  }

  try {
    const room = roomStore.add(req.body?.name);
    broadcastRoomsChanged();
    res.status(201).json({ ok: true, room: { ...room, participants: 0 } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put('/api/admin/rooms/:id', (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
    return;
  }

  try {
    const room = roomStore.update(req.params.id, req.body?.name);
    broadcastRoomsChanged();
    res.json({ ok: true, room: { ...room, participants: getParticipantCount(room.id) } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
    return;
  }

  const participants = getParticipantCount(req.params.id);
  if (participants > 0) {
    res.status(400).json({ ok: false, error: 'Odada katılımcı varken silinemez' });
    return;
  }

  try {
    const room = roomStore.remove(req.params.id);
    broadcastRoomsChanged();
    res.json({ ok: true, room });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/logo', (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
    return;
  }

  const { data } = req.body || {};
  const match = typeof data === 'string' ? data.match(/^data:(image\/[\w.+-]+);base64,(.+)$/) : null;

  if (!match) {
    res.status(400).json({ ok: false, error: 'Geçersiz logo dosyası' });
    return;
  }

  try {
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const logoUrl = settingsStore.saveLogo(buffer, mimeType);
    res.json({ ok: true, logoUrl });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/admin/logo', (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
    return;
  }

  settingsStore.removeLogo();
  res.json({ ok: true, logoUrl: null });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: roomStore.getAll().length });
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.emit('rooms-changed', mapRoomsForApi());

  socket.on('join-room', ({ roomId, userName }, callback) => {
    if (!roomStore.findById(roomId)) {
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

    const room = roomStore.findById(roomId);

    callback?.({
      ok: true,
      socketId: socket.id,
      roomId,
      roomName: room?.name || roomId,
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
  const rooms = roomStore.getAll();
  console.log(`Sunucu çalışıyor: http://0.0.0.0:${PORT}`);
  console.log(`Odalar: ${rooms.map((r) => r.name).join(', ')}`);
});
