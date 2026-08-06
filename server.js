import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';
import { loadConfig, saveConfig, safeGet } from './store.js';
import { askAI, canReply, beforeReply, usage, resetCounters } from './ai.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const config = loadConfig();
if (process.env.GEMINI_API_KEY) {
  config.ai = { ...(config.ai || {}), apiKey: process.env.GEMINI_API_KEY };
}

let sock = null;
let lastQr = null;
let pairCode = null;
let connected = false;
let pairingPhone = null;
let restartTimer = null;
let starting = false;
let logBuffer = [];
const MAX_LOG = 500;
const contacts = new Set();
const CONTACTS_FILE = path.join(__dirname, 'store', 'contacts.json');
const history = new Map();
const CREDS_PATH = path.join(__dirname, 'session');

try {
  const saved = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  if (Array.isArray(saved.contacts)) saved.contacts.forEach((c) => contacts.add(c));
} catch {}

function saveContacts() {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify({ contacts: [...contacts] }, null, 2), 'utf8');
  } catch {}
}

function logLine(level, msg) {
  const line = { t: new Date().toISOString(), level, msg };
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG) logBuffer = logBuffer.slice(-MAX_LOG);
  if (level !== 'debug') console.log(`[${line.t}] ${level.toUpperCase()}: ${msg}`);
}

function setRestartTimer(ms) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(connect, ms);
}

async function connect() {
  if (starting) return;
  starting = true;
  logLine('info', 'جارٍ تشغيل البوت...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState(CREDS_PATH);
    const { version } = await import('@whiskeysockets/baileys').then((m) => m.fetchLatestBaileysVersion()).catch(() => ({ version: undefined }));

    sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.windows('WhatsApp AI Bot'),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => jid.endsWith('@broadcast'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, pairingCode } = update;

      if (pairingCode) {
        pairCode = pairingCode;
        lastQr = null;
        logLine('info', `كود الربط: ${pairingCode}`);
      } else if (qr) {
        lastQr = qr;
        pairCode = null;
        logLine('debug', 'QR محدث');
      }

      if (connection === 'open') {
        connected = true;
        pairingPhone = sock.user?.id?.split(':')[0] || null;
        logLine('info', `✅ متصل بنجاح: ${pairingPhone || 'unknown'}`);
      }

      if (connection === 'close') {
        connected = false;
        lastQr = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.data?.reason;
        if (statusCode === DisconnectReason.loggedOut || reason === DisconnectReason.loggedOut) {
          logLine('warn', 'تم تسجيل الخروج من الجهاز — سيتم حذف الجلسة.');
          try { fs.rmSync(CREDS_PATH, { recursive: true, force: true }); } catch {}
          setRestartTimer(1000);
        } else {
          logLine('warn', `انقطع الاتصال (${statusCode || 'unknown'}) — إعادة المحاولة...`);
          setRestartTimer(5000);
        }
      }
    });

    sock.ev.on('messages.upsert', (data) => {
      if (!data || !data.messages || data.type !== 'notify') return;
      for (const msg of data.messages) {
        handleMessage(msg).catch((err) => logLine('error', `خطأ في معالجة الرسالة: ${err.message}`));
      }
    });

    logLine('info', 'البوت يعمل. في انتظار ربط الهاتف...');
  } catch (err) {
    logLine('error', `فشل التشغيل: ${err.message}`);
    setRestartTimer(8000);
  } finally {
    starting = false;
  }
}

function buildCatalog() {
  const items = config.catalog || [];
  if (!items.length) return 'قائمة المنتجات:\n(لم تتم إضافة منتجات بعد — أضفها من لوحة التحكم)';
  const lines = items.map((it, i) => `📌 ${i + 1}) ${it.name} — ${it.price}\n    ${it.desc || ''}`.trim());
  return `🛍️ قائمة المنتجات:\n\n${lines.join('\n\n')}\n\nللطلب: اكتب "أريد المنتج رقم (1)" أو راسلنا مباشرة 😊`;
}

function matchKeywords(replies, text) {
  const t = text.toLowerCase();
  for (const rule of replies || []) {
    if (!rule || !rule.keywords || !rule.reply) continue;
    for (const kw of rule.keywords) {
      if (kw && t.includes(kw.toLowerCase())) return rule.reply;
    }
  }
  return null;
}

function matchesCatalogCommand(text, commands) {
  const t = text.trim().toLowerCase();
  return (commands || []).some((c) => t === c.toLowerCase());
}

