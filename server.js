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

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONTACTS_FILE = path.join(DATA_DIR, 'store', 'contacts.json');
const SESSIONS_META_FILE = path.join(DATA_DIR, 'store', 'sessions.json');

let logBuffer = [];
const MAX_LOG = 500;
const contacts = new Set();
const sessions = new Map();
const sessionNames = {}; // id -> اسم مخصص

try {
  fs.mkdirSync(path.join(DATA_DIR, 'store'), { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
} catch {}

try {
  const saved = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  if (Array.isArray(saved.contacts)) saved.contacts.forEach((c) => contacts.add(c));
} catch {}

try {
  const meta = JSON.parse(fs.readFileSync(SESSIONS_META_FILE, 'utf8'));
  if (meta && typeof meta.names === 'object') Object.assign(sessionNames, meta.names);
} catch {}

function saveSessionNames() {
  try {
    fs.writeFileSync(SESSIONS_META_FILE, JSON.stringify({ names: sessionNames }, null, 2), 'utf8');
  } catch {}
}

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

// ------------------------- الجلسات (كل رقم جلسة مستقلة) -------------------------

function makeSession(id, credsPath) {
  return {
    id,
    credsPath,
    sock: null,
    lastQr: null,
    pairCode: null,
    connected: false,
    pairingPhone: null,
    starting: false,
    restartTimer: null,
    history: new Map(),
  };
}

function sessionLabel(s) {
  const name = sessionNames[s.id]?.trim();
  if (name) return name;
  return s.pairingPhone || (s.id !== 'default' ? s.id : '');
}

function findSession(phoneOrId) {
  const q = String(phoneOrId || '').trim();
  if (!q) return null;
  for (const s of sessions.values()) {
    if (s.id === q || s.pairingPhone === q || s.id === q.replace(/[^0-9]/g, '')) return s;
  }
  return null;
}

function startSession(s) {
  if (s.starting) return;
  s.starting = true;
  const tag = sessionLabel(s) || s.id;
  logLine('info', `[${tag}] جارٍ تشغيل الاتصال...`);
  (async () => {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(s.credsPath);
      const { version } = await import('@whiskeysockets/baileys').then((m) => m.fetchLatestBaileysVersion()).catch(() => ({ version: undefined }));

      s.sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.windows('WhatsApp AI Bot'),
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        shouldIgnoreJid: (jid) => jid.endsWith('@broadcast'),
      });

      s.sock.ev.on('creds.update', saveCreds);

      s.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, pairingCode } = update;
        const lbl = sessionLabel(s) || s.id;

        if (pairingCode) {
          s.pairCode = pairingCode;
          s.lastQr = null;
          logLine('info', `[${lbl}] كود الربط: ${pairingCode}`);
        } else if (qr) {
          s.lastQr = qr;
          s.pairCode = null;
          logLine('debug', `[${lbl}] QR محدث`);
        }

        if (connection === 'open') {
          s.connected = true;
          s.pairingPhone = s.sock?.user?.id?.split(':')[0] || null;
          logLine('info', `[${sessionLabel(s) || s.id}] ✅ متصل بنجاح: ${sessionLabel(s) || 'unknown'}`);
          // إعادة تسمية الجلسة المؤقتة برقم الهاتف الفعلي (حتى تبقى بعد restart)
          const realPhone = s.pairingPhone;
          if (s.id !== 'default' && !/^\d+$/.test(s.id) && realPhone && s.credsPath !== path.join(SESSIONS_DIR, realPhone)) {
            try {
              const newDir = path.join(SESSIONS_DIR, realPhone);
              fs.mkdirSync(newDir, { recursive: true });
              fs.cpSync(s.credsPath, newDir, { recursive: true, force: true });
              fs.rmSync(s.credsPath, { recursive: true, force: true });
              sessions.delete(s.id);
              s.id = realPhone;
              s.credsPath = newDir;
              sessions.set(s.id, s);
              if (sessionNames[s.id] == null) sessionNames[s.id] = '';
              logLine('info', `تم تثبيت جلسة الرقم ${realPhone}`);
            } catch (err) {
              logLine('warn', `فشل تثبيت الجلسة: ${err.message}`);
            }
          }
        }

        if (connection === 'close') {
          s.connected = false;
          s.lastQr = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.data?.reason;
          if (statusCode === DisconnectReason.loggedOut || reason === DisconnectReason.loggedOut) {
            logLine('warn', `[${lbl}] تم تسجيل الخروج من الجهاز — سيتم حذف الجلسة.`);
            try { fs.rmSync(s.credsPath, { recursive: true, force: true }); } catch {}
            clearTimeout(s.restartTimer);
            s.restartTimer = setTimeout(() => startSession(s), 1000);
          } else {
            logLine('warn', `[${lbl}] انقطع الاتصال (${statusCode || 'unknown'}) — إعادة المحاولة...`);
            clearTimeout(s.restartTimer);
            s.restartTimer = setTimeout(() => startSession(s), 5000);
          }
        }
      });

      s.sock.ev.on('messages.upsert', (data) => {
        if (!data || !data.messages || data.type !== 'notify') return;
        for (const msg of data.messages) {
          handleMessage(msg, s).catch((err) => logLine('error', `خطأ في معالجة الرسالة: ${err.message}`));
        }
      });

      logLine('info', `[${tag}] جاهز. في انتظار ربط الهاتف...`);
    } catch (err) {
      logLine('error', `[${tag}] فشل التشغيل: ${err.message}`);
      s.restartTimer = setTimeout(() => startSession(s), 8000);
    } finally {
      s.starting = false;
    }
  })();
}

