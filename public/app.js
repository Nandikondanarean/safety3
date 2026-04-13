/* ═══════════════════════════════════════════════════════
   SAFEHER — App Logic
   ═══════════════════════════════════════════════════════ */

// AUTO-DETECT API BASE URL
function getBestApiUrl() {
    const host = window.location.hostname;
    // 1. Local Development (Computer)
    if (host === 'localhost' || host === '127.0.0.1') return '';
    
    // 2. Local Network (Testing on phone via computer IP)
    if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return '';
    
    // 3. Capacitor / Mobile App fallback
    if (window.location.protocol === 'file:' || window.location.protocol === 'capacitor:') {
        return 'https://safety-awx4.onrender.com'; // Your New Production Render URL
    }

    // 4. Production Hosting (Firebase)
    if (host.includes('safeher-1fb18') || host.includes('web.app')) {
        return 'https://safety-awx4.onrender.com'; // Production Render API
    }
    
    return '';
}
const API_BASE_URL = getBestApiUrl();

// ─── FIREBASE CONFIGURATION ─────────────────────────────
// TODO: REPLACE WITH YOUR ACTUAL FIREBASE CONFIG FROM CONSOLE
const firebaseConfig = {
    apiKey: "AIzaSyD4wskB-DCtWhdOlft6sZ5mCreyeORu9k8",
    authDomain: "safeher-1fb18.firebaseapp.com",
    projectId: "safeher-1fb18",
    storageBucket: "safeher-1fb18.firebasestorage.app",
    messagingSenderId: "717418341821",
    appId: "1:717418341821:web:6413b5f28ec7140bbe9ed4",
    measurementId: "G-9RQKQGKC8X"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
} else {
    console.error("Firebase SDK not loaded. Check index.html.");
}

let currentLocation = { lat: null, lng: null, accuracy: null };
let contacts = [];
let myFcmToken = null; // Store current device token
let shakeEnabled = false, voiceEnabled = false, trackingEnabled = false, recordingActive = false;
let shakeCount = 0, lastShakeTime = 0, shakePeakAcc = 0;
let mediaRecorder = null, recordedChunks = [];
let trackingInterval = null, recognition = null;
let voiceAgentActive = false, agentRecognition = null;
let voiceRestartTimer = null, voiceRestartDelay = 500;
let sosCooldown = false; // prevent duplicate SOS triggers
let stressWordBuffer = []; // sliding window for stress detection
let lastStressCheckTime = 0;

// ─── LIVE LOCATION PUSH ─────────────────────────────────
let activeLiveSessionId = null; // current SOS session
let liveLocationPushInterval = null; // interval ID for GPS push

function startLiveLocationPush(sessionId) {
  stopLiveLocationPush(); // clear any previous
  activeLiveSessionId = sessionId;
  // Push immediately, then every 5 seconds
  pushLiveLocation(sessionId);
  liveLocationPushInterval = setInterval(() => pushLiveLocation(sessionId), 5000);
}

function stopLiveLocationPush() {
  if (liveLocationPushInterval) {
    clearInterval(liveLocationPushInterval);
    liveLocationPushInterval = null;
  }
  activeLiveSessionId = null;
}

async function pushLiveLocation(sessionId) {
  if (!sessionId) return;
  try {
    // Always get fresh GPS coords when pushing live location
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      });
    });
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    // Update local state
    currentLocation.lat = lat;
    currentLocation.lng = lng;
    currentLocation.accuracy = accuracy;
    updateLocationUI();

    // Push to server session
    await fetch(`${API_BASE_URL}/api/live-location/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, accuracy })
    });
    addLog('info', `📡 Live GPS pushed: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  } catch (err) {
    // Use cached coords if GPS fails
    if (currentLocation.lat && currentLocation.lng && sessionId) {
      try {
        await fetch(`${API_BASE_URL}/api/live-location/${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: currentLocation.lat, lng: currentLocation.lng, accuracy: currentLocation.accuracy })
        });
      } catch (e) { /* ignore */ }
    }
  }
}

// Removed immediate permission modal call to wait for Firebase Auth state

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    init3DBackground();
    initNavigation();
    initContactForm();
    loadContacts(); // Initial load
    
    // 🔄 REAL-TIME AUTO-SYNC: Poll for contact updates every 5 seconds
    setInterval(loadContacts, 5000);

    initShakeDetection();
    updateRiskAssessment();
    initKeyboardShortcuts();
    initSafetyChat();
    initNotifications(); // 🔔 Start the notification setup
});


// ─── 🔔 FIREBASE NOTIFICATIONS (FREE SOS) ──────────────
async function initNotifications() {
    if (!('serviceWorker' in navigator)) return;
    
    try {
        const messaging = firebase.messaging();
        
        // 1. Request Permission
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('Notification permission granted.');
            
            // 2. Get the FREE device token
            const token = await messaging.getToken({ 
                vapidKey: "BAptb6fTe8ZDF9TYmydb_A0g8B1NFJwU7NmmwRBi4HulXDTTxMhzaDgd7FTrvOaLgHToWRwd_X4Hcr-srCUsO9Q" 
            });
            
            if (token) {
                console.log('FCM Token:', token);
                myFcmToken = token;
                // Optional: Store the token for the user/current session
                localStorage.setItem('safeher_fcm_token', token);
            }
        }
    } catch (err) {
        console.error('Error setting up notifications:', err);
    }
}


function initAuth() {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');

    // Monitor Auth State
    firebase.auth().onAuthStateChanged(user => {
        if (user) {
            console.log("User logged in:", user.email);
            const userData = { 
                email: user.email, 
                uid: user.uid, 
                name: user.displayName || user.email.split('@')[0] 
            };
            localStorage.setItem('safeher_user', JSON.stringify(userData));
            showApp();
        } else {
            console.log("No user logged in.");
            localStorage.removeItem('safeher_user');
            showAuth();
        }
    });

    loginForm?.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        setAuthError('');

        try {
            await firebase.auth().signInWithEmailAndPassword(email, password);
        } catch (err) {
            setAuthError(err.message || 'Login failed');
        }
    });

    signupForm?.addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('signup-name').value;
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;
        setAuthError('');

        try {
            const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
            // Optionally update profile with name
            await userCredential.user.updateProfile({ displayName: name });
        } catch (err) {
            setAuthError(err.message || 'Signup failed');
        }
    });
}

function showApp() {
    const modal = document.getElementById('auth-modal');
    const appContent = document.getElementById('app-content');
    
    if (modal) {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 400);
    }
    
    if (appContent) {
        appContent.style.display = 'block';
        setTimeout(() => appContent.classList.remove('hidden-app'), 10);
    }
    
    // Once app is shown, ask for permissions if needed
    if (!localStorage.getItem('permissions_granted')) {
        showPermissionModal();
    }
}

function showAuth() {
    const modal = document.getElementById('auth-modal');
    const appContent = document.getElementById('app-content');
    
    if (modal) {
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    }
    
    if (appContent) {
        appContent.style.display = 'none';
        appContent.classList.add('hidden-app');
    }
}

function logout() {
    firebase.auth().signOut().then(() => {
        window.location.reload();
    });
}

function switchAuthTab(tab) {
    const loginTab = document.getElementById('tab-login');
    const signupTab = document.getElementById('tab-signup');
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');

    if (tab === 'login') {
        loginTab.classList.add('active');
        signupTab.classList.remove('active');
        loginForm.classList.add('active');
        signupForm.classList.remove('active');
    } else {
        signupTab.classList.add('active');
        loginTab.classList.remove('active');
        signupForm.classList.add('active');
        loginForm.classList.remove('active');
    }
}

function setAuthError(msg) {
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.textContent = msg;
}

function dismissAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) {
        modal.style.opacity = '0';
        modal.style.transition = 'opacity 0.4s ease';
        setTimeout(() => {
            modal.remove();
            showPermissionModal();
        }, 400);
    }
}

// ─── PERMISSION MODAL ──────────────────────────────────
function showPermissionModal() {
    const modal = document.getElementById('permission-modal');
    if (modal) modal.style.display = 'flex';
}

async function requestAllPermissions() {
    const btn = document.getElementById('grant-permissions-btn');
    btn.innerHTML = '⏳ Initializing...';
    btn.disabled = true;

    let gpsGranted = false;

    // Run ALL permissions in PARALLEL — no sequential waiting
    const permPromises = [];

    // 1. Geolocation (critical)
    if ('geolocation' in navigator) {
        permPromises.push(
            new Promise(resolve => {
                navigator.geolocation.getCurrentPosition(
                    pos => {
                        currentLocation.lat = pos.coords.latitude;
                        currentLocation.lng = pos.coords.longitude;
                        currentLocation.accuracy = pos.coords.accuracy;
                        gpsGranted = true;
                        markPermGranted('perm-gps', 'perm-gps-status', '✅ Granted');
                        resolve();
                    },
                    () => {
                        markPermDenied('perm-gps', 'perm-gps-status', '❌ Denied');
                        resolve();
                    },
                    { enableHighAccuracy: true, timeout: 5000 } // Reduced from 8s to 5s
                );
            })
        );
    }

    // 2. Microphone (optional)
    if (navigator.mediaDevices) {
        permPromises.push(
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    stream.getTracks().forEach(t => t.stop());
                    markPermGranted('perm-mic', 'perm-mic-status', '✅ Granted');
                    updateCheckStatus('check-mic', '✅');
                })
                .catch(() => markPermDenied('perm-mic', 'perm-mic-status', '⚠️ Skipped'))
        );
    }

    // 3. Notifications (optional)
    if ('Notification' in window) {
        permPromises.push(
            Notification.requestPermission()
                .then(result => {
                    if (result === 'granted') markPermGranted('perm-notif', 'perm-notif-status', '✅ Granted');
                    else markPermDenied('perm-notif', 'perm-notif-status', '⚠️ Skipped');
                })
                .catch(() => markPermDenied('perm-notif', 'perm-notif-status', '⚠️ Skipped'))
        );
    }

    // Wait for all to settle simultaneously — no artificial delay
    await Promise.allSettled(permPromises);

    dismissPermissionModal();
    if (gpsGranted) {
        updateLocationUI();
        startWatchingLocation();
    } else {
        initLocation();
    }
}

function markPermGranted(itemId, statusId, text) {
    document.getElementById(itemId)?.classList.add('granted');
    const s = document.getElementById(statusId);
    if (s) { s.textContent = text; s.style.background = 'rgba(0,245,212,0.15)'; s.style.color = '#00f5d4'; }
}
function markPermDenied(itemId, statusId, text) {
    const s = document.getElementById(statusId);
    if (s) { s.textContent = text; s.style.background = 'rgba(251,86,7,0.12)'; s.style.color = '#fb5607'; }
}

function skipPermissions() {
    dismissPermissionModal();
    initLocation();
}

function dismissPermissionModal() {
    localStorage.setItem('permissions_granted', 'true');
    const modal = document.getElementById('permission-modal');
    if (modal) {
        modal.style.opacity = '0';
        modal.style.transform = 'scale(0.95)';
        modal.style.transition = 'all 0.2s ease';
        setTimeout(() => modal.remove(), 200);
    }
    showLoadingThenApp();
}

function showLoadingThenApp() {
    const ls = document.getElementById('loading-screen');
    if (ls) {
        ls.style.display = 'flex';
        ls.classList.remove('hidden');
        // ULTRA Short snappy loading — 250ms (reduced from 600ms)
        setTimeout(() => ls.classList.add('hidden'), 250);
    }
}

// ─── LOCATION ──────────────────────────────────────────
function initLocation() {
    if ('geolocation' in navigator) {
        getLocation();
        startWatchingLocation();
    } else {
        showToast('Geolocation not supported', 'error');
        updateCheckStatus('check-gps', '❌');
    }
}

async function startWatchingLocation() {
    // If Capacitor is available, use native high-performance GPS
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        try {
            const { Geolocation } = window.Capacitor.Plugins;
            const watchId = await Geolocation.watchPosition({
                enableHighAccuracy: true,
                timeout: 5000
            }, (position, err) => {
                if (position) {
                    currentLocation.lat = position.coords.latitude;
                    currentLocation.lng = position.coords.longitude;
                    currentLocation.accuracy = position.coords.accuracy;
                    updateLocationUI();
                    updateCheckStatus('check-gps', '✅');
                    document.getElementById('gps-status').innerHTML = '<span class="status-indicator active"></span> Active (Native)';
                    document.getElementById('stat-location').textContent = 'Native Active';
                }
            });
            return;
        } catch (e) { console.error('Capacitor Geolocation error:', e); }
    }

    // Fallback: browser navigator.geolocation
    navigator.geolocation.watchPosition(
        pos => {
            currentLocation.lat = pos.coords.latitude;
            currentLocation.lng = pos.coords.longitude;
            currentLocation.accuracy = pos.coords.accuracy;
            updateLocationUI();
            updateCheckStatus('check-gps', '✅');
            document.getElementById('gps-status').innerHTML = '<span class="status-indicator active"></span> Active';
            document.getElementById('stat-location').textContent = 'Active';
        },
        err => { updateCheckStatus('check-gps', '❌'); document.getElementById('stat-location').textContent = 'Error'; },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 }
    );
}

function getLocation() {
    return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            pos => {
                currentLocation.lat = pos.coords.latitude;
                currentLocation.lng = pos.coords.longitude;
                currentLocation.accuracy = pos.coords.accuracy;
                updateLocationUI();
                resolve(pos);
            },
            err => {
                document.getElementById('loc-lat').textContent = 'Permission denied';
                document.getElementById('loc-lng').textContent = 'Enable GPS';
                showToast('Please enable location access for SOS', 'warning');
                reject(err);
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

async function refreshLocation() {
    document.getElementById('loc-lat').textContent = 'Refreshing...';
    document.getElementById('loc-lng').textContent = '...';
    await getLocation();
    showToast('📍 Location refreshed', 'info');
}

function updateLocationUI() {
    if (currentLocation.lat && currentLocation.lng) {
        document.getElementById('loc-lat').textContent = currentLocation.lat.toFixed(6);
        document.getElementById('loc-lng').textContent = currentLocation.lng.toFixed(6);
        document.getElementById('loc-accuracy').textContent = Math.round(currentLocation.accuracy) + 'm';
        document.getElementById('loc-time').textContent = new Date().toLocaleTimeString('en-IN');
        const mapUrl = `https://maps.google.com/maps?q=${currentLocation.lat},${currentLocation.lng}&z=16&output=embed`;
        document.getElementById('map-iframe').src = mapUrl;
    }
}

// ─── NAVIGATION ────────────────────────────────────────
function initNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => { e.preventDefault(); navigateToSection(link.dataset.section); });
    });
}

function navigateToSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
    const section = document.getElementById(sectionId);
    if (section) section.classList.add('active');
    document.querySelector(`.nav-link[data-section="${sectionId}"]`)?.classList.add('active');
    document.querySelector(`.mobile-nav-btn[data-section="${sectionId}"]`)?.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── CONTACTS ──────────────────────────────────────────
function initContactForm() {
    document.getElementById('contact-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('contact-name').value.trim();
        const phone = document.getElementById('contact-phone').value.trim();
        const relationship = document.getElementById('contact-relationship').value;
        if (!name || !phone) { showToast('Please fill in name and phone', 'warning'); return; }
        const btn = document.getElementById('add-contact-btn');
        btn.disabled = true; btn.innerHTML = '⏳ Adding...';
        try {
            const res = await fetch(`${API_BASE_URL}/api/contacts`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ name, phone, relationship, fcmToken: myFcmToken }) 
            });
            
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            const data = await res.json();
            if (data.success) {
                contacts.push(data.contact);
                renderContacts();
                document.getElementById('contact-form').reset();
                showToast(`✅ ${name} added as guardian`, 'success');
                addLog('success', `Guardian added: ${name} (${data.contact.phone})`);
            } else { 
                showToast(data.error || 'Failed to add contact', 'error'); 
            }
        } catch (err) { 
            console.error('Contact error:', err);
            showToast(`Server issue: ${err.message}. Ensure your server is running and reachable.`, 'error'); 
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Guardian`;
        }
    });
}

async function loadContacts() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/contacts`);
        const data = await res.json();
        contacts = data.contacts || [];
        renderContacts();
    } catch (err) { console.log('Could not load contacts'); }
}

function renderContacts() {
    const list = document.getElementById('contacts-list');
    const count = contacts.length;
    document.getElementById('contact-count').textContent = count;
    document.getElementById('stat-contacts').textContent = count;
    document.getElementById('sos-contact-count').textContent = count;
    updateCheckStatus('check-contacts', count > 0 ? '✅' : '⚠️');
    if (count === 0) {
        list.innerHTML = `<div class="empty-contacts"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="rgba(255,133,161,0.2)" stroke-width="1"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg><p>No guardians added yet</p><span>Add your first emergency contact to get started</span></div>`;
        return;
    }
    list.innerHTML = contacts.map(c => `
        <div class="contact-card ${c.enabled === false ? 'disabled-contact' : ''}" id="contact-${c.id}">
            <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
            <div class="contact-info">
                <div class="contact-name">${escapeHtml(c.name)}</div>
                <div class="contact-phone">${escapeHtml(c.phone)}</div>
            </div>
            <span class="contact-badge">${escapeHtml(c.relationship)}</span>
            <div class="contact-actions">
                <div class="perm-toggle-wrapper" title="Enable/Disable Alert">
                    <input type="checkbox" id="toggle-${c.id}" class="perm-checkbox" ${c.enabled !== false ? 'checked' : ''} onchange="toggleContactEnabled('${c.id}')">
                    <label for="toggle-${c.id}" class="perm-toggle-label"></label>
                </div>
                <button class="contact-action-btn" onclick="deleteContact('${c.id}','${escapeHtml(c.name)}')" title="Remove">✕</button>
            </div>
        </div>`).join('');
}

async function toggleContactEnabled(id) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/contacts/${id}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            const contact = contacts.find(c => c.id === id);
            if (contact) contact.enabled = data.enabled;
            renderContacts();
            showToast(data.enabled ? '🔔 Alert enabled for contact' : '🔕 Alert disabled for contact', 'info');
        }
    } catch (err) { showToast('Failed to update permission', 'error'); }
}

async function deleteContact(id, name) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/contacts/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { contacts = contacts.filter(c => c.id !== id); renderContacts(); showToast(`Removed ${name}`, 'info'); addLog('warning', `Guardian removed: ${name}`); }
    } catch (err) { showToast('Failed to remove contact', 'error'); }
}

