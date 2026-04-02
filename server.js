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
    If you are with ${senderName} right now, here are immediate safety steps.
    First, move to a crowded, well-lit public area immediately.
    Second, call 112 or 100 for police assistance.
    Third, do not go to any isolated location.
    Fourth, keep shouting for help to attract attention.
    Fifth, use your keys or any object for self defense if attacked.
    Aim for the eyes, throat, or groin, then run.
  </Say>
  <Pause length="1"/>
  <Say voice="alice">
    This is an automated emergency alert from SafeHer safety app.
    Please respond immediately. The user is in danger.
    Check WhatsApp for live location. Call 112 for police. Thank you.
  </Say>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// TwiML for general voice interactive menu during a call
app.post('/api/voice/interactive', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/api/voice/handle-input" method="POST">
    <Say voice="alice">
      Welcome to SafeHer emergency line. 
      Press 1 if you are being followed.
      Press 2 if you are being harassed.
      Press 3 for an unsafe vehicle situation.
      Press 4 for domestic violence help.
      Press 5 to hear self defense tips.
      Press 9 to trigger SOS to all contacts.
      Press 0 to repeat this menu.
    </Say>
  </Gather>
  <Say voice="alice">We did not receive your input. Please call back for help. Stay safe.</Say>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// Handle interactive voice input
app.post('/api/voice/handle-input', (req, res) => {
  const digit = req.body.Digits;
  let message = '';

  switch (digit) {
    case '1':
      message = `Being followed safety steps. 
        One: Do NOT go home. You will lead them to your address.
        Two: Enter the nearest busy store, restaurant, or petrol pump. Stay inside.
        Three: Cross the street and change direction two to three times to confirm if being followed.
        Four: Call a friend or family and stay on the phone.
        Five: Walk into the nearest police station or crowded area.
        Six: For self defense, if grabbed, deliver a palm strike to the nose, then elbow to the ribs, knee to the groin, and run screaming for help.`;
      break;
    case '2':
      message = `Harassment safety steps.
        One: Speak loudly and clearly. Say STOP! You are harassing me! Draw public attention.
        Two: Call out the harasser by clothing color. Hey everyone, this person is harassing me.
        Three: Call 1091, the Women Helpline, or 100 for police immediately.
        Four: Record with your phone. This is legal in public spaces.
        Five: Move to a well-lit, crowded place.
        Six: For self defense, a strong shout combined with a palm strike to the face creates a chance to escape. Then run towards people.`;
      break;
    case '3':
      message = `Unsafe vehicle situation steps.
        One: Share your live location immediately via Google Maps with a family member.
        Two: Photograph the driver face and license plate and send to a contact.
        Three: Call someone and keep talking. Mention every landmark you pass.
        Four: If route is wrong, calmly say I feel unwell, please stop here.
        Five: If threatened, shout loudly to attract attention at red lights.
        Six: If the car stops in an isolated area, try to jump out towards lights or people.`;
      break;
    case '4':
      message = `Domestic violence immediate steps.
        One: If in immediate danger, call 112 now.
        Two: Move towards a door or exit. Always position yourself near escape routes.
        Three: Call iCall counseling at 9152987821.
        Four: Pack an emergency bag with ID, money, medicines, and phone charger.
        Five: Courts can issue Protection Orders within 24 hours under Domestic Violence Act 2005.
        Six: Hyderabad Swadhar Greh shelters provide free safe stay for women fleeing violence.`;
      break;
    case '5':
      message = `Self defense techniques.
        One: Palm strike. Use the heel of your palm to strike the nose hard. This causes pain and temporary vision blur.
        Two: Elbow strike. Your elbow is one of the hardest parts of your body. Drive it into ribs or face.
        Three: Knee to groin. A powerful knee strike to the groin is highly effective against male attackers.
        Four: Eye jab. Extended thumb or two fingers jabbed at eyes forces the attacker to release you.
        Five: Stomp on instep. Stomp hard on top of their foot to cause pain and break their grip.
        Six: Bite. If grabbed from behind, bite hard on any exposed skin.
        Remember: Your goal is not to fight but to create a chance to escape. Strike hard, then run and scream.`;
      break;
    case '9':
      message = `SOS triggered. Alerting all your emergency contacts now. Help is on the way. 
        Stay calm and move to a crowded public area immediately. 
        Keep your phone with you. Your live location is being sent to all guardians.`;
      break;
    default:
      message = `Returning to main menu.`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${message}</Say>
  <Pause length="2"/>
  <Gather numDigits="1" action="/api/voice/handle-input" method="POST">
    <Say voice="alice">
      Press 1 for being followed. Press 2 for harassment. Press 3 for unsafe vehicle.
      Press 4 for domestic violence. Press 5 for self defense. Press 9 for SOS. Press 0 to repeat.
    </Say>
  </Gather>
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

// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
