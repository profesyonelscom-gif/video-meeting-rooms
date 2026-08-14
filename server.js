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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRoomsHtml(rooms) {
  if (!rooms.length) {
    return '<p class="empty-msg">Henüz oda yok. <a href="/admin.html" class="text-link">Admin panelden</a> oda ekleyin.</p>';
  }

  return rooms
    .map(
      (room) => `
    <button type="button" class="room-option" data-room-id="${escapeHtml(room.id)}" data-room-name="${escapeHtml(room.name)}">
      <div class="room-name">${escapeHtml(room.name)}</div>
      <div class="room-count">${room.participants || 0} katılımcı</div>
    </button>`
    )
    .join('');
}

function sendIndexPage(_req, res) {
  const templatePath = path.join(__dirname, 'public', 'index.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  const rooms = mapRoomsForApi();
  const { logoUrl } = settingsStore.getPublicSettings();
  const roomsJson = JSON.stringify(rooms).replace(/</g, '\\u003c');
  const html = template
    .replace('__ROOMS_JSON__', roomsJson)
    .replace('__ROOMS_HTML__', buildRoomsHtml(rooms))
    .replace('__LOGO_URL__', logoUrl ? escapeHtml(logoUrl) : '')
    .replace('__SPLASH_LOGO_IMG_HIDDEN__', logoUrl ? '' : 'hidden')
    .replace('__SPLASH_LOGO_FALLBACK_HIDDEN__', logoUrl ? 'hidden' : '');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
}

app.get('/', sendIndexPage);
app.get('/index.html', (_req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === ADMIN_PASSWORD;
}

function broadcastRoomsChanged() {
  io.emit('rooms-changed', mapRoomsForApi());
}

function disconnectSocketFromRoom(socket, roomId) {
  if (!roomId) return;
  socket.to(roomId).emit('user-left', { socketId: socket.id });
  socket.leave(roomId);
  socket.data.roomId = null;
}

function replaceStaleClientInRoom(roomId, clientId, exceptSocketId) {
  if (!clientId) return;
  for (const [id, peerSocket] of io.sockets.sockets) {
    if (id === exceptSocketId) continue;
    if (peerSocket.data.clientId === clientId && peerSocket.data.roomId === roomId) {
      peerSocket.emit('session-replaced');
      disconnectSocketFromRoom(peerSocket, roomId);
      peerSocket.disconnect(true);
    }
  }
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

  socket.on('join-room', ({ roomId, userName, clientId }, callback) => {
    if (!roomStore.findById(roomId)) {
      callback?.({ ok: false, error: 'Geçersiz oda' });
      return;
    }

    if (currentRoom && currentRoom !== roomId) {
      disconnectSocketFromRoom(socket, currentRoom);
      currentRoom = null;
    }

    if (clientId) {
      replaceStaleClientInRoom(roomId, clientId, socket.id);
    }

    currentRoom = roomId;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = clientId || null;

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

    broadcastRoomsChanged();

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

  socket.on('moderate-media', ({ targetId, action }) => {
    if (!currentRoom || !targetId) return;
    if (!['mute-mic', 'unmute-mic', 'mute-cam', 'unmute-cam'].includes(action)) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket?.rooms.has(currentRoom)) return;

    io.to(targetId).emit('moderate-media', {
      from: socket.id,
      fromName: socket.data.userName,
      action,
    });
  });

  socket.on('leave-room', () => {
    if (!currentRoom) return;
    disconnectSocketFromRoom(socket, currentRoom);
    currentRoom = null;
    broadcastRoomsChanged();
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      currentRoom = null;
      return;
    }
    socket.to(roomId).emit('user-left', { socketId: socket.id });
    socket.data.roomId = null;
    currentRoom = null;
    broadcastRoomsChanged();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const rooms = roomStore.getAll();
  console.log(`Sunucu çalışıyor: http://0.0.0.0:${PORT}`);
  console.log(`Odalar: ${rooms.map((r) => r.name).join(', ')}`);
});