// ─── SOS — ALWAYS FETCHES FRESH GPS ────────────────────
async function triggerSOS(method = 'manual') {
    if (contacts.length === 0) { showToast('⚠️ Add emergency guardians first!', 'warning'); navigateToSection('contacts'); return; }

    // Removed the blocking alert() for speed — the visual overlay provides enough feedback
    const overlay = document.getElementById('sos-alert-overlay');
    overlay.classList.remove('hidden');
    document.getElementById('sos-alert-msg').textContent = '🚨 TRIGGERING SOS IMMEDIATELY...';
    document.getElementById('sos-alert-bar').style.width = '10%';
    document.getElementById('sos-alert-result').innerHTML = '';
    document.getElementById('close-sos-alert').style.display = 'none';

    const sosBtn = document.getElementById('sos-btn');
    sosBtn.classList.add('activated');
    addLog('sos', `🚨 SOS triggered via ${method}! Dispatched instantly.`);

    // 🛡️ Update Shield Hub UI Status
    document.querySelectorAll('.shield-status').forEach(el => {
        el.textContent = 'ACTIVATE...';
        el.classList.remove('ready');
    });

    // ⚡ INITIAL SOS: Use cached location if available for zero-latency dispatch
    // We will still try to get a fresh fix, but we won't wait 10 seconds for it.
    let lat = currentLocation.lat;
    let lng = currentLocation.lng;
    let accuracy = currentLocation.accuracy;

    try {
        document.getElementById('sos-alert-bar').style.width = '30%';
        addLog('info', '🛰️ Requesting high-accuracy GPS update...');

        // Reduced timeout from 10s to 3s for the INITIAL message to ensure speed.
        // If it takes longer than 3s, we use the cached location and the background
        // update will refresh it automatically on the server side.
        const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 3000, 
                maximumAge: 0
            });
        });

        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        accuracy = pos.coords.accuracy;

        currentLocation.lat = lat;
        currentLocation.lng = lng;
        currentLocation.accuracy = accuracy;

        updateLocationUI();
        document.getElementById('sos-alert-msg').textContent = `📍 Precision Location Acquired! Sending...`;
        addLog('success', `🛰️ Precision Fix Acquired (±${Math.round(accuracy)}m)`);
    } catch (gpsErr) {
        if (lat && lng) {
            document.getElementById('sos-alert-msg').textContent = `📡 Dispatched via Cached GPS (High Priority)`;
            addLog('warning', 'Dispatching with last known coordinates (3s timeout reached)');
        } else {
            // Fallback: wait one more attempt if NO location exists at all
            document.getElementById('sos-alert-msg').textContent = '⚠️ Waiting for initial GPS fix...';
            try {
                const pos = await new Promise((r, j) => navigator.geolocation.getCurrentPosition(r, j, { enableHighAccuracy: true, timeout: 5000 }));
                lat = pos.coords.latitude; lng = pos.coords.longitude; accuracy = pos.coords.accuracy;
            } catch (e) {
                document.getElementById('sos-alert-msg').textContent = '❌ NO GPS SIGNAL! Move to window/outside.';
                document.getElementById('sos-alert-bar').style.width = '100%';
                document.getElementById('close-sos-alert').style.display = 'inline-flex';
                sosBtn.classList.remove('activated');
                return;
            }
        }
    }

    document.getElementById('sos-alert-bar').style.width = '60%';

    const user = JSON.parse(localStorage.getItem('safeher_user') || '{}');
    const senderName = user.name || 'SafeHer User';

    try {
        const res = await fetch(`${API_BASE_URL}/api/sos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                latitude: lat, 
                longitude: lng, 
                accuracy, 
                triggerMethod: method, 
                senderName,
                message: `🚨 EMERGENCY! I need help! Triggered via ${method}.` 
            })
        });
        const data = await res.json();
        document.getElementById('sos-alert-bar').style.width = '100%';
        if (data.success) {
            // ─── Start streaming live GPS to session ───────────────
            if (data.sessionId) {
                startLiveLocationPush(data.sessionId);
                addLog('success', `📡 Live GPS streaming started — auto SMS every 2 min`);
            }

            const mapsInfo = data.googleMapsLink
                ? `<div style="margin-top:10px;font-size:0.8rem;">
                     <span style="color:rgba(245,240,255,0.55);">📍 Sent to family:</span><br>
                     <a href="${data.googleMapsLink}" target="_blank"
                        style="color:#00f5d4;text-decoration:underline;word-break:break-all;">
                       ${data.googleMapsLink}
                     </a>
                   </div>`
                : '';

            document.getElementById('sos-alert-result').innerHTML =
                `<div style="color:#00f5d4;font-size:1rem;margin-bottom:6px;font-weight:700;">
                   ✅ SMS + CALL sent to ${data.totalSent} guardian(s)
                 </div>` +
                `${data.totalFailed > 0 ? `<div style="color:#ff6b6b;">❌ ${data.totalFailed} failed</div>` : ''}` +
                mapsInfo +
                `<div style="margin-top:10px;font-size:0.78rem;color:rgba(245,240,255,0.45);">
                   📐 GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}<br>
                   ⏰ ${data.timestamp}<br>
                   🔁 Updated Google Maps link will SMS auto-send every 2 minutes
                 </div>`;

            document.getElementById('sos-alert-msg').textContent = '🚨 SOS Active — Family is being updated!';
            data.results?.forEach(r => addLog('success', `SMS + Call → ${r.contact} (${r.phone})`));
            data.errors?.forEach(r => addLog('error', `Failed: ${r.contact} — ${r.error}`));
            showToast(`🚨 SOS sent! Family gets live location every 2 min`, 'success');

            // 🛡️ Finalize Shield Hub UI Status
            document.querySelectorAll('.shield-status').forEach(el => {
                el.textContent = 'ACTIVE';
                el.classList.add('active');
            });
        } else {
            document.getElementById('sos-alert-msg').textContent = 'SOS Failed';
            document.getElementById('sos-alert-result').innerHTML = `<div style="color:#ff6b6b;">${data.error}</div>`;
            showToast(data.error || 'SOS failed', 'error');
        }
    } catch (err) {
        document.getElementById('sos-alert-msg').textContent = 'Connection Error';
        document.getElementById('sos-alert-result').innerHTML = `<div style="color:#ff6b6b;">Could not reach server. Check connection.</div>`;
        showToast('Failed to send SOS. Server unreachable.', 'error');
        addLog('error', 'SOS failed: server unreachable');
    }
    document.getElementById('close-sos-alert').style.display = 'inline-flex';
    setTimeout(() => sosBtn.classList.remove('activated'), 2000);
}

function closeSOSAlert() {
    document.getElementById('sos-alert-overlay').classList.add('hidden');
    // NOTE: We intentionally do NOT stop live location push here.
    // Streaming continues in background for as long as SOS session is alive (2h).
    // User can manually stop via the activity log or by refreshing.
}

// ─── SHAKE DETECTION (Enhanced — iOS & Android) ────────
function initShakeDetection() {
    if ('DeviceMotionEvent' in window) {
        updateCheckStatus('check-sensors', '✅');
        // On Android, devicemotion works without permission — auto-start monitoring quietly
        if (typeof DeviceMotionEvent.requestPermission !== 'function') {
            // Non-iOS: just add a passive listener to keep sensors warm
            window.addEventListener('devicemotion', handleShake, { passive: true });
        }
    }
}

async function toggleShakeDetection() {
    shakeEnabled = !shakeEnabled;
    const btn = document.getElementById('shake-trigger'), status = document.getElementById('shake-trigger-status');
    if (shakeEnabled) {
        // iOS 13+ requires explicit permission for DeviceMotionEvent
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceMotionEvent.requestPermission();
                if (permission !== 'granted') {
                    showToast('⚠️ Motion permission denied. Shake SOS unavailable on this device.', 'warning');
                    shakeEnabled = false;
                    return;
                }
                window.addEventListener('devicemotion', handleShake, { passive: true });
            } catch (e) {
                showToast('⚠️ Could not request motion permission: ' + e.message, 'warning');
                shakeEnabled = false;
                return;
            }
        } else {
            // Android / desktop — already listening passively, just set flag
            window.addEventListener('devicemotion', handleShake, { passive: true });
        }
        btn.classList.add('active'); status.textContent = 'ON';
        document.getElementById('shake-status').innerHTML = '<span class="status-indicator active"></span> Active';
        shakeCount = 0; shakePeakAcc = 0;
        showToast('📳 Shake SOS ON — shake phone rapidly 5× to trigger SOS', 'success');
    } else {
        btn.classList.remove('active'); status.textContent = 'OFF';
        window.removeEventListener('devicemotion', handleShake);
        document.getElementById('shake-status').innerHTML = '<span class="status-indicator off"></span> Monitoring';
        shakeCount = 0;
        showToast('Shake detection disabled', 'info');
    }
}

function handleShake(event) {
    if (!shakeEnabled) return;
    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;
    const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
    const totalAcc = Math.sqrt(x * x + y * y + z * z);
    // Track peak acceleration for stress level display
    if (totalAcc > shakePeakAcc) shakePeakAcc = totalAcc;
    // Threshold: >20 m/s² is aggressive shake (gravity removed) or >28 with gravity included
    const threshold = event.accelerationIncludingGravity ? 28 : 18;
    if (totalAcc > threshold) {
        const now = Date.now();
        if (now - lastShakeTime < 1200) shakeCount++; else shakeCount = 1;
        lastShakeTime = now;
        // Show live progress feedback
        const statusEl = document.getElementById('shake-trigger-status');
        if (shakeCount >= 2 && shakeCount < 5 && statusEl) {
            statusEl.textContent = `${shakeCount}/5`;
        }
        if (shakeCount >= 5) {
            shakeCount = 0;
            if (statusEl) statusEl.textContent = '🚨';
            if (!sosCooldown) {
                sosCooldown = true;
                setTimeout(() => { sosCooldown = false; if (statusEl && shakeEnabled) statusEl.textContent = 'ON'; }, 12000);
                triggerSOS('shake-detection');
            }
        }
    }
}

// ─── VOICE DETECTION (Enhanced — Stress & Panic Analysis) ──

// Stress keyword tiers — weighted by urgency
const SOS_TIER1 = ['help me', 'save me', 'please help', 'bachao', 'madad karo', 'help karo']; // exact emergency phrases
const SOS_TIER2 = ['help', 'sos', 'emergency', 'danger', 'attack', 'attacked', 'scared', 'scream', 'run', 'fire', 'kidnap', 'bachao'];
const STRESS_WORDS = ['someone following', 'following me', 'harass', 'unsafe', 'stalking', 'scared', 'afraid', 'nervous', 'uncomfortable', 'threatening', 'please stop', 'leave me alone', 'dont touch', 'let me go'];

// Detect stress in speech: rapid repeated keywords = panic pattern
function analyzeVoiceStress(transcript) {
    const now = Date.now();
    const lower = transcript.toLowerCase().trim();
    
    // Push to rolling 10-second buffer
    stressWordBuffer.push({ text: lower, time: now });
    // Keep only last 10 seconds
    stressWordBuffer = stressWordBuffer.filter(e => now - e.time < 10000);
    
    // Count urgent words in the last 10 seconds
    const urgentCount = stressWordBuffer.filter(e =>
        SOS_TIER2.some(w => e.text.includes(w))
    ).length;
    
    // Rapid repetition of distress words = stress signal → SOS
    if (urgentCount >= 3) {
        addLog('sos', `🧠 Stress pattern: "${lower}" (${urgentCount}× in 10s)`);
        stressWordBuffer = []; // reset
        return 'stress-pattern';
    }
    
    return null;
}

function startVoiceRecognition() {
    if (!voiceEnabled || recognition) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    
    recognition = new SR();
    // Key settings for stable mobile listening:
    recognition.continuous = true;       // keep running without stopping
    recognition.interimResults = true;   // get partial results fast
    recognition.maxAlternatives = 1;
    recognition.lang = 'en-IN';          // Indian English + Hindi words like bachao
    
    let isProcessing = false;
    
    recognition.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        const transcript = last[0].transcript.toLowerCase().trim();
        const isFinal = last.isFinal;
        
        if (!transcript || transcript.length < 2) return;
        isProcessing = true;
        
        // Log only final results to avoid noise
        if (isFinal) addLog('info', `🎤 Heard: "${transcript}"`);
        
        // ── TIER 1: Exact emergency phrases → instant SOS ──────
        if (SOS_TIER1.some(w => transcript.includes(w))) {
            if (!sosCooldown) {
                sosCooldown = true;
                setTimeout(() => sosCooldown = false, 12000);
                addLog('sos', `🚨 Tier-1 Voice SOS: "${transcript}"`);
                fireVoiceSOS(transcript);
            }
            isProcessing = false;
            return;
        }
        
        // ── TIER 2: Single urgent keyword → SOS ─────────────
        if (SOS_TIER2.some(w => transcript.includes(w))) {
            if (!sosCooldown) {
                sosCooldown = true;
                setTimeout(() => sosCooldown = false, 12000);
                addLog('sos', `🚨 Tier-2 Voice SOS: "${transcript}"`);
                fireVoiceSOS(transcript);
            }
            isProcessing = false;
            return;
        }
        
        // ── STRESS ANALYSIS: Panic pattern detection ─────────
        const stressResult = analyzeVoiceStress(transcript);
        if (stressResult && !sosCooldown) {
            sosCooldown = true;
            setTimeout(() => sosCooldown = false, 12000);
            fireVoiceSOS(transcript);
            isProcessing = false;
            return;
        }
        
        // ── SITUATION TIPS (no SOS needed) ───────────────────
        if (isFinal && STRESS_WORDS.some(w => transcript.includes(w))) {
            const tip = 'I can hear you may be in distress. Here is what to do: Speak loudly and clearly to draw attention around you. Move to a crowded area immediately. Call 1091 Women Helpline. If physical threat: palm strike to nose, then run. Say HELP to trigger emergency SOS.';
            addLog('info', `🛡 Stress keyword: giving tips`);
            agentSpeak(tip);
        }
        
        isProcessing = false;
    };
    
    recognition.onerror = (e) => {
        console.warn('Voice recognition error:', e.error);
        if (!voiceEnabled) return;
        // 'no-speech' is normal — restart gracefully
        // 'aborted' & 'audio-capture' need a delay before restart
        const delay = (e.error === 'aborted' || e.error === 'audio-capture' || e.error === 'network') 
            ? Math.min(voiceRestartDelay * 2, 5000)
            : 800;
        voiceRestartDelay = delay;
        recognition = null;
        clearTimeout(voiceRestartTimer);
        voiceRestartTimer = setTimeout(() => startVoiceRecognition(), delay);
    };
    
    recognition.onend = () => {
        if (!voiceEnabled) return;
        // Normal end — restart immediately (continuous mode sometimes cuts out)
        recognition = null;
        clearTimeout(voiceRestartTimer);
        voiceRestartDelay = Math.max(voiceRestartDelay - 100, 400); // decay delay back to minimum
        voiceRestartTimer = setTimeout(() => startVoiceRecognition(), 400);
    };
    
    try {
        recognition.start();
        voiceRestartDelay = 500; // reset on successful start
    } catch (ex) {
        console.warn('Voice start failed:', ex);
        recognition = null;
        setTimeout(() => startVoiceRecognition(), 1000);
    }
}

function fireVoiceSOS(transcript) {
    triggerSOS('voice-detection');
    let sitMsg = 'SOS triggered. Your location has been sent to all your guardians. Help is on the way. Stay calm. Move towards a crowded well-lit area immediately.';
    if (transcript.includes('follow')) sitMsg += ' Do not go home. Enter the nearest open shop or police station.';
    else if (transcript.includes('harass') || transcript.includes('touch')) sitMsg += ' Speak loudly: Stop! You are harassing me! Draw public attention.';
    else if (transcript.includes('cab') || transcript.includes('car') || transcript.includes('uber')) sitMsg += ' If in unsafe vehicle, call someone and mention landmarks. Try to exit at a red light.';
    else if (transcript.includes('hit') || transcript.includes('beat') || transcript.includes('domestic')) sitMsg += ' Move toward the door. Call 112. You are protected under the Domestic Violence Act.';
    agentSpeak(sitMsg);
}

function toggleVoiceDetection() {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById('voice-trigger'), status = document.getElementById('voice-trigger-status');
    if (voiceEnabled) {
        if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
            showToast('Speech recognition not supported on this browser', 'error');
            voiceEnabled = false;
            return;
        }
        // Request microphone permission explicitly on mobile
        navigator.mediaDevices?.getUserMedia({ audio: true })
            .then(stream => {
                // Stop the test stream immediately after permission granted
                stream.getTracks().forEach(t => t.stop());
                btn.classList.add('active'); status.textContent = 'ON';
                updateCheckStatus('check-mic', '✅');
                document.getElementById('voice-status').innerHTML = '<span class="status-indicator active"></span> Listening';
                stressWordBuffer = [];
                voiceRestartDelay = 500;
                startVoiceRecognition();
                showToast('🎤 Voice SOS ON — say "help", "bachao", or describe your situation', 'success');
            })
            .catch(() => {
                // Fallback: try without explicit mic grant (desktop)
                btn.classList.add('active'); status.textContent = 'ON';
                stressWordBuffer = [];
                startVoiceRecognition();
                showToast('🎤 Voice SOS ON — say "help" or describe your situation', 'success');
            });
    } else {
        btn.classList.remove('active'); status.textContent = 'OFF';
        clearTimeout(voiceRestartTimer);
        if (recognition) { try { recognition.abort(); } catch(e) {} recognition = null; }
        updateCheckStatus('check-mic', '⏳');
        document.getElementById('voice-status').innerHTML = '<span class="status-indicator off"></span> Ready';
        stressWordBuffer = [];
        showToast('Voice detection disabled', 'info');
    }
}

// ─── TRACKING ──────────────────────────────────────────
function toggleContinuousTracking() {
    trackingEnabled = !trackingEnabled;
    const btn = document.getElementById('tracking-trigger'), status = document.getElementById('tracking-trigger-status');
    if (trackingEnabled) {
        if (contacts.length === 0) { showToast('Add guardians first for live tracking', 'warning'); trackingEnabled = false; return; }
        btn.classList.add('active'); status.textContent = 'ON';
        trackingInterval = setInterval(async () => {
            if (currentLocation.lat && currentLocation.lng) {
                try { await fetch(`${API_BASE_URL}/api/location-update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude: currentLocation.lat, longitude: currentLocation.lng, accuracy: currentLocation.accuracy }) }); addLog('info', '📡 Location update sent'); } catch (e) { addLog('warning', 'Failed to send location update'); }
            }
        }, 120000);
        showToast('📡 Live tracking ON — updates every 2 min', 'success');
    } else {
        btn.classList.remove('active'); status.textContent = 'OFF';
        if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
        showToast('Live tracking disabled', 'info');
    }
}

