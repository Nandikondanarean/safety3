require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ==============================
// 🧠 GEMINI AI INITIALIZATION
// ==============================
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('✅ Gemini AI initialized (gemini-2.0-flash)');
} else {
    console.warn('⚠️ GEMINI_API_KEY not set. Chat will use basic keyword fallback.');
}

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

// 👁️ AI VISUAL GUARDIAN — Image Analysis
app.post('/api/analyze-evidence', async (req, res) => {
    try {
        const { image, sessionId } = req.body;
        if (!image) return res.status(400).json({ error: "Image data missing" });

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const prompt = `
            You are a professional safety forensic AI. Analyze this image captured by an endangered woman. 
            EXTRACT and SUMMARIZE:
            1. LICENSE PLATES: Extract any vehicle numbers clearly.
            2. SUSPECT DESCRIPTION: Gender, clothing colors, height, identifying marks.
            3. VEHICLE: Make, model, color, special decals.
            4. LOCATION: Any visible street signs or landmarks.
            
            Format your response as a concise "AI Witness Report" for evidence. 
            If the image is blurry, describe what you *can* make out.
            Be professional, direct, and factual.
        `;

        // Handle base64
        const imageData = image.split(',')[1] || image;
        
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageData, mimeType: "image/jpeg" } }
        ]);

        const analysis = result.response.text();

        res.json({
            success: true,
            analysis: analysis,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("AI Visual Guardian error:", err);
        res.status(500).json({ error: "Analysis failed" });
    }
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

    const smsUpdate = `\ud83d\udea8 LIVE UPDATE #${session.updateCount}\n\n\ud83d\udccd Location: ${maps}\n\n\ud83d\udcf9 LIVE Tracking + Video:\n${track}\n\n\u23f0 ${time} \u2014 Emergency ACTIVE. Call them NOW!`;

    // Fire all updates in parallel
    Promise.all(session.contacts.map(c => {
      const tasks = [];

      // 1. SMS update
      const cleanPhone = c.phone.replace('+91', '').replace(/\s/g, '');
      if (process.env.FAST2SMS_API_KEY) {
        tasks.push(
          axios.post('https://www.fast2sms.com/dev/bulkV2', {
            "message": smsUpdate,
            "language": "english",
            "route": "q",
            "numbers": cleanPhone,
          }, {
            headers: { "authorization": process.env.FAST2SMS_API_KEY }
          })
          .then(() => console.log(`📡 Live SMS (Fast2SMS) #${session.updateCount} → ${c.phone}`))
          .catch(e => {
            console.error(`❌ Live SMS (Fast2SMS) error: ${e.message}`);
            // Fallback to Twilio for live update
            return client.messages.create({ body: smsUpdate, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone })
              .then(() => console.log(`📡 Live SMS (Twilio Fallback) #${session.updateCount} → ${c.phone}`));
          })
        );
      } else {
        tasks.push(
          client.messages.create({ body: smsUpdate, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone })
            .then(() => console.log(`📡 Live SMS #${session.updateCount} → ${c.phone}`))
            .catch(e => console.error(`❌ Live SMS error: ${e.message}`))
        );
      }

      // 2. WhatsApp update - include tracking + video link
      const waUpdateText = `🚨 *LIVE UPDATE #${session.updateCount}*\n\n📍 *Location:* ${maps}\n\n📹 *LIVE Tracking + Video Evidence:*\n${track}\n\n⏰ ${time} — Emergency ACTIVE!`;
      const waPayload = {
        body: waUpdateText,
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER}`,
        to: `whatsapp:${c.phone}`
      };

      tasks.push(
        client.messages.create(waPayload)
          .then(() => console.log(`📡 Live WA #${session.updateCount} → ${c.phone}`))
          .catch(e => console.error(`❌ Live WA error: ${e.message}`))
      );

      // 3. Push notification
      if (c.fcmToken) {
        tasks.push(
          admin.messaging().send({
            token: c.fcmToken,
            notification: { title: `📍 Live Update #${session.updateCount}`, body: `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` },
            data: { url: track }
          }).catch(() => {})
        );
      }

      return tasks;
    }).flat());

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
    I am SafeHer. Emergency Alert! Emergency Alert!
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
      I am SafeHer. How can I help? You can say things like harassment, being followed, kidnapping, or ask for defense tips.
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
  
  if (speechResult.includes("harass") || speechResult.includes("bad touch") || speechResult.includes("comment")) {
    message = "You are strong and you are not alone. SafeHer is with you. Stay confident! First: Speak loudly and firmly—say STOP! You are harassing me! Second: Draw immediate public attention. For defense: If grabbed, use a palm strike to their nose or a knee to the groin. Rotate your wrist towards their thumb to break a grip. Move to a safe, crowded area immediately. Help is being notified.";
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
  const { latitude, longitude, accuracy, senderName, senderPhone, videoUrl, message } = req.body;

  contacts = loadContacts();

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'Location required' });
  }

  const activeContacts = contacts.filter(c => c.enabled !== false);

  if (activeContacts.length === 0) {
    return res.status(400).json({ error: 'No active contacts enabled. Please add and enable a guardian first.' });
  }

  const sessionId = createSession(activeContacts);
  const agoraChannel = `SafeHer_Video_${sessionId.substring(0, 8)}_${Math.random().toString(36).substring(7)}`;

  const session = sessions.get(sessionId);
  session.lat = latitude;
  session.lng = longitude;
  session.accuracy = accuracy;
  session.agoraChannel = agoraChannel;
  session.videoUrl = videoUrl; // Store video URL for live updates

  const displaySender = senderName || 'SafeHer User';
  const maps = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const baseUrl = process.env.PUBLIC_URL || 'https://safeher-1fb18.web.app';
  const trackUrl = `${baseUrl}/track.html?id=${sessionId}`;
  const timestamp = new Date().toLocaleString('en-IN');

  const twimlXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">I am SafeHer. Emergency Alert! ${displaySender} has activated SOS and needs help immediately. A live tracking link with video evidence is being sent to your phone. Please check your messages and call them back right now. If unreachable call 1 1 2 for police.</Say></Response>`;

  console.log(`\xf0\x9f\x9a\xa8 SOS Hybrid Mode — Sending Calls via Twilio, SMS will be handled by UI`);

  // ✅ START LIVE UPDATES (Optional: keep background updates if you want automated tracking)
  startLiveUpdates(sessionId);

  // Send response first so UI can trigger native SMS immediately
  res.json({
    success: true,
    sessionId,
    mapsLink: maps,
    trackUrl,
    agoraChannel: agoraChannel,
    contacts: activeContacts,
    totalSent: activeContacts.length,
    timestamp
  });

  // ⚡ DISPATCH TWILIO CALLS & SMS IN BACKGROUND
  const tasks = activeContacts.flatMap(c => {
    const list = [];
    
    // 📞 VOICE CALL via Twilio (Hard to ignore, high priority)
    list.push(
      client.calls.create({ twiml: twimlXml, to: c.phone, from: process.env.TWILIO_PHONE_NUMBER })
        .then(() => console.log(`✅ Call → ${c.name} (${c.phone})`))
        .catch(e => console.error(`❌ Call → ${c.name}: ${e.message}`))
    );

    // 📩 SMS via Fast2SMS (Primary Automated SMS)
    const smsMessage = message 
        ? `${message}\n\n📍 Location: ${maps}\n\n📹 LIVE Tracking + Video Evidence:\n${trackUrl}`
        : `🚨 SOS ALERT from ${displaySender}!\n\nI need help NOW!\n\n📍 Location: ${maps}\n\n📹 LIVE Tracking + Video Evidence:\n${trackUrl}\n\n⚠️ Call me immediately or dial 112! - SafeHer`;
    
    if (process.env.FAST2SMS_API_KEY) {
        list.push(
            axios.post('https://www.fast2sms.com/dev/bulkV2', {
                "message": smsMessage,
                "language": "english",
                "route": "q",
                "numbers": c.phone.replace('+91', ''),
            }, {
                headers: { "authorization": process.env.FAST2SMS_API_KEY }
            })
            .then(() => console.log(`✅ Fast2SMS → ${c.name} (${c.phone})`))
            .catch(e => {
                const errorDetail = e.response ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Fast2SMS Failed for ${c.phone}:`, errorDetail);
                console.log(`🔄 Attempting Twilio Fallback for ${c.phone}...`);
                return client.messages.create({ body: smsMessage, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone });
            })
        );
    } else {
        list.push(
            client.messages.create({ body: smsMessage, from: process.env.TWILIO_PHONE_NUMBER, to: c.phone })
                .then(() => console.log(`✅ SMS → ${c.name} (${c.phone})`))
                .catch(e => console.error(`❌ SMS → ${c.name}: ${e.message}`))
        );
    }

    // 💬 WhatsApp via Twilio (Automated)
    const waMessage = message 
        ? `${message}\n\n📍 Location: ${maps}\n\n📹 *LIVE Tracking + Video Evidence:*\n${trackUrl}`
        : `🚨 *SOS ALERT from ${displaySender}!*\n\nI need help NOW!\n\n📍 *Location:* ${maps}\n\n📹 *LIVE Tracking + Video Evidence:*\n${trackUrl}\n\n⚠️ Call me immediately or dial 112!\n_Sent via SafeHer_`;
    
    const waPayload = { 
      body: waMessage, 
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER}`, 
      to: `whatsapp:${c.phone}` 
    };
    
    // Include video if provided
    if (videoUrl) {
      waPayload.mediaUrl = [videoUrl];
    }

    list.push(
      client.messages.create(waPayload)
        .then(() => console.log(`✅ WA → ${c.name} (${c.phone})`))
        .catch(e => console.error(`❌ WA → ${c.name}: ${e.message}`))
    );

    // 🔔 PUSH NOTIFICATION (FCM - Free)
    if (c.fcmToken) {
      list.push(
        admin.messaging().send({
          token: c.fcmToken,
          notification: { title: `🚨 SOS ALERT!`, body: `${displaySender} needs help NOW!` },
          data: { url: `https://safeher-1fb18.web.app/track.html?id=${sessionId}` }
        }).catch(() => {})
      );
    }
    return list;
  });

  // Also call and message the sender if it's a timer expiration or user number update
  if (senderPhone) {
      const formattedPhone = (senderPhone.startsWith('+')) ? senderPhone : '+91' + senderPhone;
      
      // Call sender
      tasks.push(
          client.calls.create({ 
              twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">I am SafeHer. This is an emergency check-in. Your SOS has been triggered and your guardians are being notified. Stay confident, you are strong. Help is coming.</Say></Response>`, 
              to: formattedPhone, 
              from: process.env.TWILIO_PHONE_NUMBER 
          }).catch(() => {})
      );

      // SMS to sender
      if (process.env.FAST2SMS_API_KEY) {
          tasks.push(
              axios.post('https://www.fast2sms.com/dev/bulkV2', {
                  "message": `🚨 SOS TRIGGERED! Guardians alerted. Location: ${maps}`,
                  "language": "english",
                  "route": "q",
                  "numbers": formattedPhone.replace('+91', ''),
              }, {
                  headers: { "authorization": process.env.FAST2SMS_API_KEY }
              }).catch(() => {})
          );
      } else {
          tasks.push(
              client.messages.create({ 
                  body: `🚨 SOS TRIGGERED! We are alerting your guardians with your location:\n${maps}`, 
                  to: formattedPhone, 
                  from: process.env.TWILIO_PHONE_NUMBER 
              }).catch(() => {})
          );
      }

      // WhatsApp to sender
      const waSenderPayload = { 
          body: `🚨 SOS TRIGGERED! We are alerting your guardians with your location:\n${maps}`, 
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER}`, 
          to: `whatsapp:${formattedPhone}` 
      };
      
      if (videoUrl) {
          waSenderPayload.mediaUrl = [videoUrl];
      }

      tasks.push(
          client.messages.create(waSenderPayload).catch(() => {})
      );
  }

  await Promise.all(tasks);
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
    if (process.env.FAST2SMS_API_KEY) {
        await axios.post('https://www.fast2sms.com/dev/bulkV2', {
            "message": message,
            "language": "english",
            "route": "q",
            "numbers": phone.replace('+91', ''),
        }, {
            headers: { "authorization": process.env.FAST2SMS_API_KEY }
        });
        console.log(`✅ Chat SOS (Fast2SMS) → ${phone}`);
    } else {
        await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone
        });
        console.log(`✅ Chat SOS (Twilio) → ${phone}`);
    }
    res.json({ success: true, to: phone });
  } catch (err) {
    console.error('Chat SOS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==============================
// 💬 CHAT API — Gemini AI-Powered Safety Advisor
// ==============================
const SAFEHER_SYSTEM_PROMPT = `You are SafeHer AI — an expert women's safety advisor built into an emergency protection app used in India.

Your role:
- Provide actionable, specific safety advice for women in danger or at risk
- Give practical self-defense techniques with clear step-by-step instructions
- Share relevant Indian legal rights, IPC sections, helpline numbers
- Be empathetic but direct — in emergencies, clarity saves lives
- Give situation-specific escape plans, not generic advice
- If the user seems in immediate danger, ALWAYS start with: "TAP THE SOS BUTTON NOW" 

Key rules:
1. Keep responses under 300 words — concise and scannable
2. Use numbered steps and emoji bullets for readability
3. Always include at least one relevant helpline number
4. If asked in Hindi/Telugu/Tamil, respond in that language
5. Never say "I'm just an AI" or refuse safety questions — you are a lifeline
6. Include practical self-defense moves when relevant
7. Mention SafeHer app features when relevant (SOS button, shake detection, live tracking, fake call, journey timer)
8. For legal questions, cite specific Indian laws (IPC sections, POSH Act, DV Act, POCSO)
9. For location-specific queries about Hyderabad, mention SHE Teams (9490617111) and Bharosa Centre (040-23320999)

Key emergency numbers:
- All Emergency: 112
- Police: 100 
- Women Helpline: 1091
- Women Commission: 181
- Ambulance: 102
- Cyber Crime: 1930
- SHE Teams HYD: 9490617111
- Bharosa Centre HYD: 040-23320999
- iCall Counseling: 9152987821
- ChildLine: 1098

You are NOT a generic chatbot. You are a trained safety expert. Every response could save a life.`;

// Conversation history per session (in-memory, resets on server restart)
const chatSessions = new Map();

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  // ─── TRY GEMINI AI FIRST ───
  if (geminiModel) {
    try {
      // Get or create chat session for conversation memory
      const chatId = sessionId || 'default';
      if (!chatSessions.has(chatId)) {
        chatSessions.set(chatId, geminiModel.startChat({
          history: [
            { role: 'user', parts: [{ text: 'System instruction: ' + SAFEHER_SYSTEM_PROMPT }] },
            { role: 'model', parts: [{ text: 'Understood. I am SafeHer AI, ready to provide expert women\'s safety guidance. How can I help you stay safe?' }] }
          ],
        }));
      }

      const chat = chatSessions.get(chatId);
      const result = await chat.sendMessage(message);
      const answer = result.response.text();

      console.log(`🧠 Gemini Chat: "${message.substring(0, 50)}..." → ${answer.substring(0, 80)}...`);
      return res.json({ success: true, answer, source: 'gemini' });
    } catch (err) {
      console.error('❌ Gemini AI error:', err.message);
      // Fall through to keyword fallback
    }
  }

  // ─── KEYWORD FALLBACK (Used when Gemini is unavailable) ───
  const input = message.toLowerCase();
  let answer = "";

  if (input.includes("harass") || input.includes("bad touch")) {
    answer = "You are strong and you are not alone. SafeHer is with you! Stay confident. 1. Speak loudly and firmly—say 'STOP! You are harassing me!' 2. Draw immediate public attention. 3. For defense: If grabbed, use a palm strike to the nose or a knee to the groin. Rotate your wrist towards their thumb to break a grip. Move to a safe, crowded area immediately.";
  } else if (input.includes("follow")) {
    answer = "Being followed? Do NOT go home. Enter the nearest busy shop or police station. Change direction 3 times to confirm. Call family now. For defense: use an elbow strike to the ribs and scream 'FIRE' to attract attention.";
  } else if (input.includes("defense") || input.includes("fight") || input.includes("help")) {
    answer = "SELF DEFENSE TIPS: 1. Palm strike to nose. 2. Knee to groin. 3. Elbow to ribs. 4. Eye jab. 5. Heel stomp on foot. Your goal is to escape, not win. Strike hard, then run!";
  } else {
    answer = "I am SafeHer, your safety assistant. I can help with harassment, being followed, or self-defense tips. What's happening?";
  }

  res.json({ success: true, answer, source: 'fallback' });
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
  s.updatedAt = new Date().toISOString();

  res.json({ success: true });
});

// GET TRACKING DATA
app.get('/api/track/:id', (req, res) => {
  const { id } = req.params;
  const s = sessions.get(id);

  if (!s) return res.status(404).json({ error: 'Session not found', expired: true });

  res.json({
    lat: s.lat,
    lng: s.lng,
    accuracy: s.accuracy,
    updatedAt: s.updatedAt,
    agoraChannel: s.agoraChannel,
    expired: false
  });
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
