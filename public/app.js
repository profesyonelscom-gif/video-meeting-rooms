const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const state = {
  socket: null,
  localStream: null,
  peers: new Map(),
  roomId: null,
  userName: '',
  micEnabled: true,
  camEnabled: true,
  selectedRoom: null,
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

async function loadRooms() {
  const res = await fetch('/api/rooms');
  const rooms = await res.json();
  const container = $('#room-list');
  container.innerHTML = '';

  rooms.forEach((room) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'room-option';
    el.dataset.roomId = room.id;
    el.innerHTML = `
      <div class="room-name">${room.name}</div>
      <div class="room-count">${room.participants} katılımcı</div>
    `;
    el.addEventListener('click', () => selectRoom(room.id, el));
    container.appendChild(el);
  });
}

function selectRoom(roomId, el) {
  state.selectedRoom = roomId;
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
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return true;
  } catch (err) {
    showToast('Kamera/mikrofon erişimi reddedildi. İzin verin ve tekrar deneyin.');
    console.error(err);
    return false;
  }
}

function createPeerConnection(remoteId, remoteName, isInitiator) {
  if (state.peers.has(remoteId)) {
    return state.peers.get(remoteId).pc;
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);

  state.localStream.getTracks().forEach((track) => {
    pc.addTrack(track, state.localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit('signal', {
        to: remoteId,
        signal: { type: 'ice-candidate', candidate: event.candidate },
      });
    }
  };

  pc.ontrack = (event) => {
    const peer = state.peers.get(remoteId);
    if (!peer) return;

    if (!peer.remoteStream) {
      peer.remoteStream = new MediaStream();
    }
    peer.remoteStream.addTrack(event.track);
    updateRemoteVideo(remoteId, peer.remoteStream, remoteName);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removePeer(remoteId);
    }
  };

  state.peers.set(remoteId, { pc, remoteName, remoteStream: null });
  return pc;
}

async function createOffer(remoteId, remoteName) {
  const pc = createPeerConnection(remoteId, remoteName, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit('signal', {
    to: remoteId,
    signal: { type: 'offer', sdp: offer },
  });
}

async function handleSignal(from, signal, userName) {
  let peer = state.peers.get(from);

  if (signal.type === 'offer') {
    const pc = createPeerConnection(from, userName, false);
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('signal', {
      to: from,
      signal: { type: 'answer', sdp: answer },
    });
  } else if (signal.type === 'answer') {
    if (!peer) {
      createPeerConnection(from, userName, false);
      peer = state.peers.get(from);
    }
    if (peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    }
  } else if (signal.type === 'ice-candidate') {
    if (!peer) {
      createPeerConnection(from, userName, false);
      peer = state.peers.get(from);
    }
    if (signal.candidate) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
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
  tile.querySelector('video').srcObject = state.localStream;
  grid.appendChild(tile);
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
  video.srcObject = stream;

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

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  if (state.socket) {
    state.socket.emit('leave-room');
    state.socket.disconnect();
    state.socket = null;
  }

  $('#video-grid').innerHTML = '';
  state.roomId = null;
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

    const roomTitle = roomId.replace('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    $('#room-title').textContent = roomTitle;
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
  state.localStream?.getAudioTracks().forEach((t) => {
    t.enabled = state.micEnabled;
  });
  const btn = $('#toggle-mic');
  btn.classList.toggle('active', state.micEnabled);
  btn.classList.toggle('muted', !state.micEnabled);
}

function toggleCam() {
  state.camEnabled = !state.camEnabled;
  state.localStream?.getVideoTracks().forEach((t) => {
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
$('#leave-btn').addEventListener('click', leaveRoom);

loadRooms();
setInterval(loadRooms, 10000);

window.addEventListener('beforeunload', () => {
  if (state.socket) {
    state.socket.emit('leave-room');
  }
});