// ─── EVIDENCE ──────────────────────────────────────────
async function startEvidenceRecording() {
    const btn = document.getElementById('evidence-trigger'), status = document.getElementById('evidence-trigger-status');
    if (recordingActive) {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        recordingActive = false; btn.classList.remove('active'); status.textContent = 'OFF';
        document.getElementById('evidence-status').innerHTML = '<span class="status-indicator off"></span> Standby';
        showToast('Recording stopped and saved', 'info'); return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'environment' } });
        mediaRecorder = new MediaRecorder(stream); recordedChunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => { const blob = new Blob(recordedChunks, { type: 'video/webm' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `evidence_${Date.now()}.webm`; a.click(); stream.getTracks().forEach(t => t.stop()); };
        mediaRecorder.start(10000); recordingActive = true; btn.classList.add('active'); status.textContent = 'REC';
        document.getElementById('evidence-status').innerHTML = '<span class="status-indicator active"></span> Recording';
        showToast('🎥 Evidence recording started', 'success');
    } catch (err) { showToast('Camera/mic access denied: ' + err.message, 'error'); }
}

// ─── RISK ASSESSMENT ───────────────────────────────────
function updateRiskAssessment() {
    const hour = new Date().getHours();
    let riskLevel = 0, timeRisk = 'Low';
    if (hour >= 22 || hour <= 5) { riskLevel += 35; timeRisk = 'High'; }
    else if (hour >= 19 || hour <= 6) { riskLevel += 15; timeRisk = 'Medium'; }
    const riskFill = document.getElementById('risk-fill'), threatBadge = document.getElementById('threat-badge');
    riskFill.style.width = Math.min(riskLevel, 100) + '%';
    if (riskLevel < 25) { threatBadge.textContent = 'LOW'; threatBadge.className = 'dash-badge safe'; riskFill.style.background = 'linear-gradient(90deg,#00f5d4,#c77dff)'; }
    else if (riskLevel < 50) { threatBadge.textContent = 'MODERATE'; threatBadge.className = 'dash-badge warning'; riskFill.style.background = 'linear-gradient(90deg,#ffbe0b,#fb5607)'; }
    else { threatBadge.textContent = 'HIGH'; threatBadge.className = 'dash-badge danger'; riskFill.style.background = 'linear-gradient(90deg,#fb5607,#ff006e)'; }
    document.getElementById('time-risk').textContent = timeRisk;
    const trEl = document.getElementById('time-risk');
    trEl.style.color = timeRisk === 'High' ? '#ff006e' : timeRisk === 'Medium' ? '#fb5607' : '#00f5d4';
    updateAIAdvisor(riskLevel, hour);
    setTimeout(updateRiskAssessment, 300000);
}

function updateAIAdvisor(riskLevel, hour) {
    if (voiceAgentActive) return;
    const advisor = document.getElementById('ai-advisor');
    const msgs = [];
    if (hour >= 22 || hour <= 5) msgs.push({ icon: '🌙', text: 'It\'s late night. Extra caution recommended. Ensure your guardians are set up and GPS is active.', time: 'Risk Assessment' });
    if (contacts.length === 0) msgs.push({ icon: '⚠️', text: 'No emergency guardians configured! Add at least one contact for SOS to work.', time: 'Critical' });
    if (!currentLocation.lat) msgs.push({ icon: '📍', text: 'GPS not available. Enable location services for accurate SOS alerts.', time: 'Important' });
    if (riskLevel < 25 && contacts.length > 0 && currentLocation.lat) msgs.push({ icon: '✅', text: 'All systems operational. Your safety network is active. Stay safe!', time: 'System Check' });
    msgs.push({ icon: '♀', text: 'Tip: Share your live location before every journey. Trust your instincts — if something feels wrong, act immediately.', time: 'Advice' });
    advisor.innerHTML = msgs.map(m => `<div class="advisor-msg"><div class="advisor-avatar">${m.icon}</div><div class="advisor-text"><p>${m.text}</p><span class="advisor-time">${m.time}</span></div></div>`).join('');
}

// ─── KEYBOARD SHORTCUTS ────────────────────────────────
function initKeyboardShortcuts() {
    let powerPresses = 0, lastPP = 0;
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); triggerSOS('keyboard'); }
        if (e.key === 'p' || e.key === 'P') {
            const now = Date.now();
            if (now - lastPP < 500) powerPresses++; else powerPresses = 1;
            lastPP = now;
            if (powerPresses >= 5) { powerPresses = 0; triggerSOS('power-button'); }
        }
    });
}

