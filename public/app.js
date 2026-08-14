const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

const state = {
  socket: null,
  localStream: null,
  cameraStream: null,
  screenStream: null,
  peers: new Map(),
  roomId: null,
  userName: '',
  socketId: null,
  micEnabled: true,
  camEnabled: true,
  screenSharing: false,
  selectedRoom: null,
  selectedRoomName: '',
  lobbySocket: null,
  roomsCache: [],
  pinnedTileId: null,
  videoGridReady: false,
};

const $ = (sel) => document.querySelector(sel);

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}

function getClientId() {
  try {
    let id = sessionStorage.getItem('meetingClientId');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('meetingClientId', id);
    }
    return id;
  } catch {
    return `client-${Date.now()}`;
  }
}

function shouldInitiate(localId, remoteId) {
  return localId < remoteId;
}

function forEachLocalAudioTrack(fn) {
  [state.cameraStream, state.localStream, state.screenStream].forEach((stream) => {
    stream?.getAudioTracks().forEach(fn);
  });
}

function forEachLocalVideoTrack(fn) {
  state.cameraStream?.getVideoTracks().forEach(fn);
}

function syncMediaControlUi() {
  const micBtn = $('#toggle-mic');
  const camBtn = $('#toggle-cam');
  micBtn?.classList.toggle('active', state.micEnabled);
  micBtn?.classList.toggle('muted', !state.micEnabled);
  camBtn?.classList.toggle('active', state.camEnabled);
  camBtn?.classList.toggle('muted', !state.camEnabled);
}

function updateLocalTileVideoState() {
  const localTile = $('#tile-local');
  if (!localTile || state.screenSharing) return;

  localTile.classList.toggle('no-video', !state.camEnabled);

  if (!state.camEnabled) {
    let avatar = localTile.querySelector('.avatar');
    if (!avatar) {
      avatar = document.createElement('div');
      avatar.className = 'avatar';
      localTile.appendChild(avatar);
    }
    avatar.textContent = getInitials(state.userName);
  } else {
    localTile.querySelector('.avatar')?.remove();
  }
}

function setMicEnabled(enabled) {
  state.micEnabled = enabled;
  forEachLocalAudioTrack((track) => {
    track.enabled = enabled;
  });
  state.peers.forEach((peer) => {
    peer.pc.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') {
        sender.track.enabled = enabled;
      }
    });
  });
  syncMediaControlUi();
}

function setCamEnabled(enabled) {
  if (state.screenSharing) return;

  state.camEnabled = enabled;
  forEachLocalVideoTrack((track) => {
    track.enabled = enabled;
  });
  state.peers.forEach((peer) => {
    peer.pc.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'video') {
        sender.track.enabled = enabled;
      }
    });
  });
  syncMediaControlUi();
  updateLocalTileVideoState();
}

function setSplashStatus(message) {
  const el = document.getElementById('splash-status');
  if (el && message) el.textContent = message;
}

function hideSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash || splash.classList.contains('hidden')) return;
  splash.classList.add('hidden');
  splash.setAttribute('aria-busy', 'false');
  setTimeout(() => splash.remove(), 400);
}

function startKeepAlive() {
  const ping = () => {
    fetch('/health', { cache: 'no-store', mode: 'same-origin' }).catch(() => {});
  };
  ping();
  setInterval(ping, 4 * 60 * 1000);
}

function applyLogo(logoUrl) {
  const img = $('#site-logo');
  const fallback = $('#logo-fallback');
  if (!img || !fallback) return;

  if (logoUrl) {
    img.src = logoUrl;
    img.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden');
    fallback.classList.remove('hidden');
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    applyLogo(data.logoUrl);
  } catch {
    /* varsayilan ikon */
  }
}

async function loadRooms() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) throw new Error('API hatasi');

    const rooms = await res.json();
    if (!Array.isArray(rooms)) throw new Error('Gecersiz veri');

    state.roomsCache = rooms;
    renderRoomList(rooms);
    return rooms;
  } catch (err) {
    console.warn('Oda listesi guncellenemedi:', err.message);
    const fallback = getInitialRooms();
    if (fallback.length) {
      state.roomsCache = fallback;
      renderRoomList(fallback);
    }
    return state.roomsCache;
  }
}

