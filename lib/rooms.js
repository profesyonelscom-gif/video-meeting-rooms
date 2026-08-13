const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const DEFAULT_ROOMS = [
  { id: 'oda-1', name: 'Genel Toplantı' },
  { id: 'oda-2', name: 'Proje Odası' },
  { id: 'oda-3', name: 'Eğitim Odası' },
  { id: 'oda-4', name: 'Destek Odası' },
];

let roomsCache = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ROOMS_FILE)) {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(DEFAULT_ROOMS, null, 2), 'utf8');
  }
}

function readFromDisk() {
  ensureDataFile();
  try {
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    return Array.isArray(data) && data.length ? data : [...DEFAULT_ROOMS];
  } catch {
    return [...DEFAULT_ROOMS];
  }
}

function writeToDisk(rooms) {
  ensureDataFile();
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
  } catch (err) {
    console.error('Oda dosyasi yazilamadi:', err.message);
  }
}

function loadCache() {
  if (!roomsCache) {
    roomsCache = readFromDisk();
  }
  return roomsCache;
}

function saveCache(rooms) {
  roomsCache = rooms.map((r) => ({ id: r.id, name: r.name }));
  writeToDisk(roomsCache);
  return roomsCache;
}

function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return base || `oda-${Date.now()}`;
}

function uniqueId(name, rooms) {
  let id = slugify(name);
  let suffix = 1;
  const ids = new Set(rooms.map((r) => r.id));
  while (ids.has(id)) {
    id = `${slugify(name)}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function getAll() {
  return loadCache().map((r) => ({ ...r }));
}

function getIds() {
  return loadCache().map((r) => r.id);
}

function findById(id) {
  return loadCache().find((r) => r.id === id) || null;
}

function add(name) {
  const trimmed = (name || '').trim().slice(0, 64);
  if (!trimmed) {
    throw new Error('Oda adı gerekli');
  }

  const rooms = getAll();
  const room = { id: uniqueId(trimmed, rooms), name: trimmed };
  rooms.push(room);
  saveCache(rooms);
  return room;
}

function update(id, name) {
  const trimmed = (name || '').trim().slice(0, 64);
  if (!trimmed) {
    throw new Error('Oda adı gerekli');
  }

  const rooms = getAll();
  const index = rooms.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error('Oda bulunamadı');
  }

  rooms[index] = { ...rooms[index], name: trimmed };
  saveCache(rooms);
  return rooms[index];
}

function remove(id) {
  const rooms = getAll();
  const index = rooms.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error('Oda bulunamadı');
  }

  const [removed] = rooms.splice(index, 1);
  saveCache(rooms);
  return removed;
}

module.exports = {
  getAll,
  getIds,
  findById,
  add,
  update,
  remove,
};