// ─── CHATBOT — COMPREHENSIVE SAFETY TIPS WITH SELF-DEFENCE ────────────────────
const SAFETY_TIPS = {
    'being followed': [
        '🚶‍♀️ Do NOT go home — you will lead the stalker to your address.',
        '🏪 Enter the nearest busy store, restaurant, or petrol pump and stay inside.',
        '📸 Discreetly photograph the person following you as evidence.',
        '📞 Call a friend or family member and stay on call — your voice is your lifeline.',
        '🚔 Walk into the nearest police station or SHE Team patrol.',
        '🔄 Cross the street and change direction 2-3 times to confirm if being followed.',
        '🎤 Enable Voice SOS in SafeHer — say "help" or "bachao" if in danger.',
        '🚗 Board a bus or auto — public transport makes it harder to follow you.',
        '💪 SELF-DEFENCE: If grabbed from behind, stomp hard on their instep (top of foot), then drive your elbow backward into their ribs. This breaks the grip. Then spin, palm-strike the nose and RUN screaming.',
        '🥊 SELF-DEFENCE: Keep keys between your fingers as a weapon. If grabbed, rake the keys across their face hard and run immediately.',
        '📣 SELF-DEFENCE: Scream as loud as possible — "FIRE! HELP! CALL POLICE!" Fire gets faster response than assault calls.',
    ],
    'kidnapping or being grabbed': [
        '📍 Memorize surroundings immediately — landmarks, turns, sounds, smells.',
        '🎯 If grabbed, make as much noise as possible — scream "FIRE!", bite, scratch hard.',
        '🚗 If forced into a car, try to attract attention at traffic lights. Open window, bang on glass, shout.',
        '🔓 Never let them take you to a second location — survival rate drops 90%. Resist at first location.',
        '💡 Appear cooperative at first if outnumbered, then take the first escape opportunity.',
        '📱 Tap SOS button immediately if still holding your phone — every second counts.',
        '🧴 Leave DNA evidence — scratch them, leave hair, jewelry or clothing behind.',
        '🛑 If locked in a car boot, look for emergency release cable (yellow handle near tail lights).',
        '💪 SELF-DEFENCE: Bite as hard as possible on any exposed skin — aim for the ear, nose, finger. This creates immediate serious pain.',
        '🥊 SELF-DEFENCE: Thumb jabs directly into eyes forces immediate release of any grip. This is legal in self-defence.',
        '👠 SELF-DEFENCE: If wearing heeled shoes, stomp down on instep repeatedly. Heel can break bones in the foot.',
        '🤜 SELF-DEFENCE: If pushed to the ground, roll to create distance, then kick the knee joint sideways as they approach — knees only bend one way.',
    ],
    'harassment in public': [
        '📣 Speak loudly and clearly: "STOP! You are harassing me!" — draw maximum attention.',
        '👥 Approach a group of women or families and tell them what is happening.',
        '📱 Record the harasser with your phone — this is legal in all public spaces in India.',
        '🚔 Call 100 (Police) or 1091 (Women Helpline) immediately.',
        '🏪 Move to a well-lit, crowded place like a mall, restaurant, or medical store.',
        '🚌 On buses or trains, tell the conductor or driver immediately. They are obligated to help.',
        '📝 Call out the harasser by description: "Hey everyone, this man in red shirt is harassing me!"',
        '⚡ Contact SHE Teams Hyderabad at 9490617111 for rapid response within minutes.',
        '💪 SELF-DEFENCE: A strong, sudden shout directly in the harasser face causes freeze response. Follow with a palm strike to nose and immediately run towards people.',
        '🥊 SELF-DEFENCE: If grabbed, the elbow is the hardest bone in your body. Drive it sharply backward into their ribs or jaw.',
        '👊 SELF-DEFENCE: Groin kick with your knee is extremely effective. Thrust your knee upward with full force while holding their shoulders for leverage.',
        '🔑 SELF-DEFENCE: Hold keys with one key protruding between index and middle finger. Strike face or drag across forearm to create pain and break grip.',
    ],
    'unsafe uber or cab': [
        '📍 Share your live location NOW via Google Maps with a family member before getting in.',
        '📷 Photo the driver face and license plate and send to a contact immediately.',
        '📞 Call someone and keep talking — mention every major landmark you pass.',
        '🗺️ Open Google Maps and track the exact route yourself — notice any deviations immediately.',
        '🚨 If route is wrong, calmly say "I am feeling unwell, please stop here." Do not escalate.',
        '🆘 Use Uber or Ola SOS button inside the app — it alerts police and shares trip details automatically.',
        '🔊 At red lights, if threatened, lower window and shout for help. Wave at other drivers.',
        '🚗 If car stops in isolated area, try to jump out and run towards any visible light or person.',
        '📱 Tap SafeHer SOS to alert all your guardians with precise live location.',
        '💪 SELF-DEFENCE: If driver reaches back to grab you, strike the forearm downward with both hands to break wrist grip, then open door and roll out at low speed.',
        '🥊 SELF-DEFENCE: Your headrest supports behind driver seat if grabbed from behind. Use it to pull yourself forward and scratch or bite the attacker hands.',
        '🔑 SELF-DEFENCE: Keep door handle accessible during the ride. The moment car slows, be ready to open door and exit quickly.',
    ],
    'night walking alone': [
        '💡 Walk in well-lit, busy streets — even if it takes 10 extra minutes.',
        '📱 Keep phone charged above 40% before stepping out at night.',
        '🎧 Do NOT use both earphones — keep one ear completely free at all times.',
        '👟 Wear flat comfortable shoes you can run in. Remove heels before walking alone.',
        '📍 Share your live location with a guardian before leaving and update when you arrive.',
        '🔦 Keep phone torch on if dark — also works as a deterrent and helps others see you.',
        '🚶‍♀️ Walk with confidence and purpose — looking uncertain or distracted attracts predators.',
        '🏪 Memorize the 24-hour shops, ATMs with guards, and police booths on your regular route.',
        '📲 Enable SafeHer shake detection — rapid phone shaking instantly triggers SOS.',
        '💪 SELF-DEFENCE: Walk in the middle of the footpath, not near walls or parked vehicles where someone can pull you.',
        '🥊 SELF-DEFENCE: If approached at night, increase your pace immediately and cross to the other side. This simple movement disrupt most attacks.',
        '📣 SELF-DEFENCE: If grabbed, scream "FIRE! FIRE!" not just "help" — bystanders respond faster to fire.',
        '🗝️ SELF-DEFENCE: Have your phone or keys ALREADY in your hand before you step out. You do not have time to search your bag in an emergency.',
    ],
    'workplace harassment': [
        '📝 Document EVERY incident: date, time, location, witnesses, and exact words or actions described precisely.',
        '📧 Send yourself email summaries of each incident immediately — creates timestamped digital proof.',
        '👩‍💼 Report to HR in writing via email — verbal complaints can always be denied later.',
        '⚖️ Every company with 10+ employees MUST have an ICC (Internal Complaints Committee) by law.',
        '📞 Call the National Women Helpline 181 for free legal guidance on your rights.',
        '🏛️ File complaint with State Women Commission if internal process fails or is delayed beyond 90 days.',
        '👨‍⚖️ Engage a lawyer — sexual harassment charges carry 3-7 year penalties under POSH Act 2013.',
        '🤝 Identify trusted colleague witnesses who can corroborate your account before you report.',
        '📸 If physical, photograph any marks or injuries immediately. Courts accept phone photographs.',
        '💪 SELF-DEFENCE (Boundary Setting): Firmly and loudly say "Do not touch me. This is inappropriate." in front of witnesses. This creates both a boundary and witnesses simultaneously.',
        '🚨 SELF-DEFENCE: If physically threatened at work, use the office phone to call security or police. Do not wait.',
        '🔒 SELF-DEFENCE: Never be alone with the harasser. Arrange meetings in open, visible spaces or via video call only.',
    ],
    'domestic violence': [
        '🚨 FIRST: If in immediate danger, call 112 or get out NOW. Do not wait.',
        '🏠 Identify a safe place BEFORE a crisis — a trusted friend house, women shelter, or relative.',
        '💼 Pack an emergency bag ready to grab: ID proof, money, medicines, phone charger, important documents.',
        '📱 Save police 100, Women Helpline 1091, iCall 9152987821 in your phone under neutral names.',
        '⚖️ Under Domestic Violence Act 2005, courts can issue Protection Orders within 24 hours.',
        '🏛️ Hyderabad Swadhar Greh shelters provide free safe stay, food, legal aid for women fleeing violence.',
        '📞 iCall counseling: 9152987821 (Mon-Sat, 8am-10pm) — free, confidential emotional support.',
        '📝 Photograph every injury for evidence. Courts accept mobile phone photographs with timestamps.',
        '👧 You have the right to take your children — courts strongly support mothers fleeing domestic abuse.',
        '💪 SELF-DEFENCE in domestic violence: Position yourself near exits. Never allow yourself to be cornered in a bathroom or bedroom.',
        '🥊 SELF-DEFENCE: Use household items as shields — a chair, bag, or cushion can block strikes while you move towards the door.',
        '📣 SELF-DEFENCE: Shout for neighbors loudly. Domestic violence has witnesses who can be vital. Shout specific neighbor names.',
        '🔑 SELF-DEFENCE: Keep a spare key and some money hidden outside your home for emergency escape. A trusted neighbor can hold it.',
    ],
    'online stalking or cyberbullying': [
        '🔒 Immediately set ALL social media profiles to Private across every platform.',
        '🚫 Block the person on every platform — WhatsApp, Instagram, Facebook, email, LinkedIn.',
        '📸 Screenshot every harassing message or post BEFORE blocking — preserve all evidence.',
        '🌐 Report to the platform AND file Cybercrime complaint at cybercrime.gov.in.',
        '🔐 Change all passwords immediately and enable 2-Factor Authentication on every account.',
        '📍 Remove location tags from all old posts using a social media privacy audit.',
        '👥 Tell trusted friends — stalkers often contact victims through mutual connections.',
        '⚖️ File FIR under IT Act Section 66E and IPC 354D (Stalking) — up to 5 years imprisonment.',
        '📞 Call Cyber Crime Helpline 1930 for immediate government assistance.',
        '💪 SELF-DEFENCE: Do NOT engage or reply to online stalkers. Every reply tells them you are actively monitoring and can escalate their behavior.',
        '🔍 SELF-DEFENCE: Search your own name online to find what personal information is publicly accessible. Remove what you can.',
    ],
    'acid attack or chemical threat': [
        '🏃‍♀️ IMMEDIATELY run away from the direction of the attack. Speed is critical.',
        '💧 Flush the affected area with large amounts of clean water for at least 20 minutes.',
        '🚑 Call 112 for ambulance immediately — acid attacks constitute attempt to murder.',
        '👗 Remove any clothing that has been splashed with acid CAREFULLY, avoiding face contact.',
        '🚫 Do NOT apply toothpaste, oil, or any home remedies — water is the ONLY correct first aid.',
        '📱 Tap SafeHer SOS — guardians will receive your location and call for help.',
        '📸 Try to photograph the attacker from safety distance for evidence.',
        '⚖️ Acid attacks carry life imprisonment under IPC 326A. File FIR immediately at any police station.',
        '💪 SELF-DEFENCE: If you sense someone approaching with liquid, immediately shield your face with your bag or arm and move away fast.',
        '👓 SELF-DEFENCE: Carrying pepper spray is your legal right. A quick spray stops an acid attacker from getting close enough.',
    ],
    'eve teasing or catcalling': [
        '🚶‍♀️ Do NOT smile, engage, or acknowledge — this is NOT a compliment. Keep walking.',
        '📱 If it escalates, record on your phone immediately. Evidence is everything.',
        '📣 If it becomes aggressive, turn and firmly say: "I am recording you. Stop now."',
        '🚔 In Hyderabad, SHE Teams patrol specifically for eve teasing — call 9490617111.',
        '📝 Report to police 100 — eve teasing is a criminal offense under IPC Section 294.',
        '👥 If on a road, move towards a group of people or enter a shop.',
        '💪 SELF-DEFENCE: If physically blocked, a strong shout combined with a sudden aggressive step toward them disrupts most harassers who rely on victims being passive.',
        '🔑 SELF-DEFENCE: Pepper spray is legal to carry in India. One second of spray to the face creates 30-45 minutes of incapacitation.',
    ],
    'robbery or mugging': [
        '💰 If faced with a weapon, give up your valuables immediately. Items are replaceable, your life is not.',
        '📱 Try to remember exact physical description of the mugger after the incident.',
        '🚔 Do NOT chase after them — call 100 immediately and report location and description.',
        '💳 Call your bank immediately to block all cards. Most banks have 24-hour helplines.',
        '📋 File an FIR immediately — you need this for insurance claims and phone blocking (IMEI).',
        '📱 Report your phone IMEI to police so it can be tracked and blacklisted if stolen.',
        '💪 SELF-DEFENCE: If they grab your bag, release it immediately. Do NOT hold on — the strap can trap you or cause falls.',
        '🥊 SELF-DEFENCE: If physically attacked despite compliance, wrist strike downward to break a knife grip. Then run in the opposite direction immediately.',
        '🗣️ SELF-DEFENCE: Scream as loudly as possible — muggers fear witnesses and noise more than anything.',
    ],
    'rape or sexual assault': [
        '🚨 You are not at fault. This is a crime. Your feelings are valid.',
        '🚑 Call 112 immediately or go to the nearest government hospital — they MUST treat you.',
        '📞 Call the National Sexual Assault Helpline: 7827170170 (iCall) or 1091 (Women Helpline).',
        '🏥 Do NOT bathe, change clothes, or wash any part of your body before medical examination — this preserves crucial forensic evidence.',
        '💊 Request emergency contraception and STI testing at the hospital. This is your right.',
        '⚖️ File an FIR at ANY police station. The Zero FIR law means police MUST register your case.',
        '📍 Hyderabad: Bharosa Centre (040-23320999) provides comprehensive support including medical, legal and counseling.',
        '💪 SELF-DEFENCE (Prevention): Trust your instincts completely. If a situation or person feels wrong, leave immediately without explanation.',
        '🥊 SELF-DEFENCE: If attacked, maximum resistance during the first 30 seconds is most effective. Bite, scratch, scream, and aim for eyes and groin.',
        '📣 SELF-DEFENCE: Shout specific words: "FIRE! CALL POLICE! I AM BEING ATTACKED!" — specific shouts get faster bystander response.',
    ],
    'ragging or college bullying': [
        '📝 Document every incident with dates, times, location, and names of perpetrators and witnesses.',
        '📧 Email your parents and a trusted teacher about every incident immediately — creates a paper trail.',
        '🏫 Every college must have an Anti-Ragging Committee by UGC mandate. Report to them in writing.',
        '📞 National Anti-Ragging Helpline: 1800-180-5522 (free, 24/7)',
        '🌐 File complaint at antiragging.in — complaints are taken seriously and investigated.',
        '👮 Severe ragging cases are criminal offenses under IPC — police can and do arrest raggers.',
        '💪 SELF-DEFENCE: Never be alone in isolated areas. Always move with at least one trusted friend.',
        '🗣️ SELF-DEFENCE: Confidently refuse to comply with ragging demands. Compliance encourages escalation significantly.',
    ],
    'child safety': [
        '🚸 Teach children: No one should touch private parts. If they do, tell a trusted adult immediately.',
        '📱 Monitor children online — install parental controls on all devices.',
        '🏫 Teach the Buddy System — always walk with a friend, never alone.',
        '🔑 Teach children body autonomy — they have the right to say NO to any touch that feels wrong.',
        '📞 CHILDLINE: 1098 — free 24/7 helpline for children in distress.',
        '⚖️ POCSO Act 2012 protects all children under 18. Any sexual offense against a child carries strict punishment.',
        '💪 SELF-DEFENCE for children: Teach them to YELL NO! STOP!, RUN to a trusted adult, TELL immediately.',
        '📍 Teach children to memorize 2-3 trusted adult phone numbers in case they lose their phone.',
    ]
};

