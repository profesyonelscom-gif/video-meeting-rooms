const TOKEN_KEY = 'adminToken';

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

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function adminFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    clearToken();
    showScreen('admin-login');
    throw new Error(data.error || 'Oturum süresi doldu');
  }

  if (!res.ok) {
    throw new Error(data.error || 'İşlem başarısız');
  }

  return data;
}

async function loadAdminRooms() {
  const container = $('#admin-room-list');
  container.innerHTML = '<p class="empty-msg">Yükleniyor...</p>';

  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) throw new Error('Odalar alınamadı');
    const rooms = await res.json();
    renderAdminRooms(rooms);
  } catch (err) {
    container.innerHTML = `<p class="empty-msg error">${err.message}</p>`;
  }
}

function renderAdminRooms(rooms) {
  const container = $('#admin-room-list');

  if (!rooms.length) {
    container.innerHTML = '<p class="empty-msg">Henüz oda yok. Yukarıdan yeni oda ekleyin.</p>';
    return;
  }

  container.innerHTML = '';

  rooms.forEach((room) => {
    const row = document.createElement('div');
    row.className = 'admin-room-row';
    row.innerHTML = `
      <div class="admin-room-info">
        <input type="text" class="room-name-input" value="${escapeHtml(room.name)}" maxlength="64" data-id="${room.id}" />
        <span class="room-meta">${room.participants} katılımcı · ID: ${room.id}</span>
      </div>
      <div class="admin-room-actions">
        <button class="btn btn-secondary btn-sm save-room-btn" data-id="${room.id}">Kaydet</button>
        <button class="btn btn-danger btn-sm delete-room-btn" data-id="${room.id}" ${room.participants > 0 ? 'disabled title="Odada katılımcı var"' : ''}>Sil</button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.save-room-btn').forEach((btn) => {
    btn.addEventListener('click', () => saveRoom(btn.dataset.id));
  });

  container.querySelectorAll('.delete-room-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteRoom(btn.dataset.id));
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function saveRoom(id) {
  const input = document.querySelector(`.room-name-input[data-id="${id}"]`);
  const name = input?.value.trim();
  if (!name) {
    showToast('Oda adı boş olamaz');
    return;
  }

  try {
    await adminFetch(`/api/admin/rooms/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    showToast('Oda güncellendi');
    loadAdminRooms();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteRoom(id) {
  if (!confirm('Bu odayı silmek istediğinize emin misiniz?')) return;

  try {
    await adminFetch(`/api/admin/rooms/${id}`, { method: 'DELETE' });
    showToast('Oda silindi');
    loadAdminRooms();
  } catch (err) {
    showToast(err.message);
  }
}

function initAdminPanel() {
  showScreen('admin-panel');
  loadLogoSettings();
  loadAdminRooms();

  const socket = io({ transports: ['websocket', 'polling'] });
  socket.on('rooms-changed', renderAdminRooms);
}

function updateLogoPreview(logoUrl) {
  const preview = $('#admin-logo-preview');
  const placeholder = $('#admin-logo-placeholder');
  const removeBtn = $('#remove-logo-btn');

  if (logoUrl) {
    preview.src = logoUrl;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
  }
}

async function loadLogoSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    updateLogoPreview(data.logoUrl);
  } catch {
    updateLogoPreview(null);
  }
}

async function uploadLogo(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Sadece resim dosyası yükleyebilirsiniz');
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    showToast('Logo en fazla 2 MB olabilir');
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await adminFetch('/api/admin/logo', {
        method: 'POST',
        body: JSON.stringify({ data: reader.result }),
      });
      updateLogoPreview(data.logoUrl);
      showToast('Logo yüklendi');
    } catch (err) {
      showToast(err.message);
    }
  };
  reader.readAsDataURL(file);
}

async function removeLogo() {
  if (!confirm('Logoyu kaldırmak istediğinize emin misiniz?')) return;

  try {
    await adminFetch('/api/admin/logo', { method: 'DELETE' });
    updateLogoPreview(null);
    showToast('Logo kaldırıldı');
  } catch (err) {
    showToast(err.message);
  }
}

$('#logo-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) uploadLogo(file);
  e.target.value = '';
});

$('#remove-logo-btn').addEventListener('click', removeLogo);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#admin-password').value;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast(data.error || 'Giriş başarısız');
      return;
    }

    setToken(password);
    initAdminPanel();
  } catch {
    showToast('Giriş yapılamadı');
  }
});

$('#add-room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-room-name').value.trim();
  if (!name) return;

  try {
    await adminFetch('/api/admin/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    $('#new-room-name').value = '';
    showToast('Oda eklendi');
    loadAdminRooms();
  } catch (err) {
    showToast(err.message);
  }
});

$('#logout-btn').addEventListener('click', () => {
  clearToken();
  showScreen('admin-login');
  $('#admin-password').value = '';
});

if (getToken()) {
  initAdminPanel();
}
