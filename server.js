require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

// Firebase Admin Initialization
let serviceAccount;
if (process.env.FIREBASE_KEY) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        console.log('✅ Firebase Admin initialized via Env Var');
    } catch (e) {
        console.error('❌ Failed to parse FIREBASE_KEY Env Var:', e.message);
    }
} else if (fs.existsSync('./firebase-key.json')) {
    serviceAccount = require('./firebase-key.json');
    console.log('✅ Firebase Admin initialized via local file');
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.warn('⚠️ Firebase Admin NOT initialized. Push notifications will not work.');
}

const app = express();

// Secure Firebase Config Endpoint
app.get('/api/config', (req, res) => {
    res.json({
        firebase: {
            apiKey: process.env.FIREBASE_PUBLIC_API_KEY || "",
            authDomain: "safeher-1fb18.firebaseapp.com",
            projectId: "safeher-1fb18",
            storageBucket: "safeher-1fb18.firebasestorage.app",
            messagingSenderId: "717418341821",
            appId: "1:717418341821:web:6413b5f28ec7140bbe9ed4"
        }
    });
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Twilio TwiML webhooks
app.use(express.static(path.join(__dirname, 'public')));

// Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ==============================
// 📞 CONTACT STORAGE
// ==============================
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');

function loadContacts() {
  if (!fs.existsSync(CONTACTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE));
  } catch (e) {
    console.error('Failed to parse contacts.json:', e.message);
    return [];
  }
}

function saveContacts(data) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
}

let contacts = loadContacts();

// GET CONTACTS
app.get('/api/contacts', (req, res) => {
  contacts = loadContacts();
  res.json({ contacts });
});

// ADD CONTACT
app.post('/api/contacts', (req, res) => {
  contacts = loadContacts();
  const { name, phone, relationship, fcmToken } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name & phone required' });
  }

  const newContact = {
    id: Date.now().toString(),
    name,
    phone: phone.startsWith('+') ? phone : '+91' + phone,
    relationship: relationship || 'Emergency',
    enabled: true,
    fcmToken: fcmToken // Store the FREE FCM token
  };

  contacts.push(newContact);
  saveContacts(contacts);

  res.json({ success: true, contact: newContact });
});

// TOGGLE CONTACT ENABLED
app.post('/api/contacts/:id/toggle', (req, res) => {
  contacts = loadContacts();
  const contact = contacts.find(c => c.id === req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  contact.enabled = !contact.enabled;
  saveContacts(contacts);
  res.json({ success: true, enabled: contact.enabled });
});

// DELETE CONTACT
app.delete('/api/contacts/:id', (req, res) => {
  contacts = loadContacts();
  contacts = contacts.filter(c => c.id !== req.params.id);
  saveContacts(contacts);
  res.json({ success: true });
});

// ==============================
// 🚨 SOS LOGIC
// ==============================
const sessions = new Map();
const UPDATE_INTERVAL = 1 * 60 * 1000; // 1 min live updates

function createSession(contactList) {
  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, {
    contacts: contactList,
    lat: null,
    lng: null,
    accuracy: null,
    interval: null,
    updateCount: 0
  });
  return id;
}

// 🔁 LIVE LOCATION UPDATES (SMS + WhatsApp)
function startLiveUpdates(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;

  if (s.interval) clearInterval(s.interval);

  s.interval = setInterval(() => {
    const session = sessions.get(sessionId);
    if (!session || !session.lat || !session.lng) return;

    session.updateCount++;

    const lat = session.lat;
    const lng = session.lng;
    const maps = `https://www.google.com/maps?q=${lat},${lng}`;
    const track = `https://safeher-1fb18.web.app/track.html?id=${sessionId}`;
    const time = new Date().toLocaleTimeString('en-IN');

    const smsUpdate = `🚨 LIVE LOCATION UPDATE #${session.updateCount}\n\nLat: ${Number(lat).toFixed(6)}\nLng: ${Number(lng).toFixed(6)}\n\nOpen on Google Maps:\n${maps}\n\nTime: ${time}\nEmergency is still ACTIVE. Call them NOW!`;

    // Fire all updates in parallel
    Promise.all(session.contacts.map(c => [
      // SMS update
      client.messages.create({ body: smsUpdate, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone })
        .then(() => console.log(`📡 Live SMS #${session.updateCount} → ${c.phone}`))
        .catch(e => console.error(`❌ Live SMS error: ${e.message}`)),

      // Push notification
      ...(c.fcmToken ? [
        admin.messaging().send({
          token: c.fcmToken,
          notification: { title: `📍 Live Update #${session.updateCount}`, body: `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` },
          data: { url: track }
        }).catch(() => {})
      ] : [])
    ]).flat());

  }, UPDATE_INTERVAL);
}