const GENERAL_TIPS = [
    { 
        q: ['self defense', 'defend myself', 'fight back', 'self defence', 'protect myself'], 
        a: '🥊 Complete Self-Defence Toolkit:\n\n1️⃣ PALM STRIKE — Drive the heel of your palm upward into the attacker nose. Extra-powerful and safe for your hand.\n\n2️⃣ ELBOW STRIKE — Your hardest bone. Drive elbow backward into ribs, or swing into jaw at close range.\n\n3️⃣ KNEE TO GROIN — Hold their shoulders for leverage and thrust knee upward with full force.\n\n4️⃣ EYE JAB — Extended thumb or two fingers jabbed directly at eyes. Forces immediate release.\n\n5️⃣ INSTEP STOMP — Stomp down HARD on top of their foot with your heel. Can break bones.\n\n6️⃣ BITE — Last resort but extremely effective. Bite hard on any exposed skin.\n\n7️⃣ VOICE — Your fiercest weapon. A powerful primal scream startles and attracts witnesses.\n\n🏃 Your GOAL is escape, not to win a fight. Strike once hard, then run and scream.' 
    },
    { 
        q: ['pepper spray', 'spray', 'weapons', 'legal weapon'], 
        a: '🌶️ Pepper Spray — Legal & Effective:\n\n✅ Completely legal to carry and use in India for self-defence.\n\n🎯 Range: 2-4 meters. Aim at eyes and nose.\n\n⏱️ Effect: 30-45 minutes of severe pain, temporary blindness.\n\n📦 Where to buy: Amazon India, pharmacies, security stores.\n\n⚠️ Practice: Know which side is the nozzle before you need it.\n\n🔑 Keep it in your outer bag pocket, NOT buried inside your bag.' 
    },
    { 
        q: ['safe app', 'safety app', 'features', 'how to use'], 
        a: '📱 SafeHer Full Feature Guide:\n\n🆘 SOS BUTTON — Sends your live GPS to all guardians via SMS + WhatsApp + Phone call simultaneously.\n\n📳 SHAKE DETECTION — Shake your phone rapidly 5 times to trigger SOS even if screen is locked.\n\n🎤 VOICE SOS — Say "help", "bachao", or "danger" to trigger SOS automatically.\n\n📡 LIVE TRACKING — Continuous GPS updates every 2 minutes automatically after SOS.\n\n💬 SAFETY CHAT — Ask any safety question or type HELP to send emergency SMS.\n\n🎙️ VOICE AGENT — Talk to AI guardian for real-time safety advice in any situation.' 
    },
    { 
        q: ['police', 'helpline', 'numbers', 'call', 'emergency number', 'contact'], 
        a: '📞 Complete Emergency Directory:\n\n🚔 Police Emergency: 100\n🚑 Ambulance: 102\n🔥 Fire: 101\n🆘 All Emergencies: 112\n👩 Women Helpline: 1091\n💬 Women Commission: 181\n🌐 Cyber Crime: 1930\n📱 SHE Teams HYD: 9490617111\n🏥 Bharosa Centre HYD: 040-23320999\n💊 iCall Counseling: 9152987821\n🚸 ChildLine: 1098\n🏛️ Anti-Ragging: 1800-180-5522\n⚕️ Vandrevala Foundation: 1860-2662-345 (24/7)' 
    },
    { 
        q: ['travel safe', 'travel tips', 'flight', 'train', 'bus', 'commute'], 
        a: '✈️ Travel Safety Protocol:\n\n📋 BEFORE: Share full itinerary with 2 trusted people. Include hotel name, flight number, and check-in time.\n\n🚕 CAB: Only book through verified apps. Share ride details. Sit behind driver, not passenger side for visibility.\n\n🚂 TRAIN: Stay in ladies compartment when alone at night. Keep bag in front, never behind.\n\n🚌 BUS: Sit near conductor or driver. If harassed, announce it loudly immediately.\n\n📍 Enable SafeHer Live Track for entire journey duration.\n\n📱 Keep emergency contacts accessible on your lock screen.' 
    },
    { 
        q: ['panic', 'scared', 'afraid', 'anxious', 'fear', 'nervous', 'unsafe'], 
        a: '💜 You are valid. Your fear is valid. Here is what to do RIGHT NOW:\n\n1. Take ONE deep breath — this activates your calm nervous system.\n2. Look around and name 5 things you can see — this grounds you in the present.\n3. Move towards the nearest light or group of people.\n4. Call any trusted person — just hearing a familiar voice calms the nervous system.\n5. The SOS button is RIGHT HERE if you need it — one tap, instant help.\n\n📞 If overwhelmed: iCall 9152987821 — free, confidential support.' 
    },
    { 
        q: ['what to do', 'i am in danger', 'help me now', 'emergency', 'urgent'], 
        a: '🚨 IMMEDIATE ACTION PLAN:\n\n1️⃣ TAP THE SOS BUTTON — this is the fastest action. It calls all guardians instantly.\n\n2️⃣ MOVE — walk briskly towards the nearest crowded, well-lit area.\n\n3️⃣ CALL 112 — India all-in-one emergency number. Police, ambulance, fire.\n\n4️⃣ MAKE NOISE — shout FIRE! FIRE! to attract maximum immediate attention.\n\n5️⃣ RECORD — if relatively safe, recording can deter escalation and provides evidence.\n\nYou are NOT alone. This app has alerted your guardians. Help is coming.' 
    },
    {
        q: ['eve teasing', 'catcall', 'catcalling', 'whistling', 'comment'], 
        a: '😡 Eve Teasing — What To Do:\n\n📱 Record the person. This alone often stops the behavior.\n📣 Firmly say: "I am recording you. This is criminal harassment. Stop NOW."\n🚔 SHE Teams Hyderabad: 9490617111 — they respond in minutes to eve teasing.\n⚖️ Eve teasing is punishable under IPC Section 294 — you CAN file a complaint.\n👥 Move towards other people or into any open shop immediately.\n\n💪 Self-defence: Do NOT smile or look down — that signals acceptance. Firm eye contact and sharp words disrupt the power dynamic.'
    },
    {
        q: ['drunk', 'alcohol', 'drink spiked', 'drugged', 'spiked'],
        a: '🚨 If you think your drink was spiked:\n\n1️⃣ STOP drinking immediately and put down the glass.\n2️⃣ Tell a trusted friend beside you immediately.\n3️⃣ Do NOT go anywhere alone — stay visible in the crowd.\n4️⃣ Call someone you trust to come and get you RIGHT NOW.\n5️⃣ Go to a hospital — they can test and treat within hours.\n6️⃣ Report to venue management and police immediately.\n\n⚠️ Symptoms: sudden dizziness, confusion, nausea without much alcohol consumed.\n🏥 Bharosa Centre HYD: 040-23320999 — handles assault cases with sensitivity.'
    }
];

function askChatTip(topic) {
    document.getElementById('safety-chat-text').value = topic;
    const form = document.getElementById('safety-chat-form');
    form.dispatchEvent(new Event('submit'));
}

function showRandomTip() {
    const keys = Object.keys(SAFETY_TIPS);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const tips = SAFETY_TIPS[key];
    const tip = tips[Math.floor(Math.random() * tips.length)];
    addSafetyChatMessage('bot', `💡 Quick Tip (${key}):\n${tip}`);
}

function toggleChatWidget() {
    const chat = document.getElementById('safety-chat');
    const fab = document.getElementById('chat-fab');
    if (chat.classList.contains('open')) {
        chat.classList.remove('open');
        fab.style.display = 'flex';
    } else {
        chat.classList.add('open');
        fab.style.display = 'none';
    }
}

