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

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ROOMS_FILE)) {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(DEFAULT_ROOMS, null, 2), 'utf8');
  }
}

function readRooms() {
  ensureDataFile();
  try {
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    return Array.isArray(data) ? data : DEFAULT_ROOMS;
  } catch {
    return [...DEFAULT_ROOMS];
  }
}

function writeRooms(rooms) {
  ensureDataFile();
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
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
  return readRooms();
}

function getIds() {
  return readRooms().map((r) => r.id);
}

function findById(id) {
  return readRooms().find((r) => r.id === id) || null;
}

function add(name) {
  const trimmed = (name || '').trim().slice(0, 64);
  if (!trimmed) {
    throw new Error('Oda adı gerekli');
  }

  const rooms = readRooms();
  const room = { id: uniqueId(trimmed, rooms), name: trimmed };
  rooms.push(room);
  writeRooms(rooms);
  return room;
}

function update(id, name) {
  const trimmed = (name || '').trim().slice(0, 64);
  if (!trimmed) {
    throw new Error('Oda adı gerekli');
  }

  const rooms = readRooms();
  const index = rooms.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error('Oda bulunamadı');
  }

  rooms[index] = { ...rooms[index], name: trimmed };
  writeRooms(rooms);
  return rooms[index];
}

function remove(id) {
  const rooms = readRooms();
  const index = rooms.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error('Oda bulunamadı');
  }

  const [removed] = rooms.splice(index, 1);
  writeRooms(rooms);
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