function bootSessions() {
  // الجلسة الأساسية القديمة (للتوافق مع ما سبق)
  const defaultPath = path.join(DATA_DIR, 'session');
  try { fs.mkdirSync(defaultPath, { recursive: true }); } catch {}
  const primary = makeSession('default', defaultPath);
  sessions.set('default', primary);
  startSession(primary);

  // أي جلسات إضافية موجودة على القرص
  let dirs = [];
  try { dirs = fs.readdirSync(SESSIONS_DIR).filter((d) => /^\d+$/.test(d)); } catch {}
  for (const d of dirs) {
    const dirPath = path.join(SESSIONS_DIR, d);
    if (!fs.existsSync(path.join(dirPath, 'creds.json'))) continue;
    const s = makeSession(d, dirPath);
    sessions.set(d, s);
    startSession(s);
  }
}

// ------------------------- منطق الرد -------------------------

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

async function handleMessage(msg, session) {
  const sock = session?.sock;
  if (!sock || !msg.message) return;
  if (msg.key?.fromMe) return;
  if (msg.key?.remoteJid?.endsWith('@broadcast')) return;
  if (msg.key?.remoteJid?.endsWith('@g.us') && !config.groupsEnabled) return;
  if (msg.key?.remoteJid?.endsWith('@newsletter')) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
  if (!text) return;
  logLine('debug', `[${sessionLabel(session) || session.id}] رسالة جديدة من ${jid}: ${text.slice(0, 60)}`);

  const from = isGroup ? msg.key.participant : jid;
  const contactName = (msg.pushName || 'العميل').split(' ')[0];

  const hKey = jid;
  const hist = session.history.get(hKey) || [];
  hist.push(`${contactName}: ${text}`);
  if (hist.length > 20) hist.splice(0, hist.length - 20);
  session.history.set(hKey, hist);

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
      } else {
        logLine('error', `فشل الرد الذكي (${aiText.error}) — رد احتياطي`);
        reply = config.ai?.fallbackReply || 'عذرًا على التأخير! الخدمة مشغولة حاليًا — جرب تسأل بعد دقيقة، أو اكتب ( قائمة ) لمشاهدة المنتجات. 😊';
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
    logLine('info', `[${sessionLabel(session) || session.id}] رد → ${jid}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);
  }

  if (!seenBefore) {
    contacts.add(jid);
    saveContacts();
  }
}

async function sendMessage(phone, text, sessionId) {
  let s = sessionId ? findSession(sessionId) : null;
  if (!s) {
    s = [...sessions.values()].find((x) => x.connected && x.pairingPhone === String(phone).replace(/[^0-9]/g, '')) || null;
  }
  if (!s) s = [...sessions.values()].find((x) => x.connected) || null;
  if (!s?.sock || !s.connected) return { ok: false, error: 'NOT_CONNECTED' };
  const jid = jidNormalizedUser(String(phone).replace(/[^0-9]/g, ''));
  await s.sock.sendMessage(jid, { text });
  return { ok: true };
}

// ------------------------- HTTP API -------------------------

const app = express();
app.use(express.json());

function sessionStatus(s) {
  return {
    id: s.id,
    name: sessionNames[s.id] || '',
    phone: s.pairingPhone || (s.id !== 'default' ? s.id : null),
    connected: s.connected,
    hasQr: !!s.lastQr,
    pairCode: s.pairCode,
    starting: s.starting,
  };
}

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp AI Bot</title><style>
body{font-family:Segoe UI,Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;margin:0;padding:24px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:22px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:8px}
.green{background:#22c55e}.amber{background:#f59e0b}.red{background:#ef4444}
p{color:#94a3b8;margin:6px 0}a{color:#38bdf8;text-decoration:none}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.tab{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:10px 16px;cursor:pointer;user-select:none}
.tab.active{background:#38bdf8;color:#0f172a;font-weight:bold}
.card{background:#1e293b;border-radius:16px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
img.qr{width:260px;height:260px;border-radius:8px;margin:12px auto;background:#fff;display:block}
input,button{font-size:15px;padding:10px 14px;border-radius:8px;border:0;margin:4px}
input{background:#0f172a;color:#e2e8f0;width:200px}
button{background:#38bdf8;color:#0f172a;font-weight:bold;cursor:pointer}
button.add{background:#22c55e;font-size:17px;padding:12px 24px}
button.danger{background:#ef4444}
</style></head><body><div class="wrap">
<h1>🤖 WhatsApp AI Bot — لوحة التحكم</h1>
<p>البوت شغال 24/7 — كل رقم في تبويب مستقل</p>
<button class="add" onclick="addNum()">➕ إضافة رقم جديد</button>
<div class="tabs" id="tabs"></div>
<div class="card" id="content">...جارٍ التحميل...</div>
<script>
var cur=null;
function label(s){return s.name?s.name:(s.phone||s.id);}
function render(list){
  var tabs=document.getElementById('tabs');tabs.innerHTML='';
  if(!list||!list.length){tabs.innerHTML='<div class="tab" style="cursor:default">لا توجد أرقام بعد — اضغط "إضافة رقم جديد"</div>';document.getElementById('content').innerHTML='';return;}
  if(cur==null||!list.some(function(x){return x.id===cur;}))cur=list[0].id;
  list.forEach(function(s){
    var cls=s.connected?'green':(s.hasQr?'amber':'red');
    var t=document.createElement('div');
    t.className='tab'+(s.id===cur?' active':'');
    t.innerHTML='<span class="dot '+cls+'"></span>'+label(s);
    t.onclick=function(){cur=s.id;render(list);};
    tabs.appendChild(t);
  });
  var s=list.find(function(x){return x.id===cur;});
  var content=document.getElementById('content');
  if(!s){content.innerHTML='';return;}
  var st=s.connected?'متصل ✓':(s.hasQr?'بانتظار ربط جهاز (QR)':'جارٍ الاتصال...');
  var cls=s.connected?'green':(s.hasQr?'amber':'red');
  var hint=s.id.startsWith('tmp_')?'':(s.id==='default'?'افتح واتساب → الأجهزة المرتبطة → ربط جهاز → سكّن الكود':'افتح واتساب على رقم '+s.id+' → الأجهزة المرتبطة → ربط جهاز → سكّن الكود');
  var html='<span class="dot '+cls+'"></span><b>'+label(s)+'</b> — '+st;
  if(s.pairCode)html+='<p style="color:#f59e0b;font-weight:bold">كود الربط: '+s.pairCode+'</p>';
  if(s.hasQr)html+='<img class="qr" src="/api/qr.png?phone='+encodeURIComponent(s.id)+'&t='+Date.now()+'"><p style="font-size:13px">'+hint+'</p>';
  html+='<div style="margin-top:14px"><input id="nm-'+s.id+'" placeholder="اسم مخصص (اختياري)" value="'+s.name+'"><button onclick="rename(\''+s.id+'\')">حفظ الاسم</button></div>';
  html+='<button class="danger" style="margin-top:10px" onclick="del(\''+s.id+'\')">🗑 حذف هذا الرقم</button>';
  content.innerHTML=html;
}
function refresh(){
  fetch('/api/status').then(r=>r.json()).then(j=>{
    if(j.sessions)render(j.sessions);
    else if(j.id)render([j]);
  }).catch(()=>{});
}
function addNum(){
  fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(r=>r.json()).then(j=>{
     if(j.ok){cur=j.id;refresh();}else{alert('خطأ: '+j.error);}
   }).catch(()=>{});
}
function rename(id){
  var v=document.getElementById('nm-'+id).value.trim();
  fetch('/api/session-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:id,name:v})})
   .then(r=>r.json()).then(()=>refresh()).catch(()=>{});
}
function del(id){
  if(!confirm('حذف هذا الرقم؟ سيتم قطع الاتصال نهائيًا'))return;
  fetch('/api/unpair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:id})})
   .then(r=>r.json()).then(()=>{cur=null;refresh();}).catch(()=>{});
}
refresh();setInterval(refresh,3000);
</script></div></body></html>`);
});