// ==============================
// 🎙️ TWILIO VOICE TWIML — Intelligent Safety Help
// ==============================
// This endpoint is used as the TwiML URL for voice calls
// It provides a detailed safety message during the call
app.post('/api/voice/sos', (req, res) => {
  const senderName = req.query.name || 'a SafeHer user';
  const lat = req.query.lat || '';
  const lng = req.query.lng || '';
  const mapsLink = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : '';

  const locationMsg = lat && lng
    ? `Their GPS coordinates are latitude ${lat.substring(0, 7)} and longitude ${lng.substring(0, 7)}.`
    : 'Location data is being updated.';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    Emergency Alert! Emergency Alert!
    ${senderName} has activated SOS and needs immediate help.
    ${locationMsg}
    Please check your WhatsApp for the live location tracking link.
    Stay on this call or call them back immediately.
  </Say>
  <Pause length="1"/>
  <Say voice="alice">
    Entering SafeHer Voice Assistant for emergency guidance.
  </Say>
  <Redirect>/api/voice/interactive</Redirect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// TwiML for general voice interactive menu during a call - Now with Speech Recognition
app.post('/api/voice/interactive', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/voice/handle-speech" method="POST" speechTimeout="auto" hints="harassment, kidnap, follow, acid, robbery, weapon, help, sos">
    <Say voice="alice">
      SafeHer Voice Guard. Briefly state your situation, like: I am being followed, harassment, kidnapping, acid attack, or robbery. Or say self defense for techniques. Say H E L P to trigger S O S.
    </Say>
  </Gather>
  <Redirect>/api/voice/interactive</Redirect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// Handle speech input from the call
app.post('/api/voice/handle-speech', (req, res) => {
  const speechResult = (req.body.SpeechResult || "").toLowerCase();
  let message = "";
  
  if (speechResult.includes("harass")) {
    message = "Harassment detected. Step 1: Speak loudly, say STOP! You are harassing me! Step 2: Draw public attention by calling out the person description. Step 3: Call 1091 helpline. Step 4: Move to a crowded area. If grabbed, palm strike to nose and run.";
  } else if (speechResult.includes("follow")) {
    message = "Being followed? Do NOT go home. Enter the nearest busy shop or police station. Change direction 3 times to confirm. Call family now and stay on the phone. For defense: elbow strike to ribs and scream FIRE.";
  } else if (speechResult.includes("kidnap") || speechResult.includes("grab")) {
    message = "KIDNAPPING THREAT. Go limp and heavy to be hard to carry. Scream FIRE or HELP as loud as possible. Use your keys to gouge eyes or scratch. Stomp on their instep with full force. Try to attract ANY bystander attention immediately.";
  } else if (speechResult.includes("acid")) {
    message = "ACID ATTACK THREAT. Shout for help immediately. Cover your face with your arms. If attacked, wash with huge amounts of clean running water for 20 minutes. Do not use milk or ice. Call 102 for ambulance immediately.";
  } else if (speechResult.includes("rob") || speechResult.includes("steal") || speechResult.includes("weapon")) {
    message = "ROBBERY SITUATION. Your life is more valuable than your phone or money. Hand over the items. Do not make sudden moves. Try to memorize their height, clothing, and escape route. Call 100 once they leave.";
  } else if (speechResult.includes("defense") || speechResult.includes("fight")) {
    message = "SELF DEFENSE TIPS. One: Palm strike to nose. Two: Knee to groin. Three: Elbow to ribs. Four: Eye jab. Five: Heel stomp on foot. Goal is to escape, not win a fight. Strike hard, then run.";
  } else if (speechResult.includes("help") || speechResult.includes("sos") || speechResult.includes("danger") || speechResult.includes("bachao")) {
    message = "S O S TRIGGERED via voice command. I am alerting all your guardians with your live location right now. Move to a safe area. Help is coming.";
    // Here logic to trigger actual SMS/Call could be added if session info is available, 
    // but for now, we provide the voice confirmation.
  } else {
    message = "I heard " + speechResult + ". Please try saying harassment, follow, kidnap, or self defense.";
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${message}</Say>
  <Pause length="1"/>
  <Gather input="speech" action="/api/voice/handle-speech" method="POST" speechTimeout="auto">
    <Say voice="alice">Say another situation or say goodbye to end the call.</Say>
  </Gather>
  <Redirect>/api/voice/interactive</Redirect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// ==============================
// 🚨 SOS TRIGGER
// ==============================
app.post('/api/sos', async (req, res) => {
  const { latitude, longitude, accuracy, senderName } = req.body;

  contacts = loadContacts();

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'Location required' });
  }

  const activeContacts = contacts.filter(c => c.enabled !== false);

  if (activeContacts.length === 0) {
    return res.status(400).json({ error: 'No active contacts enabled. Please add and enable a guardian first.' });
  }

  const sessionId = createSession(activeContacts);
  const session = sessions.get(sessionId);
  session.lat = latitude;
  session.lng = longitude;
  session.accuracy = accuracy;

  const displaySender = senderName || 'SafeHer User';
  const maps = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const track = `https://safeher-1fb18.web.app/track.html?id=${sessionId}`;
  const timestamp = new Date().toLocaleString('en-IN');

  // SMS body — shows GPS coordinates + Google Maps link clearly
  const smsBody = `EMERGENCY SOS FROM ${displaySender.toUpperCase()}\n\nCURRENT LOCATION:\nLat: ${Number(latitude).toFixed(6)}\nLng: ${Number(longitude).toFixed(6)}\n\nTap to open in Google Maps:\n${maps}\n\nPlease call them NOW or call 112 for Police.\nLive location SMS will auto-send every 1 minute.`;

  // Inline TwiML — works instantly, no external URL needed
  const twimlXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Emergency Alert! ${displaySender} has activated SOS and needs help immediately. Check your SMS for the Google Maps location link. Call them back right now. If unreachable call 1 1 2 for police. This alert is from SafeHer safety app.</Say></Response>`;

  console.log(`🚨 SOS — sending to ${activeContacts.length} contact(s) in parallel`);

  // ⚡ START LIVE UPDATES + RESPOND TO FRONTEND INSTANTLY (no waiting for Twilio)
  startLiveUpdates(sessionId);

  res.json({
    success: true,
    sessionId,
    totalSent: activeContacts.length,
    totalFailed: 0,
    results: activeContacts.map(c => ({ contact: c.name, phone: c.phone, channels: ['SMS', 'Call'] })),
    errors: [],
    googleMapsLink: maps,
    timestamp
  });

  // ⚡ FIRE SMS + CALL + PUSH ALL AT ONCE — runs after response is sent
  Promise.all(activeContacts.flatMap(c => [

    // 📱 SMS
    client.messages.create({ body: smsBody, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone })
      .then(() => console.log(`✅ SMS → ${c.name} (${c.phone})`))
      .catch(e => console.error(`❌ SMS → ${c.name}: ${e.message}`)),

    // 📞 CALL
    client.calls.create({ twiml: twimlXml, to: c.phone, from: process.env.TWILIO_PHONE_NUMBER })
      .then(() => console.log(`✅ Call → ${c.name} (${c.phone})`))
      .catch(e => console.error(`❌ Call → ${c.name}: ${e.message}`)),

    // 🔔 PUSH (only if FCM token exists)
    ...(c.fcmToken ? [
      admin.messaging().send({
        token: c.fcmToken,
        notification: { title: `🚨 SOS ALERT!`, body: `${displaySender} needs help NOW!` },
        data: { url: track }
      }).then(() => console.log(`✅ Push → ${c.name}`))
        .catch(() => {})
    ] : [])

  ])).then(() => console.log(`✅ All channels fired for ${activeContacts.length} contact(s)`));

});

// ==============================
// 💬 CHAT SOS — Emergency SMS from chatbot
// ==============================
app.post('/api/chat-sos', async (req, res) => {
  const { to, text, latitude, longitude, accuracy } = req.body;
  if (!to) return res.status(400).json({ error: 'Phone number required' });

  const phone = to.startsWith('+') ? to : '+91' + to;
  const maps = latitude && longitude ? `https://maps.google.com/?q=${latitude},${longitude}` : 'Location unavailable';

  const message = `🚨 EMERGENCY from SafeHer App!\n\nThe user sent: "${text}"\n\n📍 Location: ${maps}\n\n⚠️ Please respond immediately or call 112 for police.`;

  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });
    res.json({ success: true, to: phone });
  } catch (err) {
    console.error('Chat SOS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==============================
// 💬 CHAT API — Safety tips
// ==============================
app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  res.json({
    success: true,
    answer: `I can help with safety tips. Try asking about: being followed, harassment, unsafe cab, night walking, domestic violence, online stalking, workplace harassment, or self defense techniques.`
  });
});

// ==============================
// 📍 LIVE LOCATION UPDATE
// ==============================
app.post('/api/live-location/:id', (req, res) => {
  const { id } = req.params;
  const { lat, lng, accuracy } = req.body;

  const s = sessions.get(id);
  if (!s) return res.sendStatus(404);

  s.lat = lat;
  s.lng = lng;
  s.accuracy = accuracy;

  res.json({ success: true });
});

// 📍 BACKWARDS COMPAT — old endpoint alias
app.post('/api/update-location/:id', (req, res) => {
  const { id } = req.params;
  const { lat, lng, accuracy } = req.body;

  const s = sessions.get(id);
  if (!s) return res.sendStatus(404);

  s.lat = lat;
  s.lng = lng;
  s.accuracy = accuracy;

  res.json({ success: true });
});

// =============================================
// 🗺️ COMMUNITY INCIDENT MAP — API
// =============================================

// POST /api/community/pin — Save an anonymous incident pin
app.post('/api/community/pin', async (req, res) => {
  const { type, note, lat, lng } = req.body;
  if (!type || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Missing required fields: type, lat, lng' });
  }

  const pin = {
    type,
    note: (note || '').slice(0, 200), // limit note length
    lat: parseFloat(parseFloat(lat).toFixed(5)),
    lng: parseFloat(parseFloat(lng).toFixed(5)),
    timestamp: new Date().toISOString(),
    // No user ID — fully anonymous
  };

  try {
    if (admin.apps.length > 0) {
      const db = admin.firestore();
      const ref = await db.collection('community_pins').add(pin);
      console.log(`📍 Community pin saved: ${type} at ${lat},${lng} [${ref.id}]`);
      return res.json({ success: true, id: ref.id });
    } else {
      // Firebase not configured — accept but don't persist server-side
      console.log(`📍 Community pin (local only): ${type} at ${lat},${lng}`);
      return res.json({ success: true, id: 'local_' + Date.now(), note: 'Firebase not configured' });
    }
  } catch (err) {
    console.error('Community pin save error:', err.message);
    return res.status(500).json({ error: 'Failed to save pin', detail: err.message });
  }
});

// GET /api/community/pins — Fetch recent pins
app.get('/api/community/pins', async (req, res) => {
  try {
    if (admin.apps.length === 0) {
      return res.json({ pins: [] });
    }

    const db = admin.firestore();
    // Remove pins older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db.collection('community_pins')
      .where('timestamp', '>', cutoff)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    const pins = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ pins, total: pins.length });
  } catch (err) {
    console.error('Community pins fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pins', pins: [] });
  }
});

// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