async function handleMessage(msg) {
  if (!sock || !msg.message) return;
  if (msg.key?.fromMe) return;
  if (msg.key?.remoteJid?.endsWith('@broadcast')) return;
  if (msg.key?.remoteJid?.endsWith('@g.us') && !config.groupsEnabled) return;
  if (msg.key?.remoteJid?.endsWith('@newsletter')) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
  if (!text) return;

  const from = isGroup ? msg.key.participant : jid;
  const contactName = (msg.pushName || 'العميل').split(' ')[0];

  const hKey = jid;
  const hist = history.get(hKey) || [];
  hist.push(`${contactName}: ${text}`);
  if (hist.length > 20) hist.splice(0, hist.length - 20);
  history.set(hKey, hist);

  const seenBefore = contacts.has(jid);

  let reply = null;

  if (!seenBefore && config.greeting?.enabled && config.greeting?.firstMessage && !isGroup) {
    reply = config.greeting.firstMessage;
  } else if (matchesCatalogCommand(text, config.catalogCommands)) {
    reply = buildCatalog();
  } else {
    reply = matchKeywords(config.replies, text);
  }

  if (reply === null && config.ai?.enabled && !isGroup) {
    if (canReply(config.ai)) {
      beforeReply();
      const aiText = await askAI(config.ai, text, hist.slice(-6));
      if (aiText.ok) {
        reply = aiText.text;
        hist.push(`مساعد: ${aiText.text}`);
      }
    } else {
      reply = null;
      logLine('debug', 'تم تجاوز الرد الذكي (حد يومي/ساعي)');
    }
  }

  if (reply) {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const delay = Math.min(900, 400 + Math.floor(Math.random() * 500));
    await new Promise((r) => setTimeout(r, delay));
    await sock.sendMessage(jid, { text: reply }, { quoted: msg }).catch((err) => {
      logLine('error', `فشل الإرسال إلى ${jid}: ${err.message}`);
    });
    logLine('info', `رد → ${jid}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);
  }

  if (!seenBefore) {
    contacts.add(jid);
    saveContacts();
  }
}

async function sendMessage(phone, text) {
  if (!sock || !connected) return { ok: false, error: 'NOT_CONNECTED' };
  const jid = jidNormalizedUser(phone.replace(/[^0-9]/g, ''));
  await sock.sendMessage(jid, { text });
  return { ok: true };
}

// ------------------------- HTTP API -------------------------

const app = express();
app.use(express.json());

function checkAuth(req, res, next) {
  const token = config.token;
  if (token && req.get('x-token') !== token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  next();
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected,
    pairingPhone,
    hasQr: !!lastQr,
    pairCode,
    botVersion: '1.0.0',
    aiKeyConfigured: !!(config.ai?.apiKey),
  });
});

app.get('/api/qr', (req, res) => {
  if (!lastQr) return res.status(404).json({ ok: false, error: 'NO_QR' });
  res.json({ ok: true, qr: lastQr });
});

app.get('/api/qr.png', async (req, res) => {
  if (!lastQr) return res.status(404).json({ ok: false, error: 'NO_QR' });
  const png = await QRCode.toBuffer(lastQr, { width: 512, margin: 2 });
  res.type('png').send(png);
});

app.get('/api/logs', checkAuth, (req, res) => {
  res.json({ ok: true, logs: logBuffer.slice(-200) });
});

app.get('/api/usage', checkAuth, (req, res) => {
  res.json({ ok: true, usage: usage() });
});

app.get('/api/config', checkAuth, (req, res) => {
  const c = JSON.parse(JSON.stringify(config));
  if (c.ai) c.ai.apiKey = c.ai.apiKey ? '********' : '';
  res.json({ ok: true, config: c });
});

app.put('/api/config', checkAuth, (req, res) => {
  const incoming = req.body?.config;
  if (!incoming) return res.status(400).json({ ok: false, error: 'BAD_BODY' });
  const oldKey = config.ai?.apiKey || '';
  if (incoming.ai && incoming.ai.apiKey === '********') incoming.ai.apiKey = oldKey;
  const merged = {
    ...config,
    ...incoming,
    ai: { ...(config.ai || {}), ...(incoming.ai || {}) },
    greeting: { ...(config.greeting || {}), ...(incoming.greeting || {}) },
  };
  if (merged.ai.apiKey !== oldKey && merged.ai.apiKey) resetCounters();
  Object.assign(config, merged);
  saveConfig(config);
  logLine('info', 'تم تحديث الإعدادات من لوحة التحكم');
  res.json({ ok: true });
});

app.post('/api/send', checkAuth, (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ ok: false, error: 'BAD_BODY' });
  sendMessage(String(to), String(text))
    .then((r) => res.json(r))
    .catch((err) => res.json({ ok: false, error: err.message }));
});

app.post('/api/restart', checkAuth, (req, res) => {
  res.json({ ok: true, message: 'restarting' });
  setTimeout(() => process.exit(0), 300);
});

const PORT = Number(process.env.PORT || config.port || 3000);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  logLine('info', `لوحة API شغالة على ${HOST}:${PORT}`);
  connect();
});