function checkAuth(req, res, next) {
  const token = config.token;
  if (token && req.get('x-token') !== token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  next();
}

app.get('/api/status', (req, res) => {
  const list = [...sessions.values()];
  const reqPhone = req.query.phone;
  const target = reqPhone ? findSession(reqPhone) : null;
  if (reqPhone && !target) return res.status(404).json({ ok: false, error: 'SESSION_NOT_FOUND' });
  const base = {
    ok: true,
    botVersion: '1.0.0',
    aiKeyConfigured: !!(config.ai?.apiKey),
    volume: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    persistent: DATA_DIR !== __dirname,
  };
  if (target) return res.json({ ...base, ...sessionStatus(target) });
  const connectedOne = list.find((s) => s.connected);
  const qrOne = list.find((s) => s.lastQr);
  res.json({
    ...base,
    sessions: list.map(sessionStatus),
    connected: list.some((s) => s.connected),
    pairingPhone: connectedOne?.pairingPhone || null,
    hasQr: !!qrOne,
    pairCode: qrOne?.pairCode || null,
  });
});

app.get('/api/qr', (req, res) => {
  const s = req.query.phone ? findSession(req.query.phone) : ([...sessions.values()].find((x) => x.lastQr) || sessions.get('default'));
  if (!s?.lastQr) return res.status(404).json({ ok: false, error: 'NO_QR' });
  res.json({ ok: true, qr: s.lastQr });
});

app.get('/api/qr.png', async (req, res) => {
  const s = req.query.phone ? findSession(req.query.phone) : ([...sessions.values()].find((x) => x.lastQr) || sessions.get('default'));
  if (!s?.lastQr) return res.status(404).json({ ok: false, error: 'NO_QR' });
  const png = await QRCode.toBuffer(s.lastQr, { width: 512, margin: 2 });
  res.type('png').send(png);
});

app.post('/api/pair', checkAuth, (req, res) => {
  const rawPhone = String(req.body?.phone || '').replace(/[^0-9]/g, '');
  if (rawPhone) {
    if (!/^[0-9]{6,15}$/.test(rawPhone)) return res.status(400).json({ ok: false, error: 'BAD_PHONE' });
    const existing = findSession(rawPhone);
    if (existing) return res.json({ ok: true, already: true, id: existing.id });
    const dirPath = path.join(SESSIONS_DIR, rawPhone);
    try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
    const s = makeSession(rawPhone, dirPath);
    sessions.set(rawPhone, s);
    startSession(s);
    logLine('info', `تمت إضافة رقم جديد: ${rawPhone}`);
    return res.json({ ok: true, id: rawPhone });
  }
  // بدون رقم: جلسة مؤقتة — الـ QR يظهر فورًا ويُثبَّت برقم الهاتف عند الربط
  const tmpId = 'tmp_' + Date.now();
  const tmpDir = path.join(DATA_DIR, 'tmp', tmpId);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const s = makeSession(tmpId, tmpDir);
  sessions.set(tmpId, s);
  startSession(s);
  logLine('info', 'فتح ربط جديد (جلسة مؤقتة)');
  res.json({ ok: true, id: tmpId, tmp: true });
});

app.post('/api/unpair', checkAuth, (req, res) => {
  const key = String(req.body?.phone || req.body?.id || '').trim();
  const s = findSession(key);
  if (!s) return res.status(404).json({ ok: false, error: 'SESSION_NOT_FOUND' });
  if (s.id === 'default') return res.status(400).json({ ok: false, error: 'CANNOT_DELETE_DEFAULT' });
  clearTimeout(s.restartTimer);
  try { s.sock?.end(new Error('unpair requested')); } catch {}
  try { fs.rmSync(s.credsPath, { recursive: true, force: true }); } catch {}
  sessions.delete(s.id);
  logLine('info', `تم حذف الجلسة: ${key}`);
  res.json({ ok: true });
});

app.post('/api/session-name', checkAuth, (req, res) => {
  const key = String(req.body?.phone || '').trim();
  const s = findSession(key);
  if (!s) return res.status(404).json({ ok: false, error: 'SESSION_NOT_FOUND' });
  const name = String(req.body?.name || '').trim().slice(0, 50);
  if (name) sessionNames[s.id] = name;
  else delete sessionNames[s.id];
  saveSessionNames();
  logLine('info', `تم تسمية الجلسة ${s.id}: ${name || '(بدون اسم)'}`);
  res.json({ ok: true });
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
  const { to, text, phone } = req.body || {};
  if (!to || !text) return res.status(400).json({ ok: false, error: 'BAD_BODY' });
  sendMessage(String(to), String(text), phone)
    .then((r) => res.json(r))
    .catch((err) => res.json({ ok: false, error: err.message }));
});

app.post('/api/restart', checkAuth, (req, res) => {
  res.json({ ok: true, message: 'restarting' });
  setTimeout(() => process.exit(0), 300);
});

const PORT = Number(process.env.PORT || config.port || 3000);
function normalizeHost(raw) {
  const h = String(raw || '0.0.0.0').trim();
  if (h === '::' || h === '[::]' || h.includes('::')) return '0.0.0.0';
  return h;
}
function startListening() {
  const host = normalizeHost(process.env.HOST);
  const server = app.listen(PORT, host, () => {
    logLine('info', `لوحة API شغالة على ${host}:${PORT}`);
    bootSessions();
  });
  server.on('error', (err) => {
    logLine('error', `فشل فتح المنفذ على ${host} (${err.message}) — إعادة المحاولة على 0.0.0.0`);
    try { server.close(); } catch {}
    setTimeout(() => app.listen(PORT, '0.0.0.0', () => {
      logLine('info', `لوحة API شغالة على 0.0.0.0:${PORT}`);
      bootSessions();
    }), 500);
  });
}
startListening();
