import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// === OpenAI Realtime config ===
const OPENAI_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const VOICE = 'alloy';

// --- μ-law tone helpers (beep test for Twilio playback) ---
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
function generateBeepMuLawBase64(freq = 440, ms = 300) {
  const sr = 8000, n = Math.floor(sr * ms / 1000);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(2 * Math.PI * freq * (i / sr));
    const int16 = Math.max(-1, Math.min(1, s)) * 32767 | 0;
    out[i] = linearToMuLaw(int16);
  }
  return Buffer.from(out).toString('base64');
}

// Short, focused receptionist instructions
const SYSTEM_MESSAGE = `
You are a professional HVAC receptionist for {BusinessName} in {City, State}.
Tone: warm, concise, confident. Goal: answer calls 24/7, capture job details, and book an appointment.

ALWAYS collect: name, mobile, full address, problem summary, system brand/age, urgency, preferred 2-hour window.
No quotes. If emergency, escalate. Confirm details and say they’ll get a text confirmation.
`;

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('OK: server is running'));

// ---- Booking helper (Zapier hook – optional) ----
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
    start: '2025-08-12T14:00:00-05:00', end: '2025-08-12T16:00:00-05:00', notes: 'Prefer technician calls on arrival'
  };
  const result = await sendBooking(payload);
  res.json({ ok: true, forwarded_to_zapier: result });
});

app.get('/fake-book', async (_req, res) => {
  const payload = { name: 'Test Customer', phone: '+17010000000', address: '123 Main St, Fargo, ND',
    job: 'AC tune-up', start: '2025-08-12T10:00:00-05:00', end: '2025-08-12T12:00:00-05:00', notes: 'gate code 1234' };
  const result = await sendBooking(payload);
  res.send(`Triggered booking → ${JSON.stringify(result)}`);
});

// Twilio Voice webhook: start a **bidirectional** stream
app.post('/voice', (req, res) => {
  const host = req.get('host');
  const wssUrl = `wss://${host}/ws`;
  const twiml =
    `<Response>
       <Say>Connecting your call. One moment.</Say>
       <Connect><Stream url="${wssUrl}"/></Connect>
     </Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ---- WebSocket endpoint for Twilio Media Streams ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (twilioWs) => {
  console.log('>> Media Stream connected');

  // Log all messages FROM Twilio so we can verify bidi & streamSid
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'connected') console.log('Twilio evt:', data.event, data.protocol, data.version);
      if (data.event === 'start')      console.log('Twilio evt:start tracks=', data.start?.tracks, 'streamSid=', data.streamSid);
      if (data.event === 'media' && data.media?.track) console.log('Twilio evt:media track=', data.media.track, 'chunk=', data.media.chunk);
      if (data.event === 'mark')       console.log('Twilio evt:mark name=', data.mark?.name);

      // We handle stream start/media/stop below in a second handler
    } catch {}
  });

  console.log('>> Attempting OpenAI Realtime connection…');
  console.log('>> OPENAI key present:', !!process.env.OPENAI_API_KEY);

  // Connect to OpenAI Realtime
  const aiWs = new WebSocket(
    OPENAI_URL,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;

  aiWs.on('unexpected-response', (_req, res) => {
    console.error('!! OpenAI unexpected response status:', res.statusCode);
    try { res.on('data', (c) => console.error('!! OpenAI response body:', c.toString())); } catch {}
  });

  aiWs.on('open', () => {
    console.log('>> Connected to OpenAI Realtime');

    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',   // Twilio → OpenAI remains μ-law
output_audio_format: 'pcm16',      // OpenAI → us is now 24k PCM16
        modalities: ['audio', 'text'],
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        temperature: 0.6
      }
    }));

    // greet (explicit audio + text)
    setTimeout(() => {
      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          voice: VOICE,
          output_audio_format: 'pcm16',
          instructions: 'Hello! I am the HVAC receptionist bot. I can hear you. What’s your name?'
        }
      }));
    }, 200);
  });

  // Forward AI audio chunks back to Twilio; trigger replies after each utterance
  aiWs.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());
      const type = evt.type;

      if (type === 'error') {
  console.error('AI error detail:', JSON.stringify(evt, null, 2));
}

      if (!['response.audio.delta','response.output_audio.delta','rate_limits.updated'].includes(type)) {
        console.log('AI evt:', type);
      }

if (type === 'response.created' || type === 'response.done') {
  console.log('AI response envelope:', JSON.stringify(evt, null, 2));
}
      
    if (type === 'input_audio_buffer.committed') {
  aiWs.send(JSON.stringify({
    type: 'response.create',
    response: {
      modalities: ['audio', 'text'],
      voice: VOICE,
      output_audio_format: 'g711_ulaw',
      instructions: 'Speak your answer out loud to the caller.'
    }
  }));
}

      if ((type === 'response.audio.delta' || type === 'response.output_audio.delta') && evt.delta && streamSid) {
        // evt.delta is base64 PCM16 at 24kHz (mono, little-endian)
const pcm24k = Buffer.from(
  typeof evt.delta === 'string' ? evt.delta : Buffer.from(evt.delta).toString('base64'),
  'base64'
);

// Downsample 24k → 8k by simple decimation (take every 3rd sample)
// Then μ-law encode for Twilio
const samples = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length / 2);
const outLen = Math.floor(samples.length / 3);
const ulaw = new Uint8Array(outLen);
for (let i = 0, j = 0; j < outLen; i += 3, j++) {
  const s = samples[i]; // take every 3rd sample
  // μ-law encode (reuse your linearToMuLaw helper)
  ulaw[j] = linearToMuLaw(s);
}
const ulawB64 = Buffer.from(ulaw).toString('base64');

// Send to Twilio
twilioWs.send(JSON.stringify({
  event: 'media',
  streamSid,
  media: { payload: ulawB64 }
}));
console.log('>> sent AI audio chunk to Twilio (μ-law, 8k) len:', ulawB64.length);

// Optional: flush marker
twilioWs.send(JSON.stringify({
  event: 'mark',
  streamSid,
  mark: { name: `ai-${Date.now()}` }
}));


  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', (code, reason) => console.log('>> OpenAI socket closed', code, reason?.toString?.() || ''));

  // Handle incoming Twilio media stream (caller audio) + send test beep
  twilioWs.on('message', (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start': {
        streamSid = data.start.streamSid || data.streamSid || data.start.callSid;
        console.log('>> Stream started. SID:', streamSid);

        // Clear any buffered audio, then play a 300ms beep.
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        const beep = generateBeepMuLawBase64(440, 300);
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: beep, track: 'outbound' } }));
        twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `beep-${Date.now()}` } }));
        break;
      }

      case 'media': {
        if (aiWs.readyState === WebSocket.OPEN && data.media?.payload) {
          aiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
        }
        break;
      }

      case 'stop': {
        console.log('>> Stream stopped');
        try { aiWs.close(); } catch {}
        break;
      }

      default: break;
    }
  });

  twilioWs.on('close', () => { console.log('>> Media Stream closed'); try { aiWs.close(); } catch {} });
  twilioWs.on('error', (e) => console.error('Twilio WS error:', e));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
