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

async function geminiReply(aiConfig, userMessage, history) {
  const url = `${GEMINI_URL}${encodeURIComponent(aiConfig.model || 'gemini-flash-latest')}:generateContent?key=${encodeURIComponent(aiConfig.apiKey)}`;
  const parts = [
    { text: aiConfig.systemPrompt || 'You are a helpful assistant.' },
    ...history.slice(-8).map((m) => ({ text: m })),
    { text: userMessage },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2500));
    const retry = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!retry.ok) {
      const errText = await retry.text();
      throw new Error(`Gemini HTTP ${retry.status}: ${errText.slice(0, 200)}`);
    }
    return extractText(await retry.json());
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return extractText(await res.json());
}

function extractText(data) {
  const outParts = (data?.candidates?.[0]?.content?.parts || []).filter((p) => p.text);
  const text = outParts.map((p) => p.text).join('').trim();
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

export async function askAI(aiConfig, userMessage, history) {
  if (!aiConfig?.apiKey) {
    return { ok: false, error: 'AI_KEY_MISSING' };
  }
  try {
    const text = await geminiReply(aiConfig, userMessage, history);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
