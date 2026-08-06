import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.join(import.meta.dirname, 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
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