function initSafetyChat() {
    const form = document.getElementById('safety-chat-form');
    const input = document.getElementById('safety-chat-text');
    const phoneInput = document.getElementById('safety-chat-phone');
    const toggleBtn = document.getElementById('safety-chat-toggle');

    const savedPhone = localStorage.getItem('safetyChatPhone');
    if (savedPhone) phoneInput.value = savedPhone;
    phoneInput?.addEventListener('input', () => localStorage.setItem('safetyChatPhone', phoneInput.value.trim()));

    toggleBtn?.addEventListener('click', () => {
        const chat = document.getElementById('safety-chat');
        const minimized = chat.classList.toggle('minimized');
        toggleBtn.textContent = minimized ? '+' : '—';
    });

    addSafetyChatMessage('bot', '👋 Hi! I\'m SafeHer AI — your personal safety advisor.\n\nTap any category above for escape tactics, or ask me anything. Type "HELP" to send an emergency SMS.');

    form?.addEventListener('submit', async e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        addSafetyChatMessage('user', text);

        const lower = text.toLowerCase();

        // Emergency SMS trigger
        if (lower === 'help' || lower === 'sos' || lower === 'emergency' || lower === 'help me') {
            const to = phoneInput.value.trim();
            if (!to) { addSafetyChatMessage('bot', '⚠️ Please enter an emergency phone number first.'); return; }
            try {
                const res = await fetch(`${API_BASE_URL}/api/chat-sos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text, latitude: currentLocation.lat, longitude: currentLocation.lng, accuracy: currentLocation.accuracy }) });
                const data = await res.json();
                if (data.success) { addSafetyChatMessage('bot', `🚨 Emergency SMS sent to ${escapeHtml(data.to)}. Help is coming!`); showToast('🚨 Emergency SMS sent', 'success'); }
                else { addSafetyChatMessage('bot', data.error || 'Failed to send emergency SMS.'); }
            } catch (err) { addSafetyChatMessage('bot', 'Server error. Please ensure the server is running.'); }
            return;
        }

        // Check category tips
        for (const [key, tips] of Object.entries(SAFETY_TIPS)) {
            if (lower.includes(key) || key.split(' ').some(word => word.length > 3 && lower.includes(word))) {
                const allTips = tips.join('\n\n');
                const preview = tips.slice(0, 5).join('\n\n');
                addSafetyChatMessage('bot', `🛡️ Tips for "${key}":\n\n${preview}\n\n💡 ${tips.length > 5 ? `${tips.length - 5} more tips available — ask again!` : 'All tips shown above.'}`);
                return;
            }
        }

        // Check general tips
        for (const qt of GENERAL_TIPS) {
            if (qt.q.some(q => lower.includes(q))) {
                addSafetyChatMessage('bot', qt.a);
                return;
            }
        }

        // Situational keyword fallback
        const situationKeywords = [
            { words: ['harass', 'molest', 'grope', 'teas', 'catcall'], key: 'harassment in public' },
            { words: ['follow', 'following', 'stalker', 'stalk'], key: 'being followed' },
            { words: ['cab', 'uber', 'ola', 'taxi', 'driver', 'vehicle'], key: 'unsafe uber or cab' },
            { words: ['night', 'dark', 'walking alone', 'alone at night'], key: 'night walking alone' },
            { words: ['domestic', 'husband', 'abusive', 'beat', 'violence at home'], key: 'domestic violence' },
            { words: ['workplace', 'office', 'colleague', 'boss', 'posh'], key: 'workplace harassment' },
            { words: ['online', 'cyber', 'internet', 'instagram', 'social media', 'dm'], key: 'online stalking or cyberbullying' },
            { words: ['rape', 'assault', 'sexual'], key: 'rape or sexual assault' },
            { words: ['acid', 'chemical', 'spray'], key: 'acid attack or chemical threat' },
            { words: ['rob', 'mug', 'theft', 'stolen', 'steal'], key: 'robbery or mugging' },
            { words: ['kidna', 'grab', 'forced', 'abduct'], key: 'kidnapping or being grabbed' },
        ];
        for (const sk of situationKeywords) {
            if (sk.words.some(w => lower.includes(w))) {
                const tips = SAFETY_TIPS[sk.key];
                if (tips) {
                    const preview = tips.slice(0, 5).join('\n\n');
                    addSafetyChatMessage('bot', `🛡️ Tips for "${sk.key}":\n\n${preview}`);
                    return;
                }
            }
        }

        // Fall back to server
        try {
            const res = await fetch(`${API_BASE_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
            const data = await res.json();
            addSafetyChatMessage('bot', data.success ? (data.answer || 'I can help with safety tips. Try asking about: being followed, unsafe cab, night walking, harassment, or type "HELP" for emergency SMS.') : 'I can help with safety tips! Try asking: "being followed", "unsafe cab", "night walking", "harassment", or "self defense".');
        } catch (err) {
            addSafetyChatMessage('bot', '💡 I can help with safety tips! Try: "being followed", "unsafe cab", "workplace harassment", "domestic violence", or "online stalking".');
        }
    });
}

function addSafetyChatMessage(sender, text) {
    const container = document.getElementById('safety-chat-messages');
    if (!container) return;
    const row = document.createElement('div');
    row.className = `safety-chat-msg ${sender}`;
    const avatar = document.createElement('div');
    avatar.className = 'safety-chat-avatar';
    avatar.textContent = sender === 'user' ? '👤' : '♀';
    const bubble = document.createElement('div');
    bubble.className = 'safety-chat-bubble';
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    row.appendChild(avatar);
    row.appendChild(bubble);
    container.appendChild(row);
    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 0);
}

// ─── VOICE AGENT ───────────────────────────────────────
function toggleVoiceAgent() {
    const btn = document.getElementById('voice-agent-btn');
    const fab = document.getElementById('voice-assistant-fab');
    
    if (voiceAgentActive) {
        voiceAgentActive = false; 
        if (btn) { btn.innerHTML = '🎤 Talk to AI'; btn.classList.remove('btn-glow'); }
        if (fab) { fab.classList.remove('active'); fab.querySelector('.voice-fab-label').textContent = 'Voice Assistant'; }
        
        if (agentRecognition) agentRecognition.stop();
        window.speechSynthesis.cancel();
        document.getElementById('ai-advisor').innerHTML = ''; 
        updateRiskAssessment(); 
        return;
    }
    
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) { 
        showToast('Speech recognition not supported', 'error'); 
        return; 
    }
    
    voiceAgentActive = true; 
    if (btn) { btn.innerHTML = '🛑 End Conversation'; btn.classList.add('btn-glow'); }
    if (fab) { fab.classList.add('active'); fab.querySelector('.voice-fab-label').textContent = 'Listening...'; }
    
    document.getElementById('ai-advisor').innerHTML = '';
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    agentRecognition = new SR(); 
    agentRecognition.continuous = false; 
    agentRecognition.interimResults = false; 
    agentRecognition.lang = 'en-US';
    
    agentRecognition.onresult = e => { 
        const t = e.results[0][0].transcript; 
        addAgentLog(t, 'user'); 
        processAgentCommand(t.toLowerCase()); 
    };
    
    agentRecognition.onerror = e => { 
        if (e.error !== 'no-speech') console.warn('Agent error:', e.error); 
    };
    
    agentRecognition.onend = () => { 
        if (voiceAgentActive && !window.speechSynthesis.speaking) { 
            try { agentRecognition.start(); } catch (e) { } 
        } 
    };
    
    const greeting = "Hello! I am your SafeHer AI guardian. I am here to keep you safe. If you are in danger, say HELP to trigger SOS immediately. I can also help you with: being followed, harassment, unsafe vehicle, domestic violence, self defence techniques, night safety, online stalking, acid attacks, or any safety situation you're facing. Just tell me what's happening and I will guide you step by step. How can I help you right now?";
    addAgentLog(greeting, 'agent');
    agentSpeak(greeting);
}

