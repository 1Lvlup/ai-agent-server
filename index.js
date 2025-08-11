import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// ======================= GLOBAL CONFIG =======================
const OPENAI_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

// μ-law helpers (beep to prove outbound audio)
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

// ======================= CLIENT DIRECTORY =======================
// Add one entry per customer. Slug = unique short id used in URL.
const CLIENTS = {
  // Demo/default client uses your env vars so your current setup keeps working.
  demo: {
    name: process.env.BUSINESS_NAME || 'Your Demo HVAC',
    city: process.env.BUSINESS_CITY || 'Fargo, ND',
    voice: process.env.VOICE || 'alloy',
    zap: process.env.ZAPIER_HOOK_URL || null
  },

  // Example of a second client:
  // acmehvac: {
  //   name: 'Acme Heating & Air',
  //   city: 'Bismarck, ND',
  //   voice: 'onyx',
  //   zap: 'https://hooks.zapier.com/hooks/catch/123456/abcDEF/'
  // },
};

// Build the agent’s system prompt for a given client
function buildSystemMessage(c) {
  return `
You are a professional HVAC receptionist for ${c.name} in ${c.city}.
Tone: warm, concise, confident. Your mission: collect all required details and book an appointment.

ALWAYS collect, one item at a time:
1) Full name
2) Mobile number (repeat back to confirm)
3) Full service address (street, city, ZIP)
4) Problem summary (no cooling/heat, noise, leak, thermostat, breaker)
5) System brand and approx. age
6) Urgency: no cooling/heat, water present, gas smell = EMERGENCY
7) Preferred 2-hour time window

Stay on-topic:
- Be friendly but avoid small talk. If caller drifts: “Happy to help—first, may I get your full name?”
- Never quote prices; say the tech will diagnose and give a clear estimate.
- Confirm key details back to the caller succinctly.

When you have all fields, speak the confirmation AND emit ONE single line of text:
BOOKING:{"name":"...","phone":"...","address":"...","job":"...","start":"YYYY-MM-DDTHH:mm:ssZZ","end":"YYYY-MM-DDTHH:mm:ssZZ","notes":"...","emergency":true|false}
(Exactly one JSON line after BOOKING:, minified.)
`;}

// ======================= EXPRESS APP =======================
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('OK: server is running'));

// Send booking to a specific Zap URL
async function sendBooking(payload, zapUrl) {
  if (!zapUrl) { console.log('No Zap URL configured for this client; skipping.'); return { ok: false, reason: 'missing Zap URL' }; }
  const r = await fetch(zapUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ok: r.ok, status: r.status };
}

// ---- Test endpoints (manual trigger) ----
app.post('/fake-book/:slug', async (req, res) => {
  const c = CLIENTS[req.params.slug] || CLIENTS.demo;
  const payload = Object.keys(req.body || {}).length ? req.body : {
    name: 'Test Customer', phone: '+17010000000',
    address: '123 Main St, Fargo, ND',
    job: 'AC not cooling; unit freezing',
    start: '2025-08-12T14:00:00-05:00', end: '2025-08-12T16:00:00-05:00',
    notes: 'Prefer technician calls on arrival', emergency: false
  };
  const result = await sendBooking(payload, c.zap);
  res.json({ ok: true, forwarded_to_zapier: result });
});