function getInitialRooms() {
  const el = document.getElementById('initial-rooms');
  if (!el) return [];
  try {
    const rooms = JSON.parse(el.textContent);
    return Array.isArray(rooms) ? rooms : [];
  } catch {
    return [];
  }
}

function initRoomList() {
  const container = $('#room-list');
  if (!container || container.dataset.ready) return;
  container.dataset.ready = '1';

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.room-option');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    selectRoom(
      btn.getAttribute('data-room-id'),
      btn.getAttribute('data-room-name'),
      btn
    );
  });
}

function renderRoomList(rooms) {
  const container = $('#room-list');
  if (!container) return;

  if (!rooms.length) {
    container.innerHTML = `
      <p class="empty-msg">Henüz oda yok. <a href="/admin.html" class="text-link">Admin panelden</a> oda ekleyin.</p>
    `;
    state.selectedRoom = null;
    state.selectedRoomName = '';
    updateJoinButton();
    return;
  }

  const previousSelection = state.selectedRoom;
  container.innerHTML = '';

  rooms.forEach((room) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'room-option';
    el.setAttribute('data-room-id', room.id);
    el.setAttribute('data-room-name', room.name);
    el.innerHTML = `
      <div class="room-name">${escapeHtml(room.name)}</div>
      <div class="room-count">${room.participants || 0} katılımcı</div>
    `;
    container.appendChild(el);

    if (previousSelection === room.id) {
      selectRoom(room.id, room.name, el);
    }
  });

  state.roomsCache = rooms;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function selectRoom(roomId, roomName, el) {
  if (!roomId || !el) return;
  state.selectedRoom = roomId;
  state.selectedRoomName = roomName || roomId;
  document.querySelectorAll('.room-option').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  updateJoinButton();
}

function updateJoinButton() {
  const nameInput = $('#user-name');
  const joinBtn = $('#join-btn');
  if (!nameInput || !joinBtn) return;
  joinBtn.disabled = !nameInput.value.trim() || !state.selectedRoom;
}

async function getLocalMedia() {
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.localStream = state.cameraStream;
    return true;
  } catch (err) {
    showToast('Kamera/mikrofon erişimi reddedildi. İzin verin ve tekrar deneyin.');
    console.error(err);
    return false;
  }
}

function getActiveVideoTrack() {
  return state.localStream?.getVideoTracks()[0] || null;
}

async function flushIceCandidates(peer) {
  if (!peer.pendingCandidates?.length || !peer.pc.remoteDescription) return;
  for (const candidate of peer.pendingCandidates) {
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('ICE candidate eklenemedi:', err);
    }
  }
  peer.pendingCandidates = [];
}

async function addIceCandidate(peer, candidate) {
  if (!candidate) return;
  if (peer.pc.remoteDescription) {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } else {
    peer.pendingCandidates = peer.pendingCandidates || [];
    peer.pendingCandidates.push(candidate);
  }
}

function createPeerConnection(remoteId, remoteName) {
  const existing = state.peers.get(remoteId);
  if (existing && existing.pc.connectionState !== 'closed') {
    return existing.pc;
  }
  if (existing) {
    existing.pc.close();
    state.peers.delete(remoteId);
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);
  const peer = { pc, remoteName, remoteStream: null, pendingCandidates: [] };

  state.localStream.getTracks().forEach((track) => {
    pc.addTrack(track, state.localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && state.socket) {
      state.socket.emit('signal', {
        to: remoteId,
        signal: { type: 'ice-candidate', candidate: event.candidate },
      });
    }
  };

  pc.ontrack = (event) => {
    const currentPeer = state.peers.get(remoteId);
    if (!currentPeer) return;

    const stream = event.streams[0] || currentPeer.remoteStream || new MediaStream();
    if (!event.streams[0]) {
      stream.addTrack(event.track);
    }

    currentPeer.remoteStream = stream;
    updateRemoteVideo(remoteId, stream, currentPeer.remoteName);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      pc.restartIce();
    } else if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      if (pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
            removePeer(remoteId);
          }
        }, 4000);
      } else {
        removePeer(remoteId);
      }
    }
  };

  state.peers.set(remoteId, peer);
  return pc;
}

