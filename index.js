import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// ===== BASIC CONFIG (single client) =====
const OPENAI_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const VOICE = process.env.VOICE || 'alloy';

// (Optional) tiny μ-law beep so you can hear outbound audio right after connect
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

// Prompt/instructions
const SYSTEM_MESSAGE = `
You are a professional HVAC receptionist for ${process.env.BUSINESS_NAME || 'Our HVAC'} in ${process.env.BUSINESS_CITY || 'our service area'}.
Tone: warm, concise, confident. Collect details and book an appointment.

ALWAYS collect, one item at a time:
1) Full name
2) Mobile number (confirm back)
3) Full service address (street, city, ZIP)
4) Problem summary (no cooling/heat, noise, leak, thermostat, breaker)
5) System brand and approx. age
6) Urgency (no cooling/heat, water, or gas smell = EMERGENCY)
7) Preferred 2-hour time window

Stay on-topic. If caller drifts: “Happy to help—first, may I get your full name?”
Never quote prices; say the tech will diagnose and give a clear estimate.

When you have all fields, speak the confirmation AND emit ONE single line of text:
BOOKING:{"name":"...","phone":"...","address":"...","job":"...","start":"YYYY-MM-DDTHH:mm:ssZZ","end":"YYYY-MM-DDTHH:mm:ssZZ","notes":"...","emergency":true|false}
(Exactly one JSON line after BOOKING:, minified.)
`;

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('OK: server is running'));

// (Optional) send booking to Zapier
async function sendBooking(payload) {
  const url = process.env.ZAPIER_HOOK_URL;
  if (!url) { console.log('No ZAPIER_HOOK_URL set; skipping.'); return { ok: false, reason: 'missing Zap URL' }; }
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return { ok: r.ok, status: r.status };
}

// Quick manual test in your browser (fires a fake booking to Zap)
app.get('/fake-book', async (_req, res) => {
  const payload = {
    name: 'Test Customer', phone: '+17010000000', address: '123 Main St, Fargo, ND',
    job: 'AC tune-up', start: '2025-08-12T10:00:00-05:00', end: '2025-08-12T12:00:00-05:00',
    notes: 'gate code 1234', emergency: false
  };
  const result = await sendBooking(payload);
  res.send(`Triggered booking → ${JSON.stringify(result)}`);
});

// Twilio webhook (single URL): /voice
app.post('/voice', (req, res) => {
  const host = req.get('host');
  const wssUrl = `wss://${host}/ws`;
  const twiml = `
<Response>
  <Say>Connecting your call. One moment.</Say>
  <Connect><Stream url="${wssUrl}"/></Connect>
</Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ===== Twilio <-> OpenAI Realtime bridge =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (twilioWs) => {
  console.log('>> Media Stream connected');

  // Minimal Twilio debug
  twilioWs.on('message', (m) => {
    try {
      const d = JSON.parse(m.toString());
      if (d.event === 'connected') console.log('Twilio evt:', d.event, d.protocol, d.version);
      if (d.event === 'start')      console.log('Twilio evt:start tracks=', d.start?.tracks, 'streamSid=', d.streamSid);
      if (d.event === 'mark')       console.log('Twilio evt:mark name=', d.mark?.name);
    } catch {}
  });

  console.log('>> Attempting OpenAI Realtime connection… key present:', !!process.env.OPENAI_API_KEY);
  const aiWs = new WebSocket(
    OPENAI_URL,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;
  let aiBusy = false;  // prevents “conversation_already_has_active_response”
  let lastTextChunk = '';

  aiWs.on('open', () => {
    console.log('>> Connected to OpenAI Realtime');

    // Configure session for μ-law passthrough both ways
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',   // Twilio -> OpenAI
        output_audio_format: 'g711_ulaw',  // OpenAI -> Twilio (no resample)
        modalities: ['audio', 'text'],
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        temperature: 0.6
      }
    }));

    // Greet
    setTimeout(() => {
      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          voice: VOICE,
          output_audio_format: 'g711_ulaw',
          instructions: `Thanks for calling ${process.env.BUSINESS_NAME || 'our service'}. May I have your full name?`
        }
      }));
    }, 200);
  });

  // OpenAI -> us
  aiWs.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());
      const type = evt.type;

      if (!['response.audio.delta','response.output_audio.delta','response.output_text.delta','rate_limits.updated'].includes(type)) {
        console.log('AI evt:', type);
      }
      if (type === 'error') console.error('AI error detail:', JSON.stringify(evt, null, 2));
      if (type === 'response.created') aiBusy = true;

      if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        lastTextChunk += evt.delta;
      }

      if (type === 'response.done') {
        aiBusy = false;
        // Look for BOOKING: JSON line
        const m = lastTextChunk.match(/BOOKING:\s*(\{.*\})/);
        if (m) {
          try {
            const booking = JSON.parse(m[1]);
            console.log('BOOKING:', booking);
            sendBooking(booking).then(r => console.log('→ Zapier:', r));
          } catch (e) { console.error('!! BOOKING JSON parse failed:', e); }
        }
        lastTextChunk = '';
      }

      // Send audio to Twilio (OpenAI → Twilio), μ-law passthrough
      if ((type === 'response.audio.delta' || type === 'response.output_audio.delta') && evt.delta && streamSid) {
        const base64 = typeof evt.delta === 'string'
          ? evt.delta
          : Buffer.from(evt.delta).toString('base64');
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64 } }));
        // console.log('>> sent AI audio chunk to Twilio (μ-law) len:', base64.length);
      }

      // When caller stops talking, ask model to reply (one at a time)
      if (type === 'input_audio_buffer.committed') {
        if (!aiBusy) {
          aiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio', 'text'], voice: VOICE, output_audio_format: 'g711_ulaw' }
          }));
        }
      }
    } catch (e) {
      console.error('AI parse error:', e);
    }
  });

  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', (code, reason) => console.log('>> OpenAI socket closed', code, reason?.toString?.() || ''));

  // Twilio -> us
  twilioWs.on('message', (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start': {
        streamSid = data.start?.streamSid || data.streamSid || data.start?.callSid;
        console.log('>> Stream started. SID:', streamSid);
        // optional: prove outbound with a quick beep
        try {
          const beep = generateBeepMuLawBase64(440, 220);
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: beep } }));
        } catch {}
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
