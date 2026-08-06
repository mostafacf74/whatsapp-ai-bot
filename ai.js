let dailyUsed = 0;
let hourlyUsed = 0;
let hourStart = Date.now();
let lastReplyAt = 0;

export function resetCounters() {
  dailyUsed = 0;
  hourlyUsed = 0;
  hourStart = Date.now();
}

function refreshHour() {
  if (Date.now() - hourStart >= 3600_000) {
    hourlyUsed = 0;
    hourStart = Date.now();
  }
}

export function canReply(aiConfig) {
  refreshHour();
  const maxDay = Number(aiConfig.maxRepliesPerDay || 300);
  const maxHour = Number(aiConfig.maxRepliesPerHour || 50);
  if (dailyUsed >= maxDay || hourlyUsed >= maxHour) return false;
  const elapsed = Date.now() - lastReplyAt;
  return elapsed >= Number(aiConfig.minDelayMs || 1200);
}

export function beforeReply() {
  dailyUsed += 1;
  hourlyUsed += 1;
  lastReplyAt = Date.now();
}

export function usage() {
  refreshHour();
  return { dailyUsed, hourlyUsed };
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith('gsk_')) return 'groq';
  return 'gemini';
}

async function postWithRetry(url, headers, body) {
  const doPost = () =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  let res = await doPost();
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2500));
    res = await doPost();
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

function extractGeminiText(data) {
  const outParts = (data?.candidates?.[0]?.content?.parts || []).filter((p) => p.text);
  const text = outParts.map((p) => p.text).join('').trim();
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function geminiReply(aiConfig, userMessage, history) {
  const url = `${GEMINI_URL}${encodeURIComponent(aiConfig.model || 'gemini-flash-latest')}:generateContent?key=${encodeURIComponent(aiConfig.apiKey)}`;
  const parts = [
    { text: aiConfig.systemPrompt || 'You are a helpful assistant.' },
    ...(history || []).slice(-8).map((m) => ({ text: m })),
    { text: userMessage },
  ];
  const data = await postWithRetry(url, { 'Content-Type': 'application/json' }, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  });
  return extractGeminiText(data);
}

async function groqReply(aiConfig, userMessage, history) {
  const messages = [{ role: 'system', content: aiConfig.systemPrompt || 'You are a helpful assistant.' }];
  for (const line of history || []) {
    if (line.startsWith('مساعد:')) messages.push({ role: 'assistant', content: line.slice(6) });
    else messages.push({ role: 'user', content: line });
  }
  messages.push({ role: 'user', content: userMessage });
  const data = await postWithRetry(
    GROQ_URL,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${aiConfig.apiKey}` },
    { model: GROQ_MODEL, messages, max_tokens: 700 }
  );
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq returned empty response');
  return text;
}

export async function askAI(aiConfig, userMessage, history) {
  if (!aiConfig?.apiKey) {
    return { ok: false, error: 'AI_KEY_MISSING' };
  }
  try {
    const text = detectProvider(aiConfig.apiKey) === 'groq'
      ? await groqReply(aiConfig, userMessage, history)
      : await geminiReply(aiConfig, userMessage, history);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