async function createOffer(remoteId, remoteName) {
  if (!shouldInitiate(state.socketId, remoteId)) return;

  const pc = createPeerConnection(remoteId, remoteName);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit('signal', {
    to: remoteId,
    signal: { type: 'offer', sdp: offer },
  });
}

async function handleSignal(from, signal, userName) {
  let peer = state.peers.get(from);

  try {
    if (signal.type === 'offer') {
      const pc = createPeerConnection(from, userName);
      peer = state.peers.get(from);

      if (pc.signalingState !== 'stable') {
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushIceCandidates(peer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      state.socket.emit('signal', {
        to: from,
        signal: { type: 'answer', sdp: answer },
      });
    } else if (signal.type === 'answer') {
      if (!peer) {
        createPeerConnection(from, userName);
        peer = state.peers.get(from);
      }

      if (peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushIceCandidates(peer);
      }
    } else if (signal.type === 'ice-candidate') {
      if (!peer) {
        createPeerConnection(from, userName);
        peer = state.peers.get(from);
      }
      await addIceCandidate(peer, signal.candidate);
    }
  } catch (err) {
    console.error('Sinyal isleme hatasi:', err, signal.type, from);
  }
}

function getInitials(name) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getTileKey(tileEl) {
  if (!tileEl) return null;
  return tileEl.id === 'tile-local' ? 'local' : tileEl.id.replace('tile-', '');
}

function buildTileInnerHtml(name, isLocal, tileKey) {
  const label = isLocal ? `${name} (Sen)` : name;
  const modBtns = isLocal
    ? ''
    : `
      <button type="button" class="tile-btn mute-remote-btn" title="Mikrofonu kapat" data-target="${tileKey}" data-action="mute-mic">🔇</button>
      <button type="button" class="tile-btn cam-remote-btn" title="Kamerayı kapat" data-target="${tileKey}" data-action="mute-cam">📷</button>
    `;

  return `
    <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
    <span class="tile-label">${escapeHtml(label)}</span>
    <div class="tile-actions">
      <button type="button" class="tile-btn pin-btn" title="Büyüt" data-target="${tileKey}">⛶</button>
      ${modBtns}
    </div>
  `;
}

function initVideoGridActions() {
  const grid = $('#video-grid');
  if (!grid || grid.dataset.actionsReady) return;
  grid.dataset.actionsReady = '1';

  grid.addEventListener('click', (e) => {
    const pinBtn = e.target.closest('.pin-btn');
    if (pinBtn) {
      e.preventDefault();
      e.stopPropagation();
      pinTile(pinBtn.dataset.target, { fromPinButton: true });
      return;
    }

    const muteBtn = e.target.closest('.mute-remote-btn');
    if (muteBtn) {
      e.stopPropagation();
      requestModerate(muteBtn.dataset.target, muteBtn.dataset.action || 'mute-mic');
      return;
    }

    const camBtn = e.target.closest('.cam-remote-btn');
    if (camBtn) {
      e.stopPropagation();
      requestModerate(camBtn.dataset.target, camBtn.dataset.action || 'mute-cam');
      return;
    }

    const miniTile = e.target.closest('.video-tile.mini');
    if (miniTile && !e.target.closest('.tile-btn')) {
      pinTile(getTileKey(miniTile), { forcePin: true });
    }
  });
}

function pinTile(tileKey, { fromPinButton = false, forcePin = false } = {}) {
  if (!tileKey) return;

  if (forcePin) {
    state.pinnedTileId = tileKey;
  } else if (fromPinButton && state.pinnedTileId === tileKey) {
    state.pinnedTileId = null;
  } else {
    state.pinnedTileId = tileKey;
  }

  applyVideoLayout();
}

function updatePinButtons() {
  document.querySelectorAll('.video-tile .pin-btn').forEach((btn) => {
    const key = btn.dataset.target;
    const isPinned = state.pinnedTileId === key;
    btn.classList.toggle('active-pin', isPinned);
    btn.title = isPinned ? 'Küçült' : 'Büyüt';
    btn.textContent = isPinned ? '⊟' : '⛶';
  });
}

function applyVideoLayout() {
  const grid = $('#video-grid');
  if (!grid) return;

  const sidebar = grid.querySelector('.mini-sidebar');
  if (sidebar) {
    [...sidebar.querySelectorAll('.video-tile')].forEach((t) => grid.insertBefore(t, sidebar));
    sidebar.remove();
  }
  const orphanedPinned = grid.querySelector('.video-tile.pinned');
  if (orphanedPinned) {
    grid.appendChild(orphanedPinned);
  }

  const tiles = [...grid.querySelectorAll('.video-tile')];
  const count = tiles.length;

  grid.classList.remove('count-1', 'count-2', 'count-many', 'spotlight-mode');
  tiles.forEach((t) => {
    t.classList.remove('pinned', 'mini');
  });

  if (count === 1) grid.classList.add('count-1');
  else if (count === 2) grid.classList.add('count-2');
  else if (count > 2) grid.classList.add('count-many');

  if (state.pinnedTileId && count > 1) {
    const pinnedTile = tiles.find((t) => getTileKey(t) === state.pinnedTileId);
    if (!pinnedTile) {
      state.pinnedTileId = null;
    } else {
      grid.classList.add('spotlight-mode');
      const sidebarEl = document.createElement('div');
      sidebarEl.className = 'mini-sidebar';

      const pinnedTileEl = tiles.find((t) => getTileKey(t) === state.pinnedTileId);
      tiles.forEach((t) => {
        if (t !== pinnedTileEl) {
          t.classList.add('mini');
          sidebarEl.appendChild(t);
        }
      });

      if (pinnedTileEl) {
        pinnedTileEl.classList.add('pinned');
      }

      grid.appendChild(sidebarEl);
      if (pinnedTileEl) {
        grid.appendChild(pinnedTileEl);
      }
    }
  }

  updatePinButtons();
}

const MODERATE_LABELS = {
  'mute-mic': 'mikrofon kapatma',
  'unmute-mic': 'mikrofon açma',
  'mute-cam': 'kamera kapatma',
  'unmute-cam': 'kamera açma',
};

function requestModerate(targetId, action) {
  if (!state.socket || !targetId || !action) return;
  const peer = state.peers.get(targetId);
  const name = peer?.remoteName || 'Katılımcı';
  state.socket.emit('moderate-media', { targetId, action });
  showToast(`${name} için ${MODERATE_LABELS[action] || 'medya'} isteği gönderildi`);

  const tile = document.getElementById(`tile-${targetId}`);
  if (!tile) return;

  const micBtn = tile.querySelector('.mute-remote-btn');
  const camBtn = tile.querySelector('.cam-remote-btn');

  if (action === 'mute-mic' && micBtn) {
    micBtn.dataset.action = 'unmute-mic';
    micBtn.textContent = '🎤';
    micBtn.title = 'Mikrofonu aç';
    micBtn.classList.remove('mod-active');
    micBtn.classList.add('mod-muted');
  } else if (action === 'unmute-mic' && micBtn) {
    micBtn.dataset.action = 'mute-mic';
    micBtn.textContent = '🔇';
    micBtn.title = 'Mikrofonu kapat';
    micBtn.classList.add('mod-active');
    micBtn.classList.remove('mod-muted');
  } else if (action === 'mute-cam' && camBtn) {
    camBtn.dataset.action = 'unmute-cam';
    camBtn.textContent = '🚫';
    camBtn.title = 'Kamerayı aç';
    camBtn.classList.remove('mod-active');
    camBtn.classList.add('mod-muted');
  } else if (action === 'unmute-cam' && camBtn) {
    camBtn.dataset.action = 'mute-cam';
    camBtn.textContent = '📷';
    camBtn.title = 'Kamerayı kapat';
    camBtn.classList.add('mod-active');
    camBtn.classList.remove('mod-muted');
  }
}

function handleModerateMedia({ fromName, action }) {
  if (action === 'mute-mic') {
    setMicEnabled(false);
    showToast(`${fromName} mikrofonunuzu kapattı`);
  } else if (action === 'unmute-mic') {
    setMicEnabled(true);
    showToast(`${fromName} mikrofonunuzu açtı`);
  } else if (action === 'mute-cam' && !state.screenSharing) {
    setCamEnabled(false);
    showToast(`${fromName} kameranızı kapattı`);
  } else if (action === 'unmute-cam' && !state.screenSharing) {
    setCamEnabled(true);
    showToast(`${fromName} kameranızı açtı`);
  }
}

function isRemoteTrackLive(track) {
  return Boolean(track && track.readyState === 'live' && track.enabled && !track.muted);
}

function updateRemoteModerationButtons(remoteId, stream) {
  const tile = document.getElementById(`tile-${remoteId}`);
  if (!tile || !stream) return;

  const micBtn = tile.querySelector('.mute-remote-btn');
  const camBtn = tile.querySelector('.cam-remote-btn');
  const audioTrack = stream.getAudioTracks()[0];
  const videoTrack = stream.getVideoTracks()[0];
  const micOn = isRemoteTrackLive(audioTrack);
  const camOn = isRemoteTrackLive(videoTrack);

  if (micBtn) {
    micBtn.dataset.action = micOn ? 'mute-mic' : 'unmute-mic';
    micBtn.textContent = micOn ? '🔇' : '🎤';
    micBtn.title = micOn ? 'Mikrofonu kapat' : 'Mikrofonu aç';
    micBtn.classList.toggle('mod-active', micOn);
    micBtn.classList.toggle('mod-muted', !micOn);
  }

  if (camBtn) {
    camBtn.dataset.action = camOn ? 'mute-cam' : 'unmute-cam';
    camBtn.textContent = camOn ? '📷' : '🚫';
    camBtn.title = camOn ? 'Kamerayı kapat' : 'Kamerayı aç';
    camBtn.classList.toggle('mod-active', camOn);
    camBtn.classList.toggle('mod-muted', !camOn);
  }
}

function bindRemoteStreamModerationListeners(remoteId, stream) {
  if (!stream || stream._moderationBound) return;
  stream._moderationBound = true;

  const refresh = () => updateRemoteModerationButtons(remoteId, stream);

  stream.getTracks().forEach((track) => {
    track.addEventListener('mute', refresh);
    track.addEventListener('unmute', refresh);
    track.addEventListener('ended', refresh);
  });

  refresh();
}

function playVideo(video) {
  video.play().catch((err) => {
    console.warn('Video oynatilamadi:', err);
  });
}

function addLocalVideo() {
  const grid = $('#video-grid');
  initVideoGridActions();
  const tile = document.createElement('div');
  tile.className = 'video-tile local';
  tile.id = 'tile-local';
  tile.innerHTML = buildTileInnerHtml(state.userName, true, 'local');
  const video = tile.querySelector('video');
  video.srcObject = state.localStream;
  playVideo(video);
  grid.appendChild(tile);
  applyVideoLayout();
}

function updateLocalVideo() {
  const video = document.querySelector('#tile-local video');
  if (video) {
    video.srcObject = state.localStream;
    playVideo(video);
  }
}

function updateRemoteVideo(remoteId, stream, name) {
  let tile = document.getElementById(`tile-${remoteId}`);
  const grid = $('#video-grid');
  const isNewTile = !tile;

  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${remoteId}`;
    tile.innerHTML = buildTileInnerHtml(name, false, remoteId);
    grid.appendChild(tile);
  }

  const video = tile.querySelector('video');
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    playVideo(video);
  }

  tile.querySelector('.tile-label').textContent = name;

  const hasVideo = stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  tile.classList.toggle('no-video', !hasVideo);

  if (!hasVideo) {
    let avatar = tile.querySelector('.avatar');
    if (!avatar) {
      avatar = document.createElement('div');
      avatar.className = 'avatar';
      tile.appendChild(avatar);
    }
    avatar.textContent = getInitials(name);
  } else {
    tile.querySelector('.avatar')?.remove();
  }

  bindRemoteStreamModerationListeners(remoteId, stream);
  updateRemoteModerationButtons(remoteId, stream);

  if (isNewTile) {
    applyVideoLayout();
  }
  updateParticipantCount();
}

async function replaceVideoTrackOnPeers(track) {
  for (const peer of state.peers.values()) {
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(track);
    }
  }
}

function removePeer(remoteId) {
  if (!remoteId) return;

  const peer = state.peers.get(remoteId);
  if (peer) {
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    state.peers.delete(remoteId);
  }

  document.getElementById(`tile-${remoteId}`)?.remove();

  if (state.pinnedTileId === remoteId || state.pinnedTileId === String(remoteId)) {
    state.pinnedTileId = null;
  }

  applyVideoLayout();
  updateParticipantCount();
}

function updateParticipantCount() {
  const count = state.peers.size + 1;
  $('#participant-count').textContent = `${count} katılımcı`;
}

function cleanupRoom() {
  state.peers.forEach((peer) => peer.pc.close());
  state.peers.clear();

  [state.localStream, state.cameraStream, state.screenStream].forEach((stream) => {
    stream?.getTracks().forEach((t) => t.stop());
  });

  state.localStream = null;
  state.cameraStream = null;
  state.screenStream = null;
  state.screenSharing = false;

  if (state.socket) {
    state.socket.emit('leave-room');
    state.socket.disconnect();
    state.socket = null;
  }

  $('#video-grid').innerHTML = '';
  $('#toggle-screen').classList.remove('active');
  state.roomId = null;
  state.socketId = null;
  state.pinnedTileId = null;
  state.micEnabled = true;
  state.camEnabled = true;
  syncMediaControlUi();
}

async function joinRoom() {
  const userName = $('#user-name').value.trim();
  const roomId = state.selectedRoom;

  if (!userName || !roomId) return;

  if (state.socket) {
    cleanupRoom();
  }

  const mediaOk = await getLocalMedia();
  if (!mediaOk) return;

  state.userName = userName;
  state.roomId = roomId;
  state.micEnabled = true;
  state.camEnabled = true;

  state.socket = io({ transports: ['websocket', 'polling'] });

  state.socket.on('session-replaced', () => {
    showToast('Başka bir sekmeden odaya girildi');
    cleanupRoom();
    showScreen('lobby');
    loadRooms();
  });

  state.socket.on('user-joined', async ({ socketId, userName: name }) => {
    if (state.peers.has(socketId) || document.getElementById(`tile-${socketId}`)) {
      removePeer(socketId);
    }
    showToast(`${name} odaya katıldı`);
    await createOffer(socketId, name);
  });

  state.socket.on('user-left', ({ socketId }) => {
    removePeer(socketId);
  });

  state.socket.on('signal', async ({ from, signal, userName: name }) => {
    await handleSignal(from, signal, name);
  });

  state.socket.on('moderate-media', (payload) => {
    handleModerateMedia(payload);
  });

  state.socket.emit('join-room', { roomId, userName, clientId: getClientId() }, async (response) => {
    if (!response?.ok) {
      showToast(response?.error || 'Odaya katılılamadı');
      cleanupRoom();
      return;
    }

    state.socketId = response.socketId;

    $('#room-title').textContent = response.roomName || state.selectedRoomName || roomId;
    showScreen('room');
    addLocalVideo();
    syncMediaControlUi();
    updateParticipantCount();

    for (const peer of response.peers) {
      await createOffer(peer.socketId, peer.userName);
    }
  });
}

function toggleMic() {
  setMicEnabled(!state.micEnabled);
}

function toggleCam() {
  if (state.screenSharing) {
    showToast('Ekran paylaşımı sırasında kamera kapalı kalır.');
    return;
  }

  setCamEnabled(!state.camEnabled);
}

async function toggleScreenShare() {
  const btn = $('#toggle-screen');

  if (state.screenSharing) {
    await stopScreenShare();
    btn.classList.remove('active');
    return;
  }

  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false,
    });

    const screenTrack = state.screenStream.getVideoTracks()[0];
    state.screenSharing = true;
    state.localStream = state.screenStream;

  if (state.cameraStream) {
    state.cameraStream.getVideoTracks().forEach((t) => {
      t.enabled = false;
    });
  }

    await replaceVideoTrackOnPeers(screenTrack);
    updateLocalVideo();

    const localTile = $('#tile-local');
    localTile?.classList.add('screen-share');
    localTile?.classList.remove('no-video');
    localTile?.querySelector('.avatar')?.remove();
    const screenLabel = localTile?.querySelector('.tile-label');
    if (screenLabel) screenLabel.textContent = `${state.userName} (Ekran)`;

    btn.classList.add('active');
    showToast('Ekran paylaşımı başladı');

    screenTrack.onended = () => {
      stopScreenShare();
    };
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error(err);
      showToast('Ekran paylaşımı başlatılamadı.');
    }
  }
}

async function stopScreenShare() {
  if (!state.screenSharing) return;

  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  state.screenSharing = false;

  state.localStream = state.cameraStream;

  if (state.cameraStream) {
    state.cameraStream.getVideoTracks().forEach((t) => {
      t.enabled = state.camEnabled;
    });
  }

  const cameraTrack = getActiveVideoTrack();
  await replaceVideoTrackOnPeers(cameraTrack);
  updateLocalVideo();

  const localTile = $('#tile-local');
  if (localTile) {
    localTile.classList.remove('screen-share');
    localTile.querySelector('.tile-label').textContent = `${state.userName} (Sen)`;
    localTile.classList.toggle('no-video', !state.camEnabled);
  }

  $('#toggle-screen').classList.remove('active');
  showToast('Ekran paylaşımı durduruldu');
}

function leaveRoom() {
  cleanupRoom();
  showScreen('lobby');
  loadRooms();
}

function bindUiEvents() {
  $('#user-name')?.addEventListener('input', updateJoinButton);
  $('#join-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom();
  });
  $('#toggle-mic')?.addEventListener('click', toggleMic);
  $('#toggle-cam')?.addEventListener('click', toggleCam);
  $('#toggle-screen')?.addEventListener('click', toggleScreenShare);
  $('#leave-btn')?.addEventListener('click', leaveRoom);
}

function initLobbySocket() {
  if (state.lobbySocket || typeof io === 'undefined') return;

  state.lobbySocket = io({ transports: ['websocket', 'polling'] });

  state.lobbySocket.on('rooms-changed', (rooms) => {
    if (!Array.isArray(rooms)) return;
    state.roomsCache = rooms;
    renderRoomList(rooms);
  });

  state.lobbySocket.on('connect', () => {
    loadRooms();
  });
}

async function initApp() {
  setSplashStatus('Odalar yükleniyor...');
  initRoomList();
  bindUiEvents();
  startKeepAlive();

  const serverRendered = document.querySelectorAll('#room-list .room-option').length;
  if (serverRendered) {
    state.roomsCache = getInitialRooms();
  } else {
    const initial = getInitialRooms();
    if (initial.length) {
      renderRoomList(initial);
    } else {
      const container = $('#room-list');
      if (container && !container.textContent.trim()) {
        container.innerHTML = '<p class="empty-msg">Odalar yükleniyor...</p>';
      }
    }
  }

  initLobbySocket();
  await loadRooms();
  await loadSettings();
  setInterval(loadRooms, 10000);
  hideSplash();
}

function boot() {
  initApp().catch((err) => {
    console.error('Uygulama baslatilamadi:', err);
    setSplashStatus('Bağlantı hatası. Sayfayı yenileyin.');
    const container = $('#room-list');
    if (container && !container.querySelector('.room-option')) {
      container.innerHTML = '<p class="empty-msg error">Odalar yuklenemedi. Sayfayi yenileyin.</p>';
    }
    hideSplash();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.addEventListener('beforeunload', () => {
  if (state.socket) {
    state.socket.emit('leave-room');
  }
});
