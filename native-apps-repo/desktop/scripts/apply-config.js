const fs = require('node:fs');
const path = require('node:path');

const cfgPath = path.join(__dirname, '..', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

if (process.env.INPUT_SERVER && process.env.INPUT_SERVER.trim()) {
  cfg.serverUrl = process.env.INPUT_SERVER.trim().replace(/\/+$/, '');
}
if (process.env.INPUT_ROOM && process.env.INPUT_ROOM.trim()) {
  const cleaned = process.env.INPUT_ROOM.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (cleaned.length >= 4) cfg.roomCode = cleaned;
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('Continuum Desktop build config:', cfg);
