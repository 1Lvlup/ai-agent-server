import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// ================== Config ==================
const OPENAI_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const VOICE = 'alloy';

// ================== μ-law helpers + beep ==================
function linearToMuLaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = sample, sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}
function generateBeepMuLawBase64(freq = 440, ms = 250) {
  const sr = 8000, n = Math.floor(sr * ms / 1000);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(2 * Math.PI * freq * (i / sr));
    const int16 = Math.max(-1, Math.min(1, s)) * 32767 | 0;
    out[i] = linearToMuLaw(int16);
  }
  return Buffer.from(out).toString('base64');
}

// ================== System prompt ==================
const SYSTEM_MESSAGE = `
You are a professional HVAC receptionist for {BusinessName} in {City, State}.
Tone: warm, concise, confident. Goal: answer calls 24/7, capture job details, and book an appointment.
Always collect: name, mobile, full address, problem summary, system brand/age, urgency, preferred 2-hour window.
No quotes. If emergency, escalate. Confirm details and say they’ll get a text confirmation.
`;

// For consistent response payloads
const REPLY_SHAPE = {
  modalities: ['audio', 'text'],
  voice: VOICE,
  output_audio_format: 'pcm16'
};

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('OK: server is running'));

// ---- (Optional) Booking helper via Zapier ----
async function sendBooking(payload) {
  const url = process.env.ZAPIER_HOOK_URL;
  if (!url) { console.log('No ZAPIER_HOOK_URL set; skipping.'); return { ok: false, reason: 'missing Zap URL' }; }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ok: r.ok, status: r.status };
}
app.post('/fake-book', async (req, res) => {
  const payload = Object.keys(req.body || {}).length ? req.body : {
    name: 'Test Customer', phone: '+17010000000', address: '123 Main St, Fargo, ND',
    job: 'AC not cooling; unit freezing',
    start: '2025-08-12T14:00:00-05:00', e