function processAgentCommand(cmd) {
    let response = "I am here to keep you safe. Ask me about being followed, harassment, unsafe cab, night safety, self defence, or say HELP to trigger emergency SOS.";
    
    // ─── SOS TRIGGER WORDS ───────────────────────────────
    const distressWords = ['sos', 'help', 'emergency', 'danger', 'bachao', 'madad', 'save me', 'please help', 'help me', 'attack', 'attacked', 'scream', 'scared', 'afraid', 'run', 'kidnap'];
    
    if (distressWords.some(word => cmd.includes(word))) {
        triggerSOS('voice-assistant');
        response = 'SOS activated. Your live location has been sent to all your guardians immediately. Now, most importantly, move towards the nearest crowded, well-lit area. Keep your phone in your hand. If someone is physically threatening you: drive your palm hard into their nose, then knee to the groin, then run and shout FIRE as loud as possible. Help is coming. You are not alone.';
        if (cmd.includes('follow') || cmd.includes('following')) response = 'SOS triggered. Guardians alerted. Do NOT go home — you will lead them to your address. Enter the nearest open shop, restaurant, or police station immediately. Cross the road 2 to 3 times. If grabbed: stomp on instep, elbow to ribs, then run screaming FIRE.';
        else if (cmd.includes('harass') || cmd.includes('touch') || cmd.includes('grope') || cmd.includes('moles')) response = 'SOS triggered. Guardians alerted. Shout loudly right now: STOP! YOU ARE HARASSING ME! Draw maximum attention around you. Move instantly toward any group of people. Record with your phone. Call 1091 Women Helpline. If grabbed: elbow to ribs, palm strike to nose, knee to groin, then run.';
        else if (cmd.includes('cab') || cmd.includes('car') || cmd.includes('uber') || cmd.includes('taxi') || cmd.includes('ola')) response = 'SOS triggered. Guardians alerted with your location. Call someone right now and mention every landmark. If you feel unsafe, say I feel unwell please stop. At a red light, open window and signal for help. If the vehicle stops somewhere isolated, open door and run toward any light or person.';
        else if (cmd.includes('hit') || cmd.includes('beat') || cmd.includes('domestic') || cmd.includes('husband') || cmd.includes('partner')) response = 'SOS triggered. You are protected by law. Get out NOW if you can. Move toward any exit. Call 112. Under the Domestic Violence Act 2005, police can take action immediately. Swadhar shelters in Hyderabad provide immediate safe stay. You do not have to go back.';
        else if (cmd.includes('knife') || cmd.includes('weapon') || cmd.includes('gun')) response = 'SOS triggered. If they have a weapon, DO NOT resist or fight. Your life matters more than your belongings. Give up everything they ask for. Once they are momentarily distracted, run as fast as you can and scream FIRE loudly. Help is coming.';
    }
    // ─── BEING FOLLOWED ───────────────────────────────────
    else if (cmd.includes('follow') || cmd.includes('following me') || cmd.includes('someone behind')) {
        response = 'If you think you are being followed, here is exactly what to do. Number one: Do NOT go home. You will lead them to your address. Number two: Cross the street and change direction 3 times to confirm. Number three: Enter the nearest open shop, restaurant, or petrol pump. Number four: Call a friend and stay on the phone. Number five: If grabbed from behind, stomp hard on their foot with your heel, drive your elbow back into their ribs, then spin and palm-strike the nose hard. Then run toward people screaming FIRE.';
    }
    // ─── HARASSMENT ───────────────────────────────────────
    else if (cmd.includes('harass') || cmd.includes('teas') || cmd.includes('catcall') || cmd.includes('eve') || cmd.includes('grope') || cmd.includes('touch') || cmd.includes('molest')) {
        response = 'For harassment, here are the steps. First: speak loudly and clearly — STOP! You are harassing me! This draws public attention which is your best protection. Second: call out by clothing description — Hey everyone, this person in blue shirt is harassing me! Third: record with your phone, it is completely legal. Fourth: call 1091 Women Helpline or SHE Teams Hyderabad at 9490617111. For self defence: A strong sudden shout directly in their face causes freeze response — follow immediately with a palm strike to nose, then run toward people.';
    }
    // ─── UNSAFE CAB ───────────────────────────────────────
    else if (cmd.includes('cab') || cmd.includes('car') || cmd.includes('uber') || cmd.includes('ola') || cmd.includes('auto') || cmd.includes('taxi') || cmd.includes('driver')) {
        response = 'Unsafe vehicle steps: One — share your live location via Google Maps with a family member right now. Two — photograph license plate and driver face and send to a contact. Three — call someone and mention every landmark you pass. Four — if route changes, say calmly: I feel unwell, please stop here. Five — use the Uber or Ola SOS button inside the app. Six — at any red light, lower the window and attract attention if threatened. Seven — if car stops in isolation, open door and run toward any light or person immediately.';
    }
    // ─── DOMESTIC VIOLENCE ────────────────────────────────
    else if (cmd.includes('domestic') || cmd.includes('husband') || cmd.includes('partner') || cmd.includes('abusive') || cmd.includes('beat') || cmd.includes('hit me')) {
        response = 'For domestic violence, your safety is the priority. If in immediate danger, leave NOW and call 112. You have legal protection under the Domestic Violence Act 2005 — courts issue Protection Orders within 24 hours. Pack an emergency bag: ID, money, medicines, charger. Swadhar Greh Hyderabad provides free safe stay and legal support. iCall counseling at 9152987821 is free and confidential. You are not at fault. You have the right to safety and to leave.';
    }
    // ─── SELF DEFENCE ─────────────────────────────────────
    else if (cmd.includes('self def') || cmd.includes('defend') || cmd.includes('fight') || cmd.includes('protect') || cmd.includes('attack')) {
        response = 'Here are your most effective self-defence techniques. One: Palm strike — drive the heel of your palm hard upward into the nose. Two: Elbow strike — your hardest bone, drive it backward into ribs or jaw. Three: Knee to groin — hold their shoulders and thrust knee upward with full force. Four: Eye jab — extend thumb or two fingers directly into eyes. Five: Instep stomp — stomp the heel DOWN onto the top of their foot as hard as possible. Six: Bite — last resort but very effective on any exposed skin. Seven: Voice — a primal scream startles the attacker and attracts witnesses. Remember: your goal is to create one moment to escape. Strike hard, once, then run and scream FIRE.';
    }
    // ─── NIGHT SAFETY ─────────────────────────────────────
    else if (cmd.includes('night') || cmd.includes('dark') || cmd.includes('alone') || cmd.includes('walking')) {
        response = 'Night walking safety: One — walk in well-lit, busy streets even if it takes much longer. Two — keep one ear completely free from earphones. Three — walk in the middle of the footpath, not near walls or parked cars. Four — have your phone or keys already in your hand before stepping out. Five — share live location before leaving. Six — enable SafeHer shake detection — rapid shaking triggers SOS instantly. Seven — if followed, enter the nearest 24-hour shop or petrol pump. Eight — shout FIRE loudly if threatened — it gets faster response than shouting help.';
    }
    // ─── EMERGENCY NUMBERS ────────────────────────────────
    else if (cmd.includes('police') || cmd.includes('number') || cmd.includes('helpline') || cmd.includes('call who') || cmd.includes('contact')) {
        response = 'Emergency numbers: 112 for all emergencies. 100 for Police. 102 for Ambulance. 1091 for Women Helpline. 181 for Women Commission. 1930 for Cyber Crime. 9490617111 for SHE Teams Hyderabad. 9152987821 for iCall counseling, free and confidential. 040-23320999 for Bharosa Centre Hyderabad. 1098 for Childline. These numbers are available 24 hours a day, 7 days a week.';
    }
    // ─── ONLINE STALKING ──────────────────────────────────
    else if (cmd.includes('online') || cmd.includes('internet') || cmd.includes('cyber') || cmd.includes('instagram') || cmd.includes('whatsapp') || cmd.includes('social media')) {
        response = 'For online stalking or cyberbullying: One — immediately set all social media to private. Two — screenshot ALL messages before blocking as evidence. Three — block on every platform simultaneously. Four — change all passwords and enable 2-factor authentication. Five — report to the platform and file at cybercrime.gov.in. Six — call Cyber Crime Helpline 1930. Under IT Act and IPC 354D, stalking carries up to 5 years imprisonment. Do NOT reply to them — every response encourages more contact.';
    }
    // ─── TIPS / ADVICE ────────────────────────────────────
    else if (cmd.includes('tip') || cmd.includes('advice') || cmd.includes('safe') || cmd.includes('measure') || cmd.includes('incident') || cmd.includes('situation') || cmd.includes('what should')) {
        const situationTips = [
            'Safety tip: Always trust your gut instinct. If a situation feels wrong, leave immediately without explanation or apology. Your discomfort is a survival signal.',
            'Safety tip: Share your live location before EVERY journey, not just ones that feel dangerous. Build this as a daily habit.',
            'Safety tip: The most important self-defence tool is your voice. Practice shouting FIRE loudly — it is startling, attracts help, and you need to be able to do it without hesitation.',
            'Safety tip: Keep your phone charged above 40 percent before going out. A dead phone in an emergency is a serious vulnerability.',
            'Safety tip: Sit near the driver in autos and taxis, not behind the passenger seat. You are more visible to the driver and passersby.',
            'Safety tip: Walk with purpose and confidence even when scared. Predators target people who look uncertain or distracted.'
        ];
        response = situationTips[Math.floor(Math.random() * situationTips.length)];
    }
    // ─── TRACKING ─────────────────────────────────────────
    else if (cmd.includes('track') || cmd.includes('location') || cmd.includes('gps') || cmd.includes('monitor')) {
        if (!trackingEnabled) toggleContinuousTracking();
        response = 'Live tracking is now enabled. Your guardians will receive automatic GPS updates every 2 minutes. I will keep them informed of your location throughout your journey. Stay safe.';
    }
    // ─── STOP / END ───────────────────────────────────────
    else if (cmd.includes('stop') || cmd.includes('bye') || cmd.includes('cancel') || cmd.includes('quiet') || cmd.includes('end') || cmd.includes('silent')) {
        response = 'Ending our session now. Remember: SOS button is always one tap away. Your guardians are set up. Stay safe, stay aware, and trust your instincts. I am always here when you need me.';
        addAgentLog(response, 'agent');
        agentSpeak(response);
        setTimeout(toggleVoiceAgent, 3000);
        return;
    }
    
    addAgentLog(response, 'agent');
    agentSpeak(response);
}

function agentSpeak(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find(v => v.lang.includes('en') && (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('siri') || v.name.toLowerCase().includes('zira')));
        if (voice) utterance.voice = voice;
        utterance.rate = 1.0; utterance.pitch = 1.1;
        utterance.onend = () => { if (voiceAgentActive && agentRecognition) { try { agentRecognition.start(); } catch (e) { } } };
        window.speechSynthesis.speak(utterance);
    }
}

function addAgentLog(text, sender) {
    const div = document.getElementById('ai-advisor');
    const msg = document.createElement('div');
    msg.className = 'advisor-msg';
    const icon = sender === 'user' ? '👤' : '♀';
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (sender === 'user') {
        msg.style.flexDirection = 'row-reverse';
        msg.innerHTML = `<div class="advisor-avatar" style="background:rgba(58,134,255,0.3);">${icon}</div><div class="advisor-text" style="text-align:right;border-radius:12px 4px 12px 12px;border-color:rgba(58,134,255,0.2);"><p>${escapeHtml(text)}</p><span class="advisor-time">${time}</span></div>`;
    } else {
        msg.innerHTML = `<div class="advisor-avatar">${icon}</div><div class="advisor-text"><p>${escapeHtml(text)}</p><span class="advisor-time">${time}</span></div>`;
    }
    div.appendChild(msg);
    setTimeout(() => { div.scrollTop = div.scrollHeight; }, 50);
}

// ─── 3D BACKGROUND ─────────────────────────────────────
function init3DBackground() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas || !window.THREE) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const particleCount = 2500;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const palette = [[1.0, 0.0, 0.43], [0.78, 0.49, 1.0], [1.0, 0.52, 0.63], [0.23, 0.53, 1.0]];

    for (let i = 0; i < particleCount; i++) {
        const r = 15 + Math.random() * 25;
        const theta = Math.random() * Math.PI * 2, phi = Math.random() * Math.PI;
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) - 5;
        positions[i * 3 + 2] = r * Math.cos(phi) - 20;
        const col = palette[Math.floor(Math.random() * palette.length)];
        colors[i * 3] = col[0]; colors[i * 3 + 1] = col[1]; colors[i * 3 + 2] = col[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const particles = new THREE.Points(geo, mat);
    scene.add(particles);

    // Torus rings — feminine circles
    [[12, 0.08, 0xc77dff, 0.12, -15], [18, 0.05, 0xff85a1, 0.1, -22], [8, 0.1, 0xff006e, 0.08, -12]].forEach(([r, t, c, o, z]) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 16, 100), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o }));
        ring.position.z = z; ring.rotation.x = Math.PI / 4; scene.add(ring);
    });

    // Icosahedron shield
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 2), new THREE.MeshBasicMaterial({ color: 0xff006e, wireframe: true, transparent: true, opacity: 0.05 }));
    shield.position.z = -15; scene.add(shield);

    camera.position.z = 5;
    let mouseX = 0, mouseY = 0;
    document.addEventListener('mousemove', e => { mouseX = (e.clientX / window.innerWidth - 0.5) * 2; mouseY = (e.clientY / window.innerHeight - 0.5) * 2; });

    (function animate() {
        requestAnimationFrame(animate);
        const t = Date.now() * 0.001;
        particles.rotation.y += 0.0004; particles.rotation.x += 0.0002;
        shield.rotation.x = Math.sin(t * 0.3) * 0.2 + mouseY * 0.1;
        shield.rotation.y = Math.cos(t * 0.2) * 0.3 + mouseX * 0.1;
        camera.position.x += (mouseX * 0.4 - camera.position.x) * 0.02;
        camera.position.y += (-mouseY * 0.4 - camera.position.y) * 0.02;
        camera.lookAt(0, 0, -15);
        renderer.render(scene, camera);
    })();

    window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
}

// ─── UTILITIES ─────────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${{ success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type]}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)'; setTimeout(() => toast.remove(), 300); }, 4000);
}

function addLog(type, message) {
    const log = document.getElementById('sos-log');
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${message}</span>`;
    log.insertBefore(entry, log.firstChild);
    while (log.children.length > 50) log.removeChild(log.lastChild);
}

function updateCheckStatus(id, icon) { const el = document.getElementById(id); if (el) el.textContent = icon; }

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