// ---- Twilio Voice: per-client route -> WS with slug ----
app.post('/voice/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!CLIENTS[slug]) return res.status(404).send('Unknown client');
  const host = req.get('host');
  const wssUrl = `wss://${host}/ws?slug=${encodeURIComponent(slug)}`;
  const twiml = `
<Response>
  <Say>Connecting your call. One moment.</Say>
  <Connect><Stream url="${wssUrl}"/></Connect>
</Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ======================= WS BRIDGE (Twilio <-> OpenAI) =======================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (twilioWs, req) => {
  console.log('>> Media Stream connected');

  // Parse slug from ?slug=...
  const url = new URL(req.url, 'ws://localhost');
  const slug = url.searchParams.get('slug') || 'demo';
  const client = CLIENTS[slug] || CLIENTS.demo;

  // Light Twilio debug
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'connected') console.log('Twilio evt:', data.event, data.protocol, data.version);
      if (data.event === 'start')      console.log('Twilio evt:start tracks=', data.start?.tracks, 'streamSid=', data.streamSid);
      if (data.event === 'media' && data.media?.track) console.log('Twilio evt:media track=', data.media.track, 'chunk=', data.media.chunk);
      if (data.event === 'mark')       console.log('Twilio evt:mark name=', data.mark?.name);
    } catch {}
  });

  console.log('>> Attempting OpenAI Realtime connection…');
  console.log('>> OPENAI key present:', !!process.env.OPENAI_API_KEY);

  const aiWs = new WebSocket(
    OPENAI_URL,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;
  let aiBusy = false;
  let pendingPrompt = null;
  let lastTextChunk = '';

  const REPLY_SHAPE = { modalities: ['audio', 'text'], voice: client.voice, output_audio_format: 'pcm16' };
  const SYSTEM_MESSAGE = buildSystemMessage(client);

  const sendReply = (textOrNull) => {
    aiWs.send(JSON.stringify({
      type: 'response.create',
      response: textOrNull ? { ...REPLY_SHAPE, instructions: textOrNull } : { ...REPLY_SHAPE }
    }));
  };

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
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'pcm16',
        modalities: ['audio', 'text'],
        voice: client.voice,
        instructions: SYSTEM_MESSAGE,
        temperature: 0.6
      }
    }));

    setTimeout(() => {
      const greet = `Thanks for calling ${client.name}. I’ll get you scheduled. May I have your full name?`;
      if (!aiBusy) sendReply(greet); else pendingPrompt = greet;
    }, 200);
  });

  // ===== OpenAI -> us =====
  aiWs.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());
      const type = evt.type;

      if (!['response.audio.delta','response.output_audio.delta','response.output_text.delta','rate_limits.updated'].includes(type)) {
        console.log('AI evt:', type);
      }

      if (type === 'error') {
        console.error('AI error detail:', JSON.stringify(evt, null, 2));
      }

      if (type === 'response.created') aiBusy = true;

      if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        lastTextChunk += evt.delta;
      }

      if (type === 'response.done') {
        aiBusy = false;

        // Pick up BOOKING JSON
        const m = lastTextChunk.match(/BOOKING:\s*(\{.*\})/);
        if (m) {
          try {
            const booking = JSON.parse(m[1]);
            console.log(`[${slug}] BOOKING:`, booking);
            sendBooking(booking, client.zap).then(r => console.log(`[${slug}] → Zapier:`, r));
          } catch (e) { console.error('!! Failed to parse BOOKING JSON:', e); }
        }
        lastTextChunk = '';

        if (pendingPrompt) { const txt = pendingPrompt; pendingPrompt = null; sendReply(txt); }
      }

      // After caller stops speaking, ask model to respond
      if (type === 'input_audio_buffer.committed') {
        if (!aiBusy) sendReply(null);
      }

      // Stream audio back to Twilio: PCM16 (24k) -> μ-law 8k
      if ((type === 'response.audio.delta' || type === 'response.output_audio.delta') && evt.delta && streamSid) {
        const pcm24k = Buffer.from(
          typeof evt.delta === 'string' ? evt.delta : Buffer.from(evt.delta).toString('base64'),
          'base64'
        );
        const samples = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length / 2);
        const outLen = Math.floor(samples.length / 3); // 24k -> 8k naive downsample
        const ulaw = new Uint8Array(outLen);
        for (let i = 0, j = 0; j < outLen; i += 3, j++) ulaw[j] = linearToMuLaw(samples[i]);
        const ulawB64 = Buffer.from(ulaw).toString('base64');
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: ulawB64 } }));
        twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `ai-${Date.now()}` } }));
        console.log('>> sent AI audio chunk (μ-law) len:', ulawB64.length);
      }
    } catch (e) {
      console.error('AI parse error:', e);
    }
  });

  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', (code, reason) => console.log('>> OpenAI socket closed', code, reason?.toString?.() || ''));

  // ===== Twilio -> us =====
  twilioWs.on('message', (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start': {
        streamSid = data.start?.streamSid || data.streamSid || data.start?.callSid;
        console.log('>> Stream started. SID:', streamSid, 'slug:', slug);
        // Beep so you can hear outbound audio path
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        const beep = generateBeepMuLawBase64(440, 250);
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: beep } }));
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
