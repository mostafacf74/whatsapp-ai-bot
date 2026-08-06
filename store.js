import fs from 'node:fs';
import path from 'node:path';

const SHIPPED_PATH = path.join(import.meta.dirname, 'config.json');
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || import.meta.dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    try {
      const shipped = JSON.parse(fs.readFileSync(SHIPPED_PATH, 'utf8'));
      if (DATA_DIR !== import.meta.dirname) {
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(shipped, null, 2), 'utf8');
        } catch {}
      }
      return shipped;
    } catch {
      return {};
    }
  }
}

export function saveConfig(config) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function safeGet(obj, keys, fallback) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return fallback;
    cur = cur[k];
  }
  return cur === undefined || cur === null || cur === '' ? fallback : cur;
}
