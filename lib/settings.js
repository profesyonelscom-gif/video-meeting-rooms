const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const ALLOWED_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function readSettings() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function findLogoFile() {
  ensureDirs();
  const files = fs.readdirSync(UPLOADS_DIR).filter((f) => f.startsWith('logo.'));
  return files[0] || null;
}

function getPublicSettings() {
  const settings = readSettings();
  const logoFile = findLogoFile();
  return {
    logoUrl: logoFile ? `/uploads/${logoFile}?v=${settings.logoVersion || 0}` : null,
  };
}

function saveLogo(buffer, mimeType) {
  const ext = ALLOWED_EXT[mimeType];
  if (!ext) {
    throw new Error('Desteklenmeyen format. PNG, JPG, WEBP, GIF veya SVG kullanın.');
  }

  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('Logo en fazla 2 MB olabilir');
  }

  ensureDirs();

  fs.readdirSync(UPLOADS_DIR)
    .filter((f) => f.startsWith('logo.'))
    .forEach((f) => fs.unlinkSync(path.join(UPLOADS_DIR, f)));

  const filename = `logo.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

  const settings = readSettings();
  settings.logoVersion = (settings.logoVersion || 0) + 1;
  writeSettings(settings);

  return `/uploads/${filename}?v=${settings.logoVersion}`;
}

function removeLogo() {
  ensureDirs();
  fs.readdirSync(UPLOADS_DIR)
    .filter((f) => f.startsWith('logo.'))
    .forEach((f) => fs.unlinkSync(path.join(UPLOADS_DIR, f)));

  const settings = readSettings();
  settings.logoVersion = (settings.logoVersion || 0) + 1;
  writeSettings(settings);
}

module.exports = {
  getPublicSettings,
  saveLogo,
  removeLogo,
};
