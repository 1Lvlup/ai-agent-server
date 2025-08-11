import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// ============== Config you can change (=Render Env Vars) ==============
const OPENAI_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const VOICE = process.env.VOICE || 'alloy';
const BUSINESS_NAME = process.env.BUSINESS_NAME || '{BusinessName}';
const BUSINESS_CITY = process.env.BUSINESS_CITY || '{City, State}';

// ============== μ-law helpers (beep proves outbound audio works) ==============
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

// ============== System prompt (edit tone/flow here) ==============
const SYSTEM_MESSAGE = `
You are a professional HVAC receptionist for ${BUSINESS_NAME} in ${BUSINESS_CITY}.
Tone: warm, concise, confident. Goal: collect job details and book an appointment.

Always collect in this order:
1) Full name
2) Mobile number (repeat back to confirm)
3) Full service address incl. city & zip
4) Problem summary (e.g., no cooling, odd noise, leak, thermostat, breaker)
5) System details: brand and approx age
6) Urgency: no cooling/heat, water present, gas smell = emergency
7) Preferred 2-hour time window (offer 2 options if they hesitate)

Rules to stay on-topic:
- Be friendly, but avoid small talk. If caller goes off-topic, redirect within one sentence:
  "Happy to help—first, may I get your full name?"
- Never quote exact prices; say a technician will diagnose and give a clear estimate.
- Confirm key details back to the caller succinctly.
- When an emergency keyword (gas smell, smoke, active water leak) is heard: mark EMERGENCY and collect address + callback immediately.

When you have all required fields, in addition to speaking, emit ONE single line of text:
BOOKING:{"name":"...","phone":"...","address":"...","job":"...","start":"YYYY-MM-DDTHH:mm:ssZZ","end":"YYYY-MM-DDTHH:mm:ssZZ","notes":"...","emergency":true|false}
Notes:
- Keep JSON on one line, minified, exactly after "BOOKING:" with no extra text.
- times are local to caller; if unsure, propose a 2-hour window and include it.
`;

// We always ask for audio + text; audio goes to caller, text lets us catch BOOKING:
const REPLY_SHAPE = { modalities: ['audio', 'text'], voice: VOICE, output_audio_format: 'pcm16' };

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('OK: server is running'));

// --------- Zapier booking helper (already works with your hook) ----------
async function sendBooking(payload) {
  const url = process.env.ZAPIER_HOOK_URL;
  if (!url) { console.log('No ZAPIER_HOOK_URL set; skipping.'); return { ok: false, reason: 'missing Zap URL' }; }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ok: r.ok, status: r.status };
}

// Test endpoints (unchanged)
app.post('/fake-book', async (req, res) => {
  const payload = Object.keys(req.body || {}).length ? req.body : {
    name: 'Test Customer', phone: '+17010000000', address: '123 Main St, Fargo, ND',
    job: 'AC not cooling; unit freezing', start: '2025-08-12T14:00:00-05:00', end: '2025-08-12T16:00:00-05:00',
    notes: 'Prefer technician calls on arrival', emergency: false
  };
  const result = await sendBooking(payload);
  res.json({ ok: true, forwarded_to_zapier: result });
});
app.get('/fake-book', async (_req, res) => {
  const payload = { name: 'Test Customer', phone: '+17010000000', address: '123 Main St, Fargo, ND',
    job: 'AC tune-up', start: '2025-08-12T10:00:00-05:00', end: '2025-08-12T12:00:00-05:00', notes: 'gate code 1234', emergency: false };
  const result = await sendBooking(payload);
  res.send(`Triggered booking → ${JSON.stringify(result)}`);
});

// --------- Twilio Voice webhook: bidirectional stream ----------
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

// --------- WebSocket server (Twilio <-> OpenAI) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (twilioWs) => {
  console.log('>> Media Stream connected');

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
  let aiBusy = false;           // prevent overlapping responses
  let pendingPrompt = null;     // one queued prompt
  let lastTextChunk = '';       // we accumulate text for BOOKING: JSON

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
        input_audio_format: 'g711_ulaw',   // from Twilio
        output_audio_format: 'pcm16',      // high quality out, we downsample
        modalities: ['audio', 'text'],
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        temperature: 0.6
      }
    }));

    // Greet
    setTimeout(() => {
      const greet = `Thanks for calling ${BUSINESS_NAME}. I can help get you scheduled. May I have your full name?`;
      if (!aiBusy) sendReply(greet); else pendingPrompt = greet;
    }, 200);
  });

  // ========== OpenAI -> us ==========
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

      if (type === 'response.created') {
        aiBusy = true;
      }
      if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        lastTextChunk += evt.delta;
      }
      if (type === 'response.done') {
        aiBusy = false;

        // Parse any BOOKING:{...} JSON the model emitted in text
        const m = lastTextChunk.match(/BOOKING:\s*(\{.*\})/);
        if (m) {
          try {
            const booking = JSON.parse(m[1]);
            console.log('>> Detected BOOKING JSON:', booking);
            sendBooking(booking).then(r => console.log('>> Sent to Zapier:', r));
          } catch (e) {
            console.error('!! Failed to parse BOOKING JSON:', e);
          }
        }
        lastTextChunk = '';

        // Send any queued prompt
        if (pendingPrompt) {
          const txt = pendingPrompt; pendingPrompt = null;
          sendReply(txt);
        }
      }

      // After caller stops speaking, ask model to respond (if not already speaking)
      if (type === 'input_audio_buffer.committed') {
        if (!aiBusy) sendReply(null); else pendingPrompt = null;
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
        for (let i = 0, j = 0; j < outLen; i += 3, j++) {
          ulaw[j] = linearToMuLaw(samples[i]);
        }
        const ulawB64 = Buffer.from(ulaw).toString('base64');
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: ulawB64 } }));
        twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `ai-${Date.now()}` } }));
        console.log('>> sent AI audio chunk to Twilio (μ-law, 8k) len:', ulawB64.length);
      }

    } catch (e) {
      console.error('AI parse error:', e);
    }
  });

  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', (code, reason) => console.log('>> OpenAI socket closed', code, reason?.toString?.() || ''));

  // ========== Twilio -> us (caller audio) ==========
  twilioWs.on('message', (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start': {
        streamSid = data.start?.streamSid || data.streamSid || data.start?.callSid;
        console.log('>> Stream started. SID:', streamSid);
        // Prove playback
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
