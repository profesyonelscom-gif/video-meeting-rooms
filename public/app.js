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

function shouldInitiate(localId, remoteId) {
  return localId < remoteId;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('/api/rooms', { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error('API hatasi');

    const rooms = await res.json();
    state.roomsCache = rooms;
    renderRoomList(rooms);
  } catch (err) {
    console.warn('Oda listesi guncellenemedi:', err.message);
    if (!state.roomsCache.length) {
      renderRoomList(getInitialRooms());
    }
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
  const name = $('#user-name').value.trim();
  $('#join-btn').disabled = !name || !state.selectedRoom;
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
  if (existing) return existing.pc;

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
    } else if (pc.connectionState === 'closed') {
      removePeer(remoteId);
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

function playVideo(video) {
  video.play().catch((err) => {
    console.warn('Video oynatilamadi:', err);
  });
}

function addLocalVideo() {
  const grid = $('#video-grid');
  const tile = document.createElement('div');
  tile.className = 'video-tile local';
  tile.id = 'tile-local';
  tile.innerHTML = `
    <video autoplay playsinline muted></video>
    <span class="tile-label">${state.userName} (Sen)</span>
    <div class="tile-status"></div>
  `;
  const video = tile.querySelector('video');
  video.srcObject = state.localStream;
  playVideo(video);
  grid.appendChild(tile);
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

  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${remoteId}`;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <span class="tile-label">${name}</span>
      <div class="tile-status"></div>
    `;
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
  const peer = state.peers.get(remoteId);
  if (peer) {
    peer.pc.close();
    state.peers.delete(remoteId);
  }
  document.getElementById(`tile-${remoteId}`)?.remove();
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
}

async function joinRoom() {
  const userName = $('#user-name').value.trim();
  const roomId = state.selectedRoom;

  if (!userName || !roomId) return;

  const mediaOk = await getLocalMedia();
  if (!mediaOk) return;

  state.userName = userName;
  state.roomId = roomId;

  state.socket = io({ transports: ['websocket', 'polling'] });

  state.socket.on('user-joined', async ({ socketId, userName: name }) => {
    showToast(`${name} odaya katıldı`);
    await createOffer(socketId, name);
  });

  state.socket.on('user-left', ({ socketId }) => {
    removePeer(socketId);
  });

  state.socket.on('signal', async ({ from, signal, userName: name }) => {
    await handleSignal(from, signal, name);
  });

  state.socket.emit('join-room', { roomId, userName }, async (response) => {
    if (!response?.ok) {
      showToast(response?.error || 'Odaya katılılamadı');
      cleanupRoom();
      return;
    }

    state.socketId = response.socketId;

    $('#room-title').textContent = response.roomName || state.selectedRoomName || roomId;
    showScreen('room');
    addLocalVideo();
    updateParticipantCount();

    for (const peer of response.peers) {
      await createOffer(peer.socketId, peer.userName);
    }
  });
}

function toggleMic() {
  state.micEnabled = !state.micEnabled;
  state.cameraStream?.getAudioTracks().forEach((t) => {
    t.enabled = state.micEnabled;
  });
  const btn = $('#toggle-mic');
  btn.classList.toggle('active', state.micEnabled);
  btn.classList.toggle('muted', !state.micEnabled);
}

function toggleCam() {
  if (state.screenSharing) {
    showToast('Ekran paylaşımı sırasında kamera kapalı kalır.');
    return;
  }

  state.camEnabled = !state.camEnabled;
  state.cameraStream?.getVideoTracks().forEach((t) => {
    t.enabled = state.camEnabled;
  });

  const btn = $('#toggle-cam');
  btn.classList.toggle('active', state.camEnabled);
  btn.classList.toggle('muted', !state.camEnabled);

  const localTile = $('#tile-local');
  if (localTile) {
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
    localTile?.querySelector('.tile-label').textContent = `${state.userName} (Ekran)`;

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

$('#user-name').addEventListener('input', updateJoinButton);
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom();
});
$('#toggle-mic').addEventListener('click', toggleMic);
$('#toggle-cam').addEventListener('click', toggleCam);
$('#toggle-screen').addEventListener('click', toggleScreenShare);
$('#leave-btn').addEventListener('click', leaveRoom);

function initLobbySocket() {
  if (state.lobbySocket || typeof io === 'undefined') return;

  state.lobbySocket = io({ transports: ['websocket', 'polling'] });
  state.lobbySocket.on('rooms-changed', (rooms) => {
    state.roomsCache = rooms;
    renderRoomList(rooms);
  });
}

initRoomList();
renderRoomList(getInitialRooms());
loadSettings();
loadRooms();
initLobbySocket();
setInterval(loadRooms, 15000);

window.addEventListener('beforeunload', () => {
  if (state.socket) {
    state.socket.emit('leave-room');
  }
});
