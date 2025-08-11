import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';

// === OpenAI Realtime config ===
const OPENAI_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const VOICE = 'alloy'; // you can change later

// Short, focused receptionist instructions
const SYSTEM_MESSAGE = `
You are a professional HVAC receptionist for {BusinessName} in {City, State}.
Tone: warm, concise, confident. Goal: answer calls 24/7, capture job details, and book an appointment.

ALWAYS collect in this order:
1) Caller full name
2) Mobile number (confirm with them)
3) Full service address incl. city & zip
4) Problem summary (no cooling, odd noise, leak, thermostat, breaker)
5) System details (brand, approx age)
6) Urgency (no cooling/heat, water present, gas smell = emergency)
7) Preferred 2-hour time window

If gas smell/smoke/active water leak: mark EMERGENCY and escalate to owner SMS.
Never quote exact prices; say the tech will diagnose and give a clear estimate.
Be brief; confirm details back to the caller. When details are complete, say they'll get a text confirmation and the tech will call en route.
`;

const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('OK: server is running'));

// ---- Booking helper (Zapier hook – optional for later) ----
async function sendBooking(payload) {
  const url = process.env.ZAPIER_HOOK_URL;
  if (!url) {
    console.log('No ZAPIER_HOOK_URL set; skipping.');
    return { ok: false, reason: 'missing Zap URL' };
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { ok: r.ok, status: r.status };
}

// Quick test endpoint to simulate a booking without AI (POST)
app.post('/fake-book', async (req, res) => {
  const payload = Object.keys(req.body || {}).length ? req.body : {
    name: 'Test Customer',
    phone: '+17010000000',
    address: '123 Main St, Fargo, ND',
    job: 'AC not cooling; unit freezing',
    start: '2025-08-12T14:00:00-05:00',
    end:   '2025-08-12T16:00:00-05:00',
    notes: 'Prefer technician calls on arrival'
  };
  const result = await sendBooking(payload);
  res.json({ ok: true, forwarded_to_zapier: result });
});

// Quick test endpoint (GET) so you can just click a link to trigger booking
app.get('/fake-book', async (req, res) => {
  const payload = {
    name: 'Test Customer',
    phone: '+17010000000',
    address: '123 Main St, Fargo, ND',
    job: 'AC tune-up',
    start: '2025-08-12T10:00:00-05:00',
    end:   '2025-08-12T12:00:00-05:00',
    notes: 'gate code 1234'
  };
  const result = await sendBooking(payload);
  res.send(`Triggered booking → ${JSON.stringify(result)}`);
});

// Twilio Voice webhook: returns TwiML to start streaming
app.post('/voice', (req, res) => {
  const host = req.get('host'); // e.g., your-app.onrender.com
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

  console.log('>> Attempting OpenAI Realtime connection…');
  console.log('>> OPENAI key present:', !!process.env.OPENAI_API_KEY);

  // Connect to OpenAI Realtime over WebSocket
  const aiWs = new WebSocket(
    OPENAI_URL,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;

  // If OpenAI rejects the WebSocket upgrade, this event fires with the HTTP response
  aiWs.on('unexpected-response', (req, res) => {
    console.error('!! OpenAI unexpected response status:', res.statusCode);
    try {
      res.on('data', (chunk) => console.error('!! OpenAI response body:', chunk.toString()));
    } catch {}
  });

  aiWs.on('open', () => {
    console.log('>> Connected to OpenAI Realtime');

    // Configure the session: match Twilio audio codec to avoid transcoding.
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },   // model detects when caller stops talking
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        modalities: ['audio', 'text'],
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        temperature: 0.6
      }
    }));

    // Small delay so session settings apply, then greet (explicit audio + text)
    setTimeout(() => {
      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          voice: VOICE,
          output_audio_format: 'g711_ulaw',
          instructions: 'Hello! I am the HVAC receptionist bot. I can hear you. What’s your name?'
        }
      }));
    }, 200);
  });

  // Forward AI audio chunks back to Twilio (handle both event names + flush marks)
aiWs.on('message', (data) => {
  try {
    const evt = JSON.parse(data.toString());
    const type = evt.type;

    // Light debug
    if (!['response.audio.delta','response.output_audio.delta','rate_limits.updated'].includes(type)) {
      console.log('AI evt:', type);
    }

    // Trigger a reply after each utterance
    if (type === 'input_audio_buffer.committed') {
      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          voice: VOICE,
          output_audio_format: 'g711_ulaw'
        }
      }));
    }

    // Stream audio chunks back to Twilio (handle both event names)
    if ((type === 'response.audio.delta' || type === 'response.output_audio.delta')
        && evt.delta && streamSid) {

      const base64 = typeof evt.delta === 'string'
        ? evt.delta
        : Buffer.from(evt.delta).toString('base64');

      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: base64 }
      }));

      // Optional: ask Twilio to confirm it drained buffered audio
      twilioWs.send(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: `m-${Date.now()}` }
      }));
    }
  } catch (e) {
    console.error('AI parse error:', e);
  }
});



  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', (code, reason) => {
    console.log('>> OpenAI socket closed', code, reason?.toString?.() || '');
  });

  // Handle incoming Twilio media stream (caller audio)
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid || data.start.callSid;
        console.log('>> Stream started. SID:', streamSid);
        break;

      case 'media':
        // Forward caller audio (base64 g711_ulaw) to OpenAI
        if (aiWs.readyState === WebSocket.OPEN && data.media?.payload) {
          aiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));
        }
        break;

      case 'stop':
        console.log('>> Stream stopped');
        try { aiWs.close(); } catch {}
        break;

      default:
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('>> Media Stream closed');
    try { aiWs.close(); } catch {}
  });

  twilioWs.on('error', (e) => console.error('Twilio WS error:', e));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
