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

wss.on('connection', (ws) => {
  console.log('>> Media Stream connected');

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message.toString()); } catch { return; }

    // Twilio events: "start", "media", "mark", "stop"
    if (data.event === 'start') {
      console.log(`>> Stream started. Call SID: ${data.start.callSid}`);
      ws.send(JSON.stringify({ event: 'mark', mark: { name: 'ready' } }));
    }
    if (data.event === 'media') {
      // data.media.payload is base64 mu-law audio (8kHz) from the caller
      // We'll forward this to the AI in the next phase.
    }
    if (data.event === 'stop') {
      console.log('>> Stream stopped. Call ended.');
    }
  });

  ws.on('close', () => console.log('>> Media Stream closed'));
  ws.on('error', (e) => console.error('WS error', e));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
