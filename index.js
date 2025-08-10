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

// Quick test endpoint to simulate a booking without AI
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
// ALSO allow a simple GET to test easily in the browser:
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

// ---- Twilio Voice webhook: returns TwiML to start streaming ----
app.post('/voice', (req, res) => {
  const host = req.get('host'); // e.g., your-app.onrender.com
  const wssUrl = `wss://${host}/ws`;
  const twiml =
    `<Response>
       <Say voice="Polly.Joanna">Connecting your call. One moment.</Say>
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

  // Connect to OpenAI Realtime over WebSocket
  const aiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;

  aiWs.on('open', () => {
    console.log('>> Connected to OpenAI Realtime');

    // Configure the session: match Twilio audio codec to avoid transcoding.
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },   // model detects when caller stops talking
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE || 'alloy',
        modalities: ['text', 'audio'],
        instructions: SYSTEM_MESSAGE,
        temperature: 0.5
      }
    }));

    // Send a short greeting so you immediately hear the AI
    aiWs.send(JSON.stringify({
      type: 'response.create',
      response: { instructions: 'Thanks for calling. May I have your name and the address for service?' }
    }));
  });

  // Forward AI audio chunks back to Twilio
  aiWs.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());

      if (evt.type === 'response.audio.delta' && evt.delta && streamSid) {
        const toTwilio = {
          event: 'media',
          streamSid,
          media: { payload: evt.delta } // base64 g711_ulaw audio
        };
        twilioWs.send(JSON.stringify(toTwilio));
      }

      // (Optional) you can log other events for debugging:
      if (evt.type === 'error') console.error('AI error:', evt);
      if (evt.type === 'session.updated') console.log('>> Session updated');
    } catch (e) {
      console.error('AI parse error:', e);
    }
  });

  aiWs.on('error', (e) => console.error('AI WS error:', e));
  aiWs.on('close', () => console.log('>> OpenAI socket closed'));

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
          // With server_vad ON, the model will detect end-of-speech
          // and handle committing/creating responses.
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
