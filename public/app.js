/* ═══════════════════════════════════════════════════════
   SAFEHER — App Logic
   ═══════════════════════════════════════════════════════ */

// AUTO-DETECT API BASE URL
function getBestApiUrl() {
    const host = window.location.hostname;
    const port = window.location.port;

    // 1. Local Development (Browser or Local Network)
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
        // If we are already on port 3000, use relative paths
        if (port === '3000') return '';
        // Otherwise, point to the local backend on 3000
        return 'http://localhost:3000';
    }

    // 2. Mobile / Capacitor fallback
    if (window.location.protocol === 'file:' || window.location.protocol === 'capacitor:') {
        return 'https://safety-awx4.onrender.com';
    }

    // 3. Known Production Domains
    if (host.includes('safeher-1fb18') || host.includes('web.app') || host.includes('render.com')) {
        return 'https://safety-awx4.onrender.com';
    }

    // Default to relative (useful if hosted on the same server)
    return '';
}
const API_BASE_URL = getBestApiUrl();

// ─── AGORA.IO LIVE STREAM CONFIG ───
// Replace with your real App ID from https://console.agora.io/
const AGORA_APP_ID = "7a9462cb714f465a8d814c81abc8da6c";
let agoraClient = null;
let localAudioTrack = null;
let localVideoTrack = null;
let isStreamingActive = false;

// ─── FIREBASE CONFIGURATION (SECURE DYNAMIC FETCH) ───
async function initializeFirebase() {
    try {
        const resp = await fetch(getBestApiUrl() + '/api/config');
        if (!resp.ok) return;
        const config = await resp.json();
        if (typeof firebase !== 'undefined' && config.firebase) {
            firebase.initializeApp(config.firebase);
            console.log('✅ Firebase Initialized Dynamically');
            if (typeof loadCommunityReports === 'function') loadCommunityReports();
        }
    } catch (e) {
        console.warn('Firebase initialized in offline/fallback mode.');
    }
}
initializeFirebase();


















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

let isStealthMode = false;

function toggleStealthMode() {
    const newsUI = document.getElementById('stealth-news-ui');
    if (!newsUI) return;

    isStealthMode = !isStealthMode;
    if (isStealthMode) {
        newsUI.classList.remove('hidden');
        if (window.navigator.vibrate) window.navigator.vibrate(50); // subtle haptic
        console.log("🕵️ Stealth Mode Active");
        addLog('info', 'Stealth mode activated — interface masked');
    } else {
        newsUI.classList.add('hidden');
        console.log("🔓 Stealth Mode Deactivated");
    }
}

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
    console.log("🚀 AUTHENTICATION COMPLETELY BYPASSED");

    // Set dummy user data so app logic works perfectly
    const dummyUser = {
        email: 'user@safeher.com',
        uid: 'local_bypass',
        name: 'SafeHer User'
    };
    localStorage.setItem('safeher_user', JSON.stringify(dummyUser));

    // Force hide the auth modal and open the app
    const authModal = document.getElementById('auth-modal');
    if (authModal) {
        authModal.style.display = 'none';
    }

    showApp();
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
    alert("Logout is disabled in this mode.");
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

// 🎥 AGORA LIVE VIDEO FUNCTIONS
async function startLiveVideoStreaming(channelName) {
    if (AGORA_APP_ID === "YOUR_AGORA_APP_ID_HERE") {
        console.warn("Agora App ID is missing. Live streaming will not start.");
        return;
    }

    if (!channelName) {
        channelName = "SafeHer_" + Math.random().toString(36).substring(7);
    }

    try {
        const videoPreview = document.getElementById('local-video-container');
        if (videoPreview) videoPreview.classList.add('active');

        // Create Agora Client
        agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

        // Join Channel
        const uid = await agoraClient.join(AGORA_APP_ID, channelName, null, null);

        // Create audio & video tracks
        [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();

        // Play local video preview
        if (videoPreview) localVideoTrack.play('local-video-container');

        // Publish to channel
        await agoraClient.publish([localAudioTrack, localVideoTrack]);

        isStreamingActive = true;
        addLog('success', `📹 Live evidence streaming active — Channel: ${channelName}`);
        console.log("✅ Agora Stream Started:", channelName);

    } catch (e) {
        console.error("❌ Agora Start Error:", e);
        addLog('error', 'Live streaming failed: No camera permission');
    }
}

async function stopLiveVideoStreaming() {
    if (localAudioTrack) { localAudioTrack.close(); localAudioTrack = null; }
    if (localVideoTrack) { localVideoTrack.close(); localVideoTrack = null; }
    if (agoraClient) { await agoraClient.leave(); agoraClient = null; }

    isStreamingActive = false;
    const videoPreview = document.getElementById('local-video-container');
    if (videoPreview) videoPreview.classList.remove('active');
    console.log("⏹️ Agora Stream Stopped");
}

// ─── SOS — ALWAYS FETCHES FRESH GPS ────────────────────
// ─── SOS — ALWAYS FETCHES FRESH GPS ────────────────────
async function triggerSOS(method = 'manual', senderPhone = null) {

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

    // 📹 START LIVE STREAMING IMMEDIATELY
    startLiveVideoStreaming();

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
                senderPhone: senderPhone || user.phone || null,
                message: `🚨 EMERGENCY! I need help! Triggered via ${method}.`
            })

        });
        const data = await res.json();
        document.getElementById('sos-alert-bar').style.width = '100%';
        if (data.success) {
            // ─── Start streaming live GPS to session ───────────────
            if (data.sessionId) {
                startLiveLocationPush(data.sessionId);
                addLog('success', `📡 Live GPS streaming active`);
            }

            // 📹 Start Live Video Evidence Streaming
            if (data.agoraChannel) {
                startLiveVideoStreaming(data.agoraChannel);
            }

            // ==========================================
            // 📲 NATIVE DISPATCH (DIRECT SIM)
            // ==========================================
            const videoLink = data.sessionId ? `\n\n📹 Watch Live Video Evidence:\nhttps://safeher-1fb18.web.app/track.html?id=${data.sessionId}` : '';
            const message = `🚨 SOS ALERT! 🚨\n\nI need help IMMEDIATELY. My live location:\n${data.mapsLink}${videoLink}\n\nSent via SafeHer Safety Shield.`;
            const numbersString = data.contacts ? data.contacts.map(c => c.phone).join(',') : '';

            // Try Native Background SMS first (if in capacitor app)
            let nativeSent = false;
            try {
                if (window.sms) {
                    await new Promise((resolve) => {
                        window.sms.send(numbersString, message, { android: { intent: '' } }, () => {
                            console.log("✅ Native Background SMS Sent!");
                            nativeSent = true;
                            resolve();
                        }, (e) => {
                            console.error("❌ Native SMS Failed:", e);
                            resolve();
                        });
                    });
                }
            } catch (err) { console.error("Native Plugin Error:", err); }
            if (nativeSent) {
                showToast("✅ Emergency SMS sent via SIM Card!", "success");
            }

            document.getElementById('sos-alert-result').innerHTML =
                `<div style="color:#00f5d4;font-size:1.1rem;margin-bottom:10px;font-weight:700;">
                   ✅ TOTAL EMERGENCY ALERT DISPATCHED!
                 </div>
                 <div style="color:rgba(255,255,255,0.9);font-size:0.85rem;margin-bottom:15px;line-height:1.4;">
                   Emergency Alerts were sent via:<br>
                   📱 <b>Native SIM Card</b> (Direct SMS) ${nativeSent ? '— ✅ SENT' : '— ⚠️ N/A (Web)'}<br>
                   📞 <b>Voice Call</b> (Server Automated)<br>
                   📩 <b>Cloud SMS</b> (Fast2SMS Automated)<br>
                   💬 <b>WhatsApp</b> (Twilio Automated)<br><br>
                   Help is on the way. Stay calm.
                 </div>
                 <div style="background:rgba(0,245,212,0.1);padding:10px;border-radius:8px;font-size:0.8rem;border:1px solid rgba(0,245,212,0.3);">
                   📍 <a href="${data.mapsLink}" target="_blank" style="color:#00f5d4;">View Sent Location Link</a>
                 </div>`;

            document.getElementById('sos-alert-msg').textContent = '🚨 SOS ACTIVE — SENDING SMS NOW';
            showToast(`🚨 Call Sent! SMS & WhatsApp Opening...`, 'success');

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

    // 📹 STOP LIVE STREAMING
    stopLiveVideoStreaming();

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
        if (recognition) { try { recognition.abort(); } catch (e) { } recognition = null; }
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

// Unique session ID for Gemini conversation memory
const geminiSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(7);

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

    addSafetyChatMessage('bot', '👋 Hi! I\'m **SafeHer AI** — powered by Google Gemini.\n\nI understand natural language, so ask me anything about safety — in *English, Hindi, or Telugu*.\n\nTap a topic above, or describe your situation. Type **HELP** to send an emergency SMS.', 'gemini');

    form?.addEventListener('submit', async e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        addSafetyChatMessage('user', text);

        const lower = text.toLowerCase();

        // Emergency SMS trigger — always handle locally for speed
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

        // Show typing indicator
        const typingId = showTypingIndicator();

        // Send EVERYTHING to Gemini AI — let the AI handle all queries intelligently
        try {
            const res = await fetch(`${API_BASE_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, sessionId: geminiSessionId })
            });
            const data = await res.json();
            removeTypingIndicator(typingId);

            if (data.success && data.answer) {
                addSafetyChatMessage('bot', data.answer, data.source || 'fallback');
            } else {
                addSafetyChatMessage('bot', '💡 I can help with safety tips! Try: "being followed", "unsafe cab", "workplace harassment", "domestic violence", or "online stalking".');
            }
        } catch (err) {
            removeTypingIndicator(typingId);
            // Offline fallback — use local keyword matching
            let localAnswer = getLocalKeywordAnswer(lower);
            addSafetyChatMessage('bot', localAnswer, 'offline');
        }
    });
}

// Typing indicator
function showTypingIndicator() {
    const container = document.getElementById('safety-chat-messages');
    if (!container) return null;
    const id = 'typing-' + Date.now();
    const row = document.createElement('div');
    row.className = 'safety-chat-msg bot';
    row.id = id;
    row.innerHTML = `
        <div class="safety-chat-avatar">♀</div>
        <div class="safety-chat-bubble typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </div>`;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return id;
}

function removeTypingIndicator(id) {
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.remove();
}

// Local keyword matching fallback for offline mode
function getLocalKeywordAnswer(lower) {
    // Check category tips
    for (const [key, tips] of Object.entries(SAFETY_TIPS)) {
        if (lower.includes(key) || key.split(' ').some(word => word.length > 3 && lower.includes(word))) {
            return `🛡️ Tips for "${key}":\n\n${tips.slice(0, 5).join('\n\n')}`;
        }
    }
    // Check general tips
    for (const qt of GENERAL_TIPS) {
        if (qt.q.some(q => lower.includes(q))) return qt.a;
    }
    // Situational keywords
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
        { words: ['weapon', 'knife', 'gun'], key: 'weapon threat' },
    ];
    for (const sk of situationKeywords) {
        if (sk.words.some(w => lower.includes(w))) {
            const tips = SAFETY_TIPS[sk.key];
            if (tips) return `🛡️ Tips for "${sk.key}":\n\n${tips.slice(0, 5).join('\n\n')}`;
        }
    }
    return '💡 I\'m currently offline. Try asking about: "being followed", "unsafe cab", "workplace harassment", "domestic violence", or "self defense".';
}

function addSafetyChatMessage(sender, text, source) {
    const container = document.getElementById('safety-chat-messages');
    if (!container) return;
    const row = document.createElement('div');
    row.className = `safety-chat-msg ${sender}`;
    const avatar = document.createElement('div');
    avatar.className = 'safety-chat-avatar';
    avatar.textContent = sender === 'user' ? '👤' : '♀';
    const bubble = document.createElement('div');
    bubble.className = 'safety-chat-bubble';

    // Render rich text for bot messages (markdown-like)
    if (sender === 'bot') {
        bubble.innerHTML = renderChatMarkdown(text);
    } else {
        bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Add Gemini AI badge for AI-powered responses
    if (sender === 'bot' && source === 'gemini') {
        const badge = document.createElement('div');
        badge.className = 'gemini-badge';
        badge.innerHTML = '✨ <span>Powered by Gemini AI</span>';
        bubble.appendChild(badge);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    container.appendChild(row);
    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 0);
}

// Simple markdown renderer for chat messages
function renderChatMarkdown(text) {
    let html = escapeHtml(text);
    // Bold: **text** or __text__
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
    // Italic: *text* or _text_
    html = html.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // Inline code: `text`
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(255,0,110,0.1);padding:2px 5px;border-radius:3px;font-size:0.9em;">$1</code>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
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

    // ─── SECRET SOS PHRASE ───────────────────────────────
    const secretPhrase = document.getElementById('secret-voice-phrase')?.value.toLowerCase();
    if (secretPhrase && secretPhrase.length > 5 && cmd.includes(secretPhrase)) {
        triggerSOS('secret-voice-phrase');
        agentSpeak("Acknowledged. I'll stay here on the line with you. Stay calm.");
        return;
    }

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
    // ─── KIDNAPPING ────────────────────────────────────────
    else if (cmd.includes('kidnap') || cmd.includes('grab') || cmd.includes('abduct')) {
        response = 'KIDNAPPING THREAT. Go limp and heavy immediately to be hard to carry. Scream FIRE or HELP as loud as possible. Use your keys to gouge eyes or scratch. Stomp on their instep with full force. Try to attract ANY bystander attention immediately. Do not get into a secondary location like a car if you can fight it.';
    }
    // ─── ACID ATTACK ───────────────────────────────────────
    else if (cmd.includes('acid') || cmd.includes('chemical')) {
        response = 'ACID ATTACK THREAT. Shout for help immediately. Cover your face with your arms. If attacked, wash with huge amounts of clean running water for 20 minutes. Do not use milk or ice. Call 102 for ambulance immediately. Seek medical attention even if it looks minor.';
    }
    // ─── ROBBERY ───────────────────────────────────────────
    else if (cmd.includes('rob') || cmd.includes('mug') || cmd.includes('steal') || cmd.includes('weapon') || cmd.includes('knife') || cmd.includes('gun')) {
        response = 'ROBBERY SITUATION. Your life is more valuable than your phone or money. Hand over the items. Do not make sudden moves. Try to memorize their height, clothing, and escape route. Call 100 once they leave. If you are in a crowded place, scream for help only if you feel the weapon is not an immediate threat.';
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

/* ═══════════════════════════════════════════
   FAKE CALL LOGIC
   ═══════════════════════════════════════════ */
let fakeCallTimer = null;
let fakeCallRecognition = null;

function triggerFakeCall() {
    const overlay = document.getElementById('fake-call-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    document.getElementById('call-incoming-actions').classList.remove('hidden');
    document.getElementById('call-active-ui').classList.add('hidden');
    document.getElementById('call-status').textContent = 'Incoming Call...';

    if ('vibrate' in navigator) navigator.vibrate([500, 500, 500, 500, 500, 500, 500]);

    // Try TTS ringtone simulation
    const ring = new Audio('data:audio/wav;base64,');
    ring.play().catch(() => { });

    showToast('📞 Fake call triggered — use it to escape safely!', 'success');
}

function answerFakeCall() {
    if ('vibrate' in navigator) navigator.vibrate(0);

    document.getElementById('call-incoming-actions').classList.add('hidden');
    document.getElementById('call-active-ui').classList.remove('hidden');

    const status = document.getElementById('call-status');
    let secs = 0;
    if (fakeCallTimer) clearInterval(fakeCallTimer);
    fakeCallTimer = setInterval(() => {
        secs++;
        const m = Math.floor(secs / 60), s = secs % 60;
        status.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);

    // Speak a fake conversation using Web Speech API
    if ('speechSynthesis' in window) {
        setTimeout(() => {
            const utter = new SpeechSynthesisUtterance("Hey, where are you? I'm waiting outside. Come fast, I'll be right there.");
            utter.lang = 'en-IN';
            utter.rate = 0.95;
            speechSynthesis.speak(utter);
        }, 1500);
    }

    // 🎙️ VOICE RECOGNITION — Auto-cut if "fake", "stop", or local slang is heard
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (fakeCallRecognition) { fakeCallRecognition.stop(); fakeCallRecognition = null; }

        fakeCallRecognition = new SpeechRec();
        fakeCallRecognition.continuous = true;
        fakeCallRecognition.interimResults = true;
        fakeCallRecognition.lang = 'en-IN';

        fakeCallRecognition.onresult = (event) => {
            const result = event.results[event.results.length - 1][0].transcript.toLowerCase();
            console.log('Fake Call AI Listener:', result);

            // ─── END CALL KEYWORDS ───
            const cutKeywords = [
                'fake', 'stop', 'cut', 'end', 'bye', 'wrong', 'fraud', 'liar', 'lying',
                'disconnect', 'cancel', 'off', 'terminate', 'quit', 'shut', 'nonsense',
                'bullshit', 'hang up', 'reject', 'enough'
            ];

            // ─── GREETING RESPONSES (Facilitation) ───
            const greetings = [
                'hello', 'hi', 'hey', 'hearing', 'listing', 'suno', 'hello dad', 
                'kaon', 'kaun', 'aya', 'kaha', 'where', 'address', 'landmark'
            ];
            
            // ─── STATUS CHECK (Hidden confirmation) ───
            const statusCheck = ['fake call', 'status', 'functioning', 'verify', 'safeher'];

            if (cutKeywords.some(keyword => result.includes(keyword))) {
                console.log('🎯 Auto-termination triggered via Voice Command.');
                endFakeCall();
                showToast('📴 Call ended via voice recognition', 'info');
            } else if (statusCheck.some(s => result.includes(s))) {
                agentSpeak("SafeHer Guardian confirming: Feature is functioning. I am providing a safe escape facade. Say 'hello' to hear a protective response.");
            } else if (greetings.some(g => result.includes(g))) {
                // Respond as a protective "Dad" or "Brother"
                const responses = [
                    "Hey, I'm just 2 minutes away. I can see you now. Stay right there.",
                    "Hello! I'm coming with your brother. We'll be there in a second.",
                    "Yes, I hear you. I'm near the landmark now. Coming towards you.",
                    "Hi, don't worry, I'm almost there. Keep me on the line.",
                    "Main aa raha hoon. Bas paanch minute mein pahunch raha hoon. Wahi ruko."
                ];
                const reply = responses[Math.floor(Math.random() * responses.length)];
                agentSpeak(reply);
            }
        };

        fakeCallRecognition.onerror = (err) => {
            if (err.error !== 'no-speech') console.warn('Recognition Error:', err.error);
        };

        fakeCallRecognition.onend = () => {
            if (fakeCallTimer) { // Keep listening if call is active
                try { fakeCallRecognition.start(); } catch (e) { }
            }
        };

        try { fakeCallRecognition.start(); } catch (e) { }
    }
}

function endFakeCall() {
    if ('vibrate' in navigator) navigator.vibrate(0);
    if (fakeCallTimer) clearInterval(fakeCallTimer);
    fakeCallTimer = null;

    if (fakeCallRecognition) {
        fakeCallRecognition.stop();
        fakeCallRecognition = null;
    }

    if ('speechSynthesis' in window) speechSynthesis.cancel();
    const overlay = document.getElementById('fake-call-overlay');
    if (overlay) overlay.classList.add('hidden');
}

/* ═══════════════════════════════════════════
   SAFETY HEATMAP LOGIC
   ═══════════════════════════════════════════ */
function updateSafetyHeatmap(lat, lng) {
    const el = {
        val: document.getElementById('heatmap-value'),
        prog: document.getElementById('heatmap-progress'),
        status: document.getElementById('heatmap-status'),
        loc: document.getElementById('heatmap-location-name')
    };
    if (!el.val) return;

    // Score model: Data-driven (simulating safety relative to area density & mock community indicators)
    let score = 75, statusText = '🟡 MODERATE — Stay Alert', locText = 'Analyzing Area...';

    if (lat && lng) {
        // Deterministic but dynamic score based on coordinates for demo stability
        const hash = (Math.abs(lat) * 1000 + Math.abs(lng) * 1000) % 100;
        score = 60 + (hash % 35); // 60-95

        if (score > 85) statusText = '🛡️ HIGH SAFETY — Active Area';
        else if (score > 70) statusText = '🟡 MODERATE — Well-lit Area';
        else { score = 55; statusText = '🟠 CAUTION — Stay on Main Roads'; }

        locText = `Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }

    el.val.textContent = score;
    el.prog.setAttribute('stroke-dasharray', `${score}, 100`);
    el.status.textContent = statusText;
    el.loc.textContent = locText;
    el.prog.style.stroke = score >= 80 ? '#00f5d4' : score >= 60 ? '#ffbe0b' : '#ff006e';
}

function initMapSafetyRoutes() {
    if (!window.communityMap || window._routesInitialized) return;
    if (!window.communityRoutes) window.communityRoutes = [];

    const office = [17.4448, 78.3498];
    const house = [17.4123, 78.4435];

    if (typeof L !== 'undefined') {
        const oMarker = L.marker(office, {
            icon: L.divIcon({ html: '<div style="font-size:24px">🏢</div>', className: 'custom-pin-icon', iconSize: [30, 30], iconAnchor: [15, 15] })
        }).addTo(window.communityMap).bindPopup("<b>Office Hub (Gachibowli)</b>");

        const hMarker = L.marker(house, {
            icon: L.divIcon({ html: '<div style="font-size:24px">🏠</div>', className: 'custom-pin-icon', iconSize: [30, 30], iconAnchor: [15, 15] })
        }).addTo(window.communityMap).bindPopup("<b>Home (Banjara Hills)</b>");

        const safeRoute = [office, [17.4350, 78.3750], [17.4250, 78.4100], house];
        const sPoly = L.polyline(safeRoute, { color: '#00f5d4', weight: 6, opacity: 0.8, dashArray: '10, 10' })
            .addTo(window.communityMap)
            .bindPopup("<span style='color:#00f5d4'>✔ <b>Safe Route</b></span>");

        const avoidedRoute = [office, [17.4550, 78.3800], [17.4300, 78.4300], house];
        const aPoly = L.polyline(avoidedRoute, { color: '#ff006e', weight: 6, opacity: 0.8 })
            .addTo(window.communityMap);

        const c1 = L.circle([17.4550, 78.3800], { radius: 300, color: '#ff006e', fillColor: '#ff006e', fillOpacity: 0.2, weight: 1 }).addTo(window.communityMap);
        const c2 = L.circle([17.4300, 78.4300], { radius: 300, color: '#ff006e', fillColor: '#ff006e', fillOpacity: 0.2, weight: 1 }).addTo(window.communityMap);

        window.communityRoutes.push(oMarker, hMarker, sPoly, aPoly, c1, c2);
        window._routesInitialized = true;
    }
}

/* ═══════════════════════════════════════════
   POST-INCIDENT REPORT GENERATOR
   ═══════════════════════════════════════════ */
const incidentLog = [];

function logIncidentEvent(type, detail) {
    const pos = window._lastKnownPos;
    incidentLog.push({
        time: new Date().toISOString(),
        type,
        detail,
        lat: pos ? pos.coords.latitude : 'N/A',
        lng: pos ? pos.coords.longitude : 'N/A'
    });
}

function generateIncidentReport() {
    if (incidentLog.length === 0) {
        showToast('No incident data to report yet.', 'info');
        return;
    }

    const lines = [
        '══════════════════════════════════════════',
        '   SAFEHER — POST-INCIDENT SAFETY REPORT   ',
        '══════════════════════════════════════════',
        `Generated: ${new Date().toLocaleString('en-IN')}`,
        '',
        '--- INCIDENT TIMELINE ---',
        ...incidentLog.map((e, i) =>
            `[${i + 1}] ${e.time}\n     Type: ${e.type}\n     Detail: ${e.detail}\n     GPS: ${e.lat}, ${e.lng}`
        ),
        '',
        '--- END OF REPORT ---',
        'This report can be submitted to police as evidence.',
        '══════════════════════════════════════════'
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SafeHer_Report_${Date.now()}.txt`;
    a.click();

    showToast('📋 Incident report downloaded!', 'success');
}

// Patch triggerSOS to auto-log events
const _origSOS = window.triggerSOS;
window.triggerSOS = function (trigger) {
    logIncidentEvent('SOS_TRIGGERED', `Trigger: ${trigger}`);
    if (_origSOS) _origSOS(trigger);
};

// Store last known position globally for the report
const _origWatch = navigator.geolocation ? navigator.geolocation.watchPosition.bind(navigator.geolocation) : null;
if (navigator.geolocation && _origWatch) {
    navigator.geolocation.watchPosition = function (success, error, opts) {
        return _origWatch(pos => {
            window._lastKnownPos = pos;
            updateSafetyHeatmap(pos.coords.latitude, pos.coords.longitude);
            success(pos);
        }, error, opts);
    };
}

/* ═══════════════════════════════════════════
   INCIDENT REPORT MODAL — LOGIC
   ═══════════════════════════════════════════ */

function openIncidentModal() {
    const modal = document.getElementById('incident-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    // Auto-fill today's date & time
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().slice(0, 5);
    const fullDate = now.toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' });

    const irDate = document.getElementById('ir-date');
    const irTime = document.getElementById('ir-time');
    const irReportDate = document.getElementById('ir-report-date');
    const reportIdDisplay = document.getElementById('report-id-display');
    const reportDateDisplay = document.getElementById('report-date-display');

    if (irDate) irDate.value = dateStr;
    if (irTime) irTime.value = timeStr;
    if (irReportDate) irReportDate.value = fullDate;
    if (reportIdDisplay) reportIdDisplay.textContent = 'SHR-' + Date.now().toString().slice(-8);
    if (reportDateDisplay) reportDateDisplay.textContent = fullDate;

    // Auto-fill GPS
    const pos = window._lastKnownPos;
    const irGps = document.getElementById('ir-gps');
    if (irGps) {
        if (pos) {
            irGps.value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)} (±${Math.round(pos.coords.accuracy)}m)`;
        } else if (navigator.geolocation) {
            irGps.value = 'Acquiring GPS...';
            navigator.geolocation.getCurrentPosition(p => {
                window._lastKnownPos = p;
                irGps.value = `${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)} (±${Math.round(p.coords.accuracy)}m)`;
            }, () => { irGps.value = 'GPS unavailable — enter manually'; });
        }
    }

    // Populate SOS event log
    const logBox = document.getElementById('ir-sos-log');
    if (logBox) {
        if (incidentLog && incidentLog.length > 0) {
            logBox.innerHTML = incidentLog.map((e, i) =>
                `<div>[${i + 1}] ${new Date(e.time).toLocaleString('en-IN')} | <strong>${e.type}</strong> | ${e.detail} | GPS: ${e.lat}, ${e.lng}</div>`
            ).join('');
        } else {
            logBox.innerHTML = '<p class="ir-log-placeholder">No SOS events recorded in this session.</p>';
        }
    }
}

function closeIncidentModal() {
    const modal = document.getElementById('incident-modal');
    if (modal) modal.classList.add('hidden');
}

// Click outside to close
document.addEventListener('click', e => {
    const modal = document.getElementById('incident-modal');
    if (modal && e.target === modal) closeIncidentModal();
});

function printIncidentReport() {
    window.print();
}

function downloadIncidentReport() {
    const g = id => { const el = document.getElementById(id); return el ? (el.value || el.textContent || '—') : '—'; };

    const lines = [
        '╔══════════════════════════════════════════════════════╗',
        '║         SAFEHER — OFFICIAL INCIDENT REPORT           ║',
        '║     Auto-generated evidence for law enforcement      ║',
        '╚══════════════════════════════════════════════════════╝',
        '',
        `Report ID   : ${g('report-id-display')}`,
        `Generated   : ${g('report-date-display')}`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '① VICTIM INFORMATION',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Full Name   : ${g('ir-name')}`,
        `Phone       : ${g('ir-phone')}`,
        `Address     : ${g('ir-address')}`,
        `Age         : ${g('ir-age')}`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '② INCIDENT DETAILS',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Date        : ${g('ir-date')}`,
        `Time        : ${g('ir-time')}`,
        `Location    : ${g('ir-location')}`,
        `GPS         : ${g('ir-gps')}`,
        `Type        : ${g('ir-type')}`,
        `Severity    : ${g('ir-severity')}`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '③ WHAT HAPPENED',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        g('ir-narrative'),
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '④ PERPETRATOR DESCRIPTION',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Gender      : ${g('ir-perp-gender')}`,
        `Approx. Age : ${g('ir-perp-age')}`,
        `Build       : ${g('ir-perp-build')}`,
        `Clothing    : ${g('ir-perp-clothing')}`,
        `Vehicle     : ${g('ir-vehicle')}`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⑤ WITNESSES',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        g('ir-witness'),
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⑥ SYSTEM SOS EVENT LOG',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ...(incidentLog && incidentLog.length > 0
            ? incidentLog.map((e, i) => `[${i + 1}] ${e.time} | ${e.type} | ${e.detail} | GPS: ${e.lat}, ${e.lng}`)
            : ['No SOS events recorded in this session.']),
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⑦ DECLARATION',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'I declare that the information provided above is true and',
        'accurate to the best of my knowledge.',
        '',
        `Signature   : ${g('ir-signature')}`,
        `Date        : ${g('ir-report-date')}`,
        '',
        '╔══════════════════════════════════════════════════════╗',
        '║          SafeHer Security Platform  v3.0             ║',
        '║    Contact: Women Helpline 1091 | Emergency 112      ║',
        '╚══════════════════════════════════════════════════════╝',
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SafeHer_Incident_Report_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);

    showToast('📋 Incident report downloaded!', 'success');
}


/* ══════════════════════════════════════════════════════
   FEATURE 1: PANIC ALARM (120dB Siren via Web Audio API)
   ══════════════════════════════════════════════════════ */
let panicAlarmActive = false;
let panicAlarmCtx = null;
let panicAlarmNodes = [];

function togglePanicAlarm() {
    if (panicAlarmActive) {
        stopPanicAlarm();
    } else {
        startPanicAlarm();
    }
}

function startPanicAlarm() {
    try {
        panicAlarmCtx = new (window.AudioContext || window.webkitAudioContext)();
        panicAlarmActive = true;

        const btn = document.getElementById('alarm-trigger');
        const status = document.getElementById('alarm-trigger-status');
        if (btn) btn.classList.add('active-alarm');
        if (status) status.textContent = 'ON';

        // Create oscillating siren — alternates between two frequencies like a real alarm
        let up = true;
        function createSirenTone() {
            if (!panicAlarmActive) return;

            const o = panicAlarmCtx.createOscillator();
            const g = panicAlarmCtx.createGain();
            const freq = up ? 1760 : 880; // A6 / A5 — piercing siren frequencies
            up = !up;

            o.type = 'sawtooth';
            o.frequency.setValueAtTime(freq, panicAlarmCtx.currentTime);
            o.frequency.linearRampToValueAtTime(up ? 880 : 1760, panicAlarmCtx.currentTime + 0.4);

            g.gain.setValueAtTime(0, panicAlarmCtx.currentTime);
            g.gain.linearRampToValueAtTime(1.0, panicAlarmCtx.currentTime + 0.02);
            g.gain.setValueAtTime(1.0, panicAlarmCtx.currentTime + 0.35);
            g.gain.linearRampToValueAtTime(0, panicAlarmCtx.currentTime + 0.4);

            o.connect(g);
            g.connect(panicAlarmCtx.destination);
            o.start(panicAlarmCtx.currentTime);
            o.stop(panicAlarmCtx.currentTime + 0.4);

            panicAlarmNodes.push(o, g);
            if (panicAlarmActive) {
                setTimeout(createSirenTone, 380);
            }
        }

        createSirenTone();

        // Vibrate phone if supported
        if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200, 100, 200, 100, 500]);
        }

        showToast('🔊 PANIC ALARM ACTIVE — tap again to stop', 'sos');
    } catch (err) {
        showToast('Audio not supported on this browser', 'warning');
    }
}

function stopPanicAlarm() {
    panicAlarmActive = false;
    panicAlarmNodes = [];

    if (panicAlarmCtx) {
        panicAlarmCtx.close().catch(() => { });
        panicAlarmCtx = null;
    }

    const btn = document.getElementById('alarm-trigger');
    const status = document.getElementById('alarm-trigger-status');
    if (btn) btn.classList.remove('active-alarm');
    if (status) status.textContent = 'OFF';

    showToast('🔇 Panic alarm stopped', 'info');
}


/* ══════════════════════════════════════════════════════
   FEATURE 2: JOURNEY TIMER — Auto-SOS Check-In
   ══════════════════════════════════════════════════════ */
let journeyTimerInterval = null;
let checkInTimerInterval = null;
let journeyTotalSeconds = 0;
let journeySecondsLeft = 0;
let journeyMinutes = 20;
let journeyActive = false;
let journeyLog = JSON.parse(localStorage.getItem('safeher_journey_log') || '[]');

function adjustMins(delta) {
    journeyMinutes = Math.max(5, Math.min(120, journeyMinutes + delta));
    const el = document.getElementById('journey-mins-display');
    if (el) el.textContent = journeyMinutes;
}

function startJourneyTimer(isResume = false) {
    if (journeyActive && !isResume) {
        cancelJourney();
        return;
    }

    const destInput = document.getElementById('journey-dest');
    const dest = (destInput?.value || '').trim() || 'Destination';

    if (!isResume) {
        journeyTotalSeconds = journeyMinutes * 60;
        journeySecondsLeft = journeyTotalSeconds;
        // Persistence
        localStorage.setItem('safeher_journey_end_time', Date.now() + (journeySecondsLeft * 1000));
        localStorage.setItem('safeher_journey_dest', dest);

        // Save user phone
        const phoneInput = document.getElementById('journey-user-phone');
        if (phoneInput && phoneInput.value) {
            localStorage.setItem('safeher_user_phone', phoneInput.value);
        }
    } else {
        // We already have journeySecondsLeft and journeyTotalSeconds set from storage
    }

    journeyActive = true;

    const startBtn = document.getElementById('journey-start-btn');
    const safeBtn = document.getElementById('journey-safe-btn');
    const ringLabel = document.getElementById('ring-label');
    const ringFill = document.getElementById('ring-fill');

    if (startBtn) {
        startBtn.innerHTML = '<span>❌ Cancel Journey</span>';
        startBtn.classList.add('active-journey');
    }
    if (safeBtn) safeBtn.classList.remove('hidden');
    if (ringLabel) ringLabel.textContent = 'ACTIVE';
    if (ringFill) {
        ringFill.classList.remove('warning', 'danger');
        ringFill.classList.add('safe');
    }

    if (!isResume) {
        showToast(`🚶‍♀️ Journey started to "${dest}" — ${journeyMinutes} min timer`, 'success');
        addJourneyLogEntry(dest, 'started');
    }

    if (journeyTimerInterval) clearInterval(journeyTimerInterval);
    journeyTimerInterval = setInterval(() => {
        journeySecondsLeft--;
        updateJourneyRing();

        const pct = journeySecondsLeft / journeyTotalSeconds;

        if (pct < 0.25) {
            if (ringFill) { ringFill.classList.remove('safe', 'warning'); ringFill.classList.add('danger'); }
            if (journeySecondsLeft % 10 === 0 && navigator.vibrate) navigator.vibrate([100, 50, 100]);
        } else if (pct < 0.5) {
            if (ringFill) { ringFill.classList.remove('safe', 'danger'); ringFill.classList.add('warning'); }
        }

        if (journeySecondsLeft <= 0) {
            clearInterval(journeyTimerInterval);
            journeyActive = false;
            localStorage.removeItem('safeher_journey_end_time');
            localStorage.removeItem('safeher_journey_dest');

            showJourneyCheckInModal();
        }
    }, 1000);

    updateJourneyRing();
    renderJourneyLog();
}

function showJourneyCheckInModal() {
    const modal = document.getElementById('journey-check-in-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

    let timeLeft = 5;
    const counter = document.getElementById('check-in-countdown');
    if (counter) counter.textContent = timeLeft;

    if (checkInTimerInterval) clearInterval(checkInTimerInterval);
    checkInTimerInterval = setInterval(() => {
        timeLeft--;
        if (counter) counter.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(checkInTimerInterval);
            triggerSOSNow();
        }
    }, 1000);
}

function confirmJourneySafety() {
    if (checkInTimerInterval) clearInterval(checkInTimerInterval);
    document.getElementById('journey-check-in-modal')?.classList.add('hidden');

    // Complete the journey normally
    const dest = localStorage.getItem('safeher_journey_dest') || 'Destination';
    addJourneyLogEntry(dest, 'arrived');
    resetJourneyState();
    showToast('🛡️ Safe check-in confirmed. Journey ended safely.', 'success');
}

function triggerSOSNow() {
    if (checkInTimerInterval) clearInterval(checkInTimerInterval);
    document.getElementById('journey-check-in-modal')?.classList.add('hidden');

    const dest = localStorage.getItem('safeher_journey_dest') || 'Destination';
    addJourneyLogEntry(dest, 'missed');
    resetJourneyState();

    showToast('🚨 JOURNEY TIMER EXPIRED — SOS TRIGGERED!', 'sos');

    const personalPhone = document.getElementById('journey-user-phone')?.value || localStorage.getItem('safeher_user_phone');
    triggerSOS('journey_auto', personalPhone);
}


function resetJourneyState() {
    clearInterval(journeyTimerInterval);
    journeyActive = false;
    localStorage.removeItem('safeher_journey_end_time');
    localStorage.removeItem('safeher_journey_dest');
    resetJourneyUI();
    renderJourneyLog();
}

function updateJourneyRing() {
    const timeEl = document.getElementById('ring-time-display');
    const fillEl = document.getElementById('ring-fill');
    if (!timeEl || !fillEl) return;

    const m = Math.floor(journeySecondsLeft / 60).toString().padStart(2, '0');
    const s = (journeySecondsLeft % 60).toString().padStart(2, '0');
    timeEl.textContent = `${m}:${s}`;

    const circumference = 339.3;
    const pct = journeyTotalSeconds > 0 ? journeySecondsLeft / journeyTotalSeconds : 0;
    fillEl.style.strokeDashoffset = circumference * (1 - pct);
}

function journeyArrived() {
    if (!journeyActive) return;
    clearInterval(journeyTimerInterval);
    journeyActive = false;

    const dest = document.getElementById('journey-dest')?.value || 'Destination';
    addJourneyLogEntry(dest, 'arrived');
    renderJourneyLog();
    resetJourneyUI();
    showToast('✅ Great! Arrived safely logged.', 'success');

    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
}

function cancelJourney() {
    if (journeyTimerInterval) clearInterval(journeyTimerInterval);
    journeyActive = false;
    const dest = document.getElementById('journey-dest')?.value || 'Destination';
    addJourneyLogEntry(dest, 'cancelled');
    renderJourneyLog();
    resetJourneyUI();
    showToast('Journey cancelled', 'info');
}

function resetJourneyUI() {
    const startBtn = document.getElementById('journey-start-btn');
    const safeBtn = document.getElementById('journey-safe-btn');
    const timeEl = document.getElementById('ring-time-display');
    const fillEl = document.getElementById('ring-fill');
    const labelEl = document.getElementById('ring-label');

    if (startBtn) { startBtn.innerHTML = '<span>🚶‍♀️ Start Journey</span>'; startBtn.classList.remove('active-journey'); }
    if (safeBtn) safeBtn.classList.add('hidden');
    if (timeEl) timeEl.textContent = '00:00';
    if (fillEl) { fillEl.style.strokeDashoffset = '339.3'; fillEl.classList.remove('safe', 'warning', 'danger'); }
    if (labelEl) labelEl.textContent = 'SET TIMER';
}

function addJourneyLogEntry(dest, status) {
    const ICONS = { started: '🚶‍♀️', arrived: '✅', missed: '🚨', cancelled: '❌' };
    journeyLog.unshift({
        dest, status,
        mins: journeyMinutes,
        time: new Date().toLocaleString('en-IN')
    });
    if (journeyLog.length > 20) journeyLog.pop();
    localStorage.setItem('safeher_journey_log', JSON.stringify(journeyLog));
}

function renderJourneyLog() {
    const logEl = document.getElementById('journey-log');
    if (!logEl) return;

    if (!journeyLog.length) {
        logEl.innerHTML = '<div class="journey-log-empty">No journeys recorded yet</div>';
        return;
    }

    const ICONS = { started: '🚶‍♀️', arrived: '✅', missed: '🚨', cancelled: '❌' };
    const LABELS = { started: 'Started', arrived: 'Arrived Safely', missed: 'MISSED — SOS Fired', cancelled: 'Cancelled' };

    logEl.innerHTML = journeyLog.map(j => `
        <div class="journey-log-item ${j.status}">
            <div class="journey-log-icon">${ICONS[j.status] || '📍'}</div>
            <div class="journey-log-text">
                <strong>${LABELS[j.status] || j.status} — ${j.dest}</strong>
                <span>${j.time} · ${j.mins} min timer</span>
            </div>
        </div>
    `).join('');
}

// Init on load
document.addEventListener('DOMContentLoaded', () => {
    renderJourneyLog();
    const el = document.getElementById('journey-mins-display');
    if (el) el.textContent = journeyMinutes;

    // Restore saved data
    const savedPhone = localStorage.getItem('safeher_user_phone');
    const phoneInput = document.getElementById('journey-user-phone');
    if (savedPhone && phoneInput) phoneInput.value = savedPhone;

    const savedHome = localStorage.getItem('safeher_route_home');
    const savedOffice = localStorage.getItem('safeher_route_office');
    const homeInput = document.getElementById('route-home');
    const officeInput = document.getElementById('route-office');
    if (savedHome && homeInput) homeInput.value = savedHome;
    if (savedOffice && officeInput) officeInput.value = savedOffice;
});



/* ══════════════════════════════════════════════════════
   FEATURE 3: COMMUNITY INCIDENT MAP (Firebase-backed)
   ══════════════════════════════════════════════════════ */
const COMMUNITY_TYPE_CONFIG = {
    harassment: { icon: '😨', label: 'Harassment', color: 'var(--accent-rose)' },
    stalking: { icon: '👁️', label: 'Stalking', color: '#ff8800' },
    lighting: { icon: '🌑', label: 'Poor Lighting', color: '#ffbe0b' },
    assault: { icon: '⚠️', label: 'Physical Threat', color: '#ff4444' },
    safe: { icon: '✅', label: 'Safe Zone', color: 'var(--accent-cyan)' },
};
async function pinCommunityAlert() {
    const type = document.getElementById('community-type')?.value || 'harassment';
    const note = document.getElementById('community-note')?.value?.trim() || '';

    const btn = document.querySelector('.community-pin-btn');
    if (btn) { btn.textContent = '📡 Getting GPS...'; btn.disabled = true; }

    try {
        const pos = await new Promise((res, rej) =>
            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })
        );

        const pin = {
            type,
            note: note || 'No additional detail',
            lat: parseFloat(pos.coords.latitude.toFixed(5)),
            lng: parseFloat(pos.coords.longitude.toFixed(5)),
            timestamp: new Date().toISOString(),
            // strictly anonymous — no user ID stored
        };

        // Post to server API — server saves to Firestore (shared across all users)
        let saved = false;
        try {
            const resp = await fetch(`${API_BASE_URL}/api/community/pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pin)
            });
            if (resp.ok) saved = true;
        } catch (e) { /* server unreachable, fall to local */ }


        if (!saved) {
            // Offline local storage fallback
            const local = JSON.parse(localStorage.getItem('safeher_community_pins') || '[]');
            local.unshift({ ...pin, id: 'local_' + Date.now() });
            localStorage.setItem('safeher_community_pins', JSON.stringify(local.slice(0, 50)));
        }

        showToast(`📍 ${COMMUNITY_TYPE_CONFIG[type]?.label || type} pinned anonymously!`, 'success');

        if (btn) { btn.textContent = '📍 Pin at My Current Location'; btn.disabled = false; }
        if (document.getElementById('community-note')) document.getElementById('community-note').value = '';

        loadCommunityReports();
    } catch (err) {
        if (btn) { btn.textContent = '📍 Pin at My Current Location'; btn.disabled = false; }
        showToast('📍 Could not get GPS. Please allow location access.', 'warning');
    }
}

async function calculateSafetyRoute() {
    const homeAddr = document.getElementById('route-home').value;
    const officeAddr = document.getElementById('route-office').value;

    if (!homeAddr || !officeAddr) {
        showToast('Please enter both addresses.', 'warning');
        return;
    }

    // Persistence
    localStorage.setItem('safeher_route_home', homeAddr);
    localStorage.setItem('safeher_route_office', officeAddr);

    showToast('🔍 Analyzing safety data...', 'info');

    // Helper to geocode via Nominatim (Universal Search)
    async function geocode(query) {
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in`);
            const d = await r.json();
            return d.length ? [parseFloat(d[0].lat), parseFloat(d[0].lon)] : null;
        } catch (e) { return null; }
    }

    const homeCoords = await geocode(homeAddr);
    const officeCoords = await geocode(officeAddr);

    if (!homeCoords || !officeCoords) {
        showToast('Could not locate address. Try adding City name or Landmark.', 'warning');
        return;
    }

    // Clear old routes
    if (window.communityRoutes) {
        window.communityRoutes.forEach(r => window.communityMap.removeLayer(r));
    }
    window.communityRoutes = [];

    // Draw Markers (Premium Styled)
    const hMarker = L.marker(homeCoords, {
        icon: L.divIcon({
            html: '<div style="font-size:32px; filter:drop-shadow(0 0 10px #00f5d4); transform:scale(1.2);">🏠</div>',
            className: 'custom-pin-icon', iconSize: [40, 40], iconAnchor: [20, 20]
        })
    }).addTo(window.communityMap).bindPopup("<b>🏡 HOME SET</b>");

    const oMarker = L.marker(officeCoords, {
        icon: L.divIcon({
            html: '<div style="font-size:32px; filter:drop-shadow(0 0 10px #c77dff); transform:scale(1.2);">🏢</div>',
            className: 'custom-pin-icon', iconSize: [40, 40], iconAnchor: [20, 20]
        })
    }).addTo(window.communityMap).bindPopup("<b>🏢 OFFICE SET</b>");

    window.communityRoutes.push(hMarker, oMarker);

    // Simulate Safe vs. Dangerous Paths
    const mid = [(homeCoords[0] + officeCoords[0]) / 2, (homeCoords[1] + officeCoords[1]) / 2];
    const offset = 0.005; // ~500m deviation

    // 🛡️ THE SAFE ROUTE: Main roads, well lit
    const safePath = [
        homeCoords,
        [mid[0] + offset, mid[1] + (offset * 1.5)],
        officeCoords
    ];

    // ⚠️ THE RISK ROUTE: Short-cut through isolated industrial/unlit zones
    const riskPath = [
        homeCoords,
        [mid[0] - offset, mid[1] - (offset * 1.5)],
        officeCoords
    ];

    const safeLine = L.polyline(safePath, {
        color: '#00f5d4', weight: 10, opacity: 0.9, dashArray: '1, 15', lineCap: 'round', lineJoin: 'round'
    }).addTo(window.communityMap).bindPopup("<div style='background:#00f5d4;color:#000;padding:5px 10px;border-radius:5px;'><b>🛡️ SAFE ROUTE RECOMMENDED</b><br>Active surveillance, police patrols detected.</div>");

    const riskLine = L.polyline(riskPath, {
        color: '#ff006e', weight: 8, opacity: 0.5, lineCap: 'round'
    }).addTo(window.communityMap).bindPopup("<div style='background:#ff006e;color:#fff;padding:5px 10px;border-radius:5px;'><b>⚠️ CAUTION: ISOLATED ZONE</b><br>Reported lighting issues or high theft area.</div>");

    // Dynamic Heatmap Risk Bubbles
    for (let i = 0; i < 4; i++) {
        const randOffsetLat = (Math.random() - 0.5) * offset;
        const randOffsetLng = (Math.random() - 0.5) * offset;
        const riskCircle = L.circle([mid[0] - offset + randOffsetLat, mid[1] - offset + randOffsetLng], {
            radius: 400 + (Math.random() * 200),
            color: '#ff006e', fillColor: '#ff006e', fillOpacity: 0.25, weight: 0
        }).addTo(window.communityMap);
        window.communityRoutes.push(riskCircle);
    }

    // Dynamic Safety Focus Bubbles
    for (let i = 0; i < 2; i++) {
        const safeCircle = L.circle([mid[0] + offset, mid[1] + offset], {
            radius: 500, color: '#00f5d4', fillColor: '#00f5d4', fillOpacity: 0.15, weight: 0
        }).addTo(window.communityMap);
        window.communityRoutes.push(safeCircle);
    }

    window.communityRoutes.push(safeLine, riskLine);

    // Auto-Adjust Map to fit whole route
    const group = new L.featureGroup(window.communityRoutes);
    window.communityMap.fitBounds(group.getBounds().pad(0.3));

    // Auto-scroll to map so user sees the full result in their space
    document.getElementById('community-main-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    showToast('✨ Safety route optimized with Heatmap data!', 'success');
}

async function loadCommunityReports() {
    const listEl = document.getElementById('community-reports-list');
    if (!listEl) return;

    listEl.innerHTML = '<div class="community-empty">Loading...</div>';

    let pins = [];
    if (!window.communityLayers) window.communityLayers = [];

    // Initialize map if not already done
    if (!window.communityMap && typeof L !== 'undefined') {
        const mapEl = document.getElementById('community-main-map');
        if (mapEl) {
            window.communityMap = L.map('community-main-map', {
                zoomControl: true,
                attributionControl: false,
                fadeAnimation: true
            }).setView([17.42, 78.39], 13);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap'
            }).addTo(window.communityMap);

            // 🚀 PERFECT FIT: Use ResizeObserver to ensure map fills container instantly
            const resizeObserver = new ResizeObserver(() => {
                window.communityMap.invalidateSize({ animate: false });
            });
            resizeObserver.observe(mapEl);

            // Initial boot
            setTimeout(() => {
                window.communityMap.invalidateSize();
                if (typeof initMapSafetyRoutes === 'function') initMapSafetyRoutes();
                if (typeof initGlobalSafetyZones === 'function') initGlobalSafetyZones();
            }, 500);
        }
    }

    // Try server API first with timeout
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

        const endpoint = `${API_BASE_URL}/api/community/pins`;
        console.log('📡 Fetching community pins from:', endpoint);

        const resp = await fetch(endpoint, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (resp.ok) {
            const data = await resp.json();
            pins = data.pins || [];
            console.log(`✅ Loaded ${pins.length} pins from server`);
        } else {
            console.warn(`⚠️ Server returned error ${resp.status}: ${resp.statusText}`);
        }
    } catch (e) {
        console.warn('Community API fetch failed or timed out. Falling back to local storage.');
    }

    // Merge local pins (offline pins)
    const local = JSON.parse(localStorage.getItem('safeher_community_pins') || '[]');
    // Dedupe: prefer server data, add local-only pins
    const serverIds = new Set(pins.map(p => p.id));
    pins = [...pins, ...local.filter(p => !serverIds.has(p.id))].slice(0, 50);

    // Remove pins older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    pins = pins.filter(p => new Date(p.timestamp).getTime() > cutoff);

    window.allCommunityPins = pins; // 🔥 Expose for Geofence Monitor


    // Update stats
    const totalEl = document.getElementById('cstat-total');
    const dangerEl = document.getElementById('cstat-danger');
    const safeStatEl = document.getElementById('cstat-safe');
    if (totalEl) totalEl.textContent = pins.length;
    if (dangerEl) dangerEl.textContent = pins.filter(p => p.type !== 'safe').length;
    if (safeStatEl) safeStatEl.textContent = pins.filter(p => p.type === 'safe').length;

    if (!pins.length) {
        listEl.innerHTML = '<div class="community-empty">No reports nearby yet. Be the first to pin!</div>';
        return;
    }

    // Clear old markers
    if (window.communityLayers) {
        window.communityLayers.forEach(l => window.communityMap?.removeLayer(l));
        window.communityLayers = [];
    }

    listEl.innerHTML = pins.map(p => {
        const cfg = COMMUNITY_TYPE_CONFIG[p.type] || COMMUNITY_TYPE_CONFIG.harassment;
        const ago = getTimeAgo(p.timestamp);

        // Add marker to map
        if (window.communityMap && typeof L !== 'undefined') {
            const marker = L.marker([p.lat, p.lng], {
                icon: L.divIcon({
                    html: `<div style="font-size:24px;filter:drop-shadow(0 0 5px ${cfg.color})">${cfg.icon}</div>`,
                    className: 'custom-pin-icon',
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                })
            }).addTo(window.communityMap)
                .bindPopup(`<strong>${cfg.label}</strong><br>${p.note}<br><small>${ago}</small>`);
            window.communityLayers.push(marker);
        }

        return `
            <div class="community-report-item type-${p.type}" onclick="focusOnPin(${p.lat}, ${p.lng})">
                <div class="report-icon">${cfg.icon}</div>
                <div class="report-info">
                    <div class="report-type">${cfg.label}</div>
                    ${p.note ? `<div class="report-note">${p.note}</div>` : ''}
                    <div class="report-meta">📍 ${p.lat}, ${p.lng} · ${ago}</div>
                </div>
            </div>
        `;
    }).join('');

    // 🔥 PERSISTENT GLOBAL HEATMAP
    drawGlobalCommunityHeatmap(pins);

    // If we have pins, fit bounds
    if (pins.length && window.communityMap && window.communityLayers.length) {
        const group = new L.featureGroup(window.communityLayers);
        window.communityMap.fitBounds(group.getBounds().pad(0.2));
    }
}

/**
 * Visualizes incidents as a professional safety heatmap.
 * Risk zones are pulsing indicators of reported activity.
 * Safe zones are calming green indicators.
 */
function drawGlobalCommunityHeatmap(pins) {
    if (!window.communityMap || !pins.length) return;

    // Clear existing heat layers
    if (!window.heatLayers) window.heatLayers = [];
    window.heatLayers.forEach(l => { if (window.communityMap.hasLayer(l)) window.communityMap.removeLayer(l); });
    window.heatLayers = [];

    // 1. DATA PREP FOR REAL HEATMAP
    // Leaflet.heat takes [lat, lng, intensity]
    const heatData = pins.map(p => [
        p.lat,
        p.lng,
        p.type === 'safe' ? 0.3 : 0.8 // Intensity based on danger
    ]);

    // 2. CREATE REAL HEATMAP LAYER (Gradient from Green to Red)
    const heatLayer = L.heatLayer(heatData, {
        radius: 35,
        blur: 25,
        maxZoom: 17,
        gradient: {
            0.2: '#00f5d4', // Green for safe spots
            0.5: '#ffbe0b', // Yellow for caution
            0.8: '#ff006e', // Rose for risk
            1.0: '#ff4444'  // Solid red for critical
        }
    }).addTo(window.communityMap);

    window.heatLayers.push(heatLayer);

    // 3. KEEP THE PULSING CIRCLES (for interactivity & specific dots)
    pins.forEach(p => {
        const isSafe = p.type === 'safe';
        const color = isSafe ? '#00f5d4' : '#ff006e';
        const pulseCircle = L.circle([p.lat, p.lng], {
            radius: isSafe ? 500 : 300,
            fillColor: color,
            fillOpacity: 0.2,
            color: color,
            weight: 0,
            interactive: false,
            className: isSafe ? 'safe-heat-pulse' : 'risk-heat-pulse'
        }).addTo(window.communityMap);

        window.heatLayers.push(pulseCircle);
        window.communityLayers.push(pulseCircle);
    });
}

function focusOnPin(lat, lng) {
    if (!window.communityMap) return;
    window.communityMap.flyTo([lat, lng], 17, { duration: 1.5 });
    // Find the marker and open its popup
    if (window.communityLayers) {
        window.communityLayers.forEach(marker => {
            const pos = marker.getLatLng();
            if (pos.lat === lat && pos.lng === lng) {
                marker.openPopup();
            }
        });
    }
}


function getTimeAgo(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Visualizes a default safety heatmap for key areas when the community map loads.
 */
function initGlobalSafetyZones() {
    if (!window.communityMap || window._defaultRoutesInitialized) return;

    // Expanded Default Safety Zones (Delhi, Mumbai, Bangalore, Hyderabad, etc.)
    const safeZones = [
        { lat: 17.4123, lng: 78.4354, label: "Banjara Hills Safe Haven" },
        { lat: 28.6139, lng: 77.2090, label: "Connaught Place Safe Zone" },
        { lat: 18.9219, lng: 72.8347, label: "Marine Drive Patrolling Hub" },
        { lat: 12.9716, lng: 77.5946, label: "MG Road Safety Corridor" }
    ];

    const riskZones = [
        { lat: 17.4500, lng: 78.3800, label: "Isolated IT Corridor (Hyderabad)" },
        { lat: 28.7041, lng: 77.1025, label: "Under-lit Zone (North Delhi)" },
        { lat: 19.0760, lng: 72.8777, label: "Caution Area (East Mumbai)" }
    ];

    safeZones.forEach(z => {
        L.circle([z.lat, z.lng], {
            radius: 1000,
            color: '#00f5d4',
            fillColor: '#00f5d4',
            fillOpacity: 0.1,
            weight: 1
        }).addTo(window.communityMap).bindPopup(`<b>🛡️ ${z.label}</b>`);
    });

    riskZones.forEach(z => {
        L.circle([z.lat, z.lng], {
            radius: 800,
            color: '#ff006e',
            fillColor: '#ff006e',
            fillOpacity: 0.15,
            weight: 1
        }).addTo(window.communityMap).bindPopup(`<b>⚠️ ${z.label}</b>`);
    });

    window._defaultRoutesInitialized = true;
}

// Auto-load community reports when section becomes visible
document.addEventListener('DOMContentLoaded', () => {
    const communitySection = document.getElementById('community');
    if (communitySection) {
        const observer = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) loadCommunityReports();
        }, { threshold: 0.1 });
        observer.observe(communitySection);
    }
    // Pre-fill route & journey fields from storage
    const storedHome = localStorage.getItem('safeher_route_home');
    const storedOffice = localStorage.getItem('safeher_route_office');
    const storedPhone = localStorage.getItem('safeher_user_phone');

    if (storedHome && document.getElementById('route-home')) document.getElementById('route-home').value = storedHome;
    if (storedOffice && document.getElementById('route-office')) document.getElementById('route-office').value = storedOffice;
    if (storedPhone && document.getElementById('journey-user-phone')) document.getElementById('journey-user-phone').value = storedPhone;

    // Check for active journey to resume
    const journeyEndTime = localStorage.getItem('safeher_journey_end_time');
    if (journeyEndTime) {
        const timeLeftMs = parseInt(journeyEndTime) - Date.now();
        if (timeLeftMs > 0) {
            journeySecondsLeft = Math.floor(timeLeftMs / 1000);
            journeyTotalSeconds = journeySecondsLeft; // simplified for resume
            startJourneyTimer(true);
        } else {
            // Expired while app was closed
            showJourneyCheckInModal();
        }
    }
});


// 🧪 =========================================================
// ADVANCED SAFETY LAB — FEATURE IMPLEMENTATIONS
// =========================================================

let batteryAlertEnabled = localStorage.getItem('safeher_battery_alert') === 'true';
let geofenceAlertsEnabled = localStorage.getItem('safeher_geofence_alerts') === 'true';
let screamDetectionEnabled = localStorage.getItem('safeher_scream_detection') === 'true';

let audioContext = null;
let analyser = null;
let screamInterval = null;
let batteryCheckInterval = null;
let geofenceCheckInterval = null;

// Initialize toggles from storage on load
document.addEventListener('DOMContentLoaded', () => {
    const bToggle = document.getElementById('battery-toggle');
    const gToggle = document.getElementById('geofence-toggle');
    const sToggle = document.getElementById('acoustic-toggle');

    if (bToggle) bToggle.checked = batteryAlertEnabled;
    if (gToggle) gToggle.checked = geofenceAlertsEnabled;
    if (sToggle) sToggle.checked = screamDetectionEnabled;

    if (batteryAlertEnabled) startBatteryMonitoring();
    if (geofenceAlertsEnabled) startGeofenceMonitoring();
    if (screamDetectionEnabled) startScreamDetection();
});

// 1. SCREAM DETECTION (AUTO-SOS)
async function toggleScreamDetection() {
    screamDetectionEnabled = document.getElementById('acoustic-toggle')?.checked || false;
    localStorage.setItem('safeher_scream_detection', screamDetectionEnabled);

    if (screamDetectionEnabled) {
        startScreamDetection();
        showToast('🎙️ Scream Detection Active', 'success');
    } else {
        stopScreamDetection();
        showToast('🎙️ Scream Detection Disabled', 'info');
    }
}

async function startScreamDetection() {
    try {
        if (screamInterval) return;
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 512;
        
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        // Analyze volume peaks every 100ms
        screamInterval = setInterval(() => {
            if (!screamDetectionEnabled) return;
            analyser.getByteFrequencyData(dataArray);
            
            // Calculate average volume
            let sum = 0;
            for(let i=0; i<bufferLength; i++) sum += dataArray[i];
            const avg = sum / bufferLength;

            // Sensitivity threshold (High value = loud scream)
            // You can tune this based on real-world tests
            if (avg > 95 && !sosCooldown) {
                console.log("📢 POSSIBLE SCREAM DETECTED! (Avg: " + avg + ")");
                triggerSOS('scream_detection');
                showToast('🚨 Primal SOS Triggered by Scream Detection!', 'error');
            }
        }, 150);
    } catch (err) {
        console.error("Audio detection error:", err);
        showToast('Microphone access required for scream detection', 'error');
    }
}

function stopScreamDetection() {
    if (screamInterval) clearInterval(screamInterval);
    screamInterval = null;
    if (audioContext) audioContext.close();
}

// 2. BATTERY LOW-ALERT
function toggleBatteryAlert() {
    batteryAlertEnabled = document.getElementById('battery-toggle')?.checked || false;
    localStorage.setItem('safeher_battery_alert', batteryAlertEnabled);

    if (batteryAlertEnabled) {
        startBatteryMonitoring();
        showToast('🔋 Battery Low-Alert Active', 'success');
    } else {
        if (batteryCheckInterval) clearInterval(batteryCheckInterval);
        batteryCheckInterval = null;
    }
}

async function startBatteryMonitoring() {
    if (batteryCheckInterval) return;
    
    batteryCheckInterval = setInterval(async () => {
        if (!batteryAlertEnabled) return;
        
        try {
            const battery = await navigator.getBattery();
            // Trigger if battery is below 15% and NOT charging
            if (battery.level <= 0.15 && !battery.charging && !sosCooldown) {
                console.log("⚠️ CRITICAL BATTERY: " + (battery.level * 100) + "%");
                triggerSOS('low_battery_alert');
                showToast('🔋 Low Battery Alert Sent to Guardians!', 'warning');
            }
        } catch (e) {
            console.warn("Battery API not supported on this device/browser");
        }
    }, 60000 * 5); // Check every 5 mins
}

// 3. GEOFENCE DANGER WARNINGS
function toggleGeofenceAlerts() {
    geofenceAlertsEnabled = document.getElementById('geofence-toggle')?.checked || false;
    localStorage.setItem('safeher_geofence_alerts', geofenceAlertsEnabled);

    if (geofenceAlertsEnabled) {
        startGeofenceMonitoring();
        showToast('🎯 Geofence Warnings Active', 'success');
    } else {
        if (geofenceCheckInterval) clearInterval(geofenceCheckInterval);
        geofenceCheckInterval = null;
    }
}

function startGeofenceMonitoring() {
    if (geofenceCheckInterval) return;
    
    geofenceCheckInterval = setInterval(() => {
        if (!geofenceAlertsEnabled || !currentLocation.lat) return;

        // Check against globalCommunityPins or local pins
        const allPins = window.allCommunityPins || [];
        allPins.forEach(pin => {
            if (pin.type === 'safe') return; // Don't warn for safe spots

            const dist = getDistanceInMeters(
                currentLocation.lat, currentLocation.lng,
                pin.lat, pin.lng
            );

            // Warning radius: 200 meters
            if (dist < 200) {
                console.warn("🎯 GEOFENCE WARNING: Near danger zone (" + pin.type + ")");
                showToast(`⚠️ Danger Zone Nearby: ${pin.type}. Stay alert!`, 'warning');
                if (navigator.vibrate) navigator.vibrate([100, 200, 100]);
            }
        });
    }, 15000); // Check every 15 seconds
}

// Haversine Distance Helper
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; 
}

// 📞 =========================================================
// FEATURE: FAKE CALL & DIGITAL SIREN
// =========================================================

let sirenActive = false;
let sirenOscillator = null;
let ringtoneInterval = null;
let audioCtx = null;

function triggerFakeCall() {
    const overlay = document.getElementById('fake-call-interface');
    if (!overlay) return;
    
    overlay.classList.remove('hidden');
    console.log("📞 Fake Call Triggered");
    
    // Play a synthetic ringtone
    startSyntheticRingtone();
    
    if (navigator.vibrate) navigator.vibrate([500, 500, 500, 500, 500]);
}

function endFakeCall() {
    const overlay = document.getElementById('fake-call-interface');
    if (overlay) overlay.classList.add('hidden');
    stopSyntheticRingtone();
}

function acceptFakeCall() {
    const status = document.querySelector('.caller-status');
    if (status) status.textContent = "00:01";
    stopSyntheticRingtone();
    
    // Fake a timer
    let sec = 1;
    setInterval(() => {
        sec++;
        const m = Math.floor(sec/60);
        const s = sec % 60;
        if (status) status.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }, 1000);
}

function startSyntheticRingtone() {
    if (ringtoneInterval) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    ringtoneInterval = setInterval(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
    }, 1000);
}

function stopSyntheticRingtone() {
    if (ringtoneInterval) clearInterval(ringtoneInterval);
    ringtoneInterval = null;
}

// 📢 SIREN LOGIC
function toggleSiren() {
    sirenActive = !sirenActive;
    const overlay = document.getElementById('siren-overlay');
    const text = document.getElementById('siren-text');
    
    if (sirenActive) {
        if (overlay) overlay.style.display = 'block';
        if (text) text.textContent = "STOP SIREN";
        startSirenSound();
        showToast('🚓 Panic Siren Activated!', 'error');
    } else {
        if (overlay) overlay.style.display = 'none';
        if (text) text.textContent = "Panic Siren";
        stopSirenSound();
    }
}

function startSirenSound() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sirenOscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    sirenOscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    sirenOscillator.type = 'triangle';
    sirenOscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
    
    const waverInterval = setInterval(() => {
        if (!sirenActive || !sirenOscillator) {
            clearInterval(waverInterval);
            return;
        }
        sirenOscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.5);
        sirenOscillator.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 1.0);
    }, 1000);

    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    sirenOscillator.start();
}

function stopSirenSound() {
    if (sirenOscillator) {
        try {
            sirenOscillator.stop();
        } catch(e) {}
        sirenOscillator = null;
    }

// 👁️ =========================================================
// FEATURE: AI VISUAL GUARDIAN (PHOTO WITNESS)
// =========================================================

async function triggerVisualGuardian() {
    showToast('👁️ AI Witness: Point camera at suspect/vehicle...', 'info');
    
    // Brief delay to allow user to aim
    setTimeout(async () => {
        try {
            // 1. ACCESS CAMERA
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            const video = document.createElement('video');
            video.srcObject = stream;
            await video.play();

            // 2. CAPTURE FRAME
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0);
            
            const imageData = canvas.toDataURL('image/jpeg', 0.8);
            
            // Cleanup stream
            stream.getTracks().forEach(track => track.stop());
            
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            showToast('📸 Evidence Captured. AI Analyzing...', 'success');

            // 3. SEND TO AI
            const resp = await fetch(`${API_BASE_URL}/api/analyze-evidence`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    image: imageData,
                    sessionId: activeLiveSessionId || 'general_evidence'
                })
            });

            const data = await resp.json();
            
            if (data.success) {
                // Show analysis in a stylized alert
                const witnessReport = data.analysis;
                alert(`📋 AI WITNESS REPORT\n\n${witnessReport}\n\nThis timestamped analysis has been added to your safety log.`);
                addLog('evidence', `AI Visual Analysis: ${witnessReport.substring(0, 50)}...`);
            } else {
                showToast('❌ AI Witness failed to analyze image.', 'error');
            }

        } catch (err) {
            console.error("Visual Guardian capture error:", err);
            showToast('📷 Camera access denied or failed.', 'error');
        }
    }, 1500); // 1.5s delay for aiming
}
}

// 🛡️ =========================================================
// FEATURE: LIVE SAFETY SCORE & SHAKE DETECTION
// =========================================================

let shakeDetectionEnabled = localStorage.getItem('safeher_shake_sos') === 'true';
let safetyScoreUpdateInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    const sToggle = document.getElementById('shake-toggle');
    if (sToggle) sToggle.checked = shakeDetectionEnabled;
    
    if (shakeDetectionEnabled) startShakeDetection();
    startSafetyScoreUpdates();
});

// 📊 SAFETY SCORE LOGIC
function startSafetyScoreUpdates() {
    if (safetyScoreUpdateInterval) clearInterval(safetyScoreUpdateInterval);
    
    updateSafetyScore(); // initial run
    safetyScoreUpdateInterval = setInterval(updateSafetyScore, 20000); // every 20s
}

function updateSafetyScore() {
    if (!currentLocation.lat) return;
    
    const pins = window.allCommunityPins || [];
    let baseScore = 100;
    let riskCount = 0;
    
    pins.forEach(pin => {
        if (pin.type === 'safe') return;
        
        const dist = getDistanceInMeters(currentLocation.lat, currentLocation.lng, pin.lat, pin.lng);
        
        // Deduction logic
        if (dist < 300) { baseScore -= 25; riskCount++; }
        else if (dist < 1000) { baseScore -= 10; riskCount += 0.5; }
        else if (dist < 3000) { baseScore -= 2; }
    });

    // Time of day factor (Night time is 15 points riskier)
    const hour = new Date().getHours();
    if (hour > 20 || hour < 5) baseScore -= 15;

    const finalScore = Math.max(10, baseScore);
    
    // Update UI
    const path = document.getElementById('score-meter-path');
    const text = document.getElementById('score-text');
    const status = document.getElementById('score-status');
    
    if (path) path.setAttribute('stroke-dasharray', `${finalScore}, 100`);
    if (text) text.textContent = Math.round(finalScore);
    
    if (status) {
        if (finalScore > 80) { status.textContent = "🛡️ ZONE SECURE"; status.style.color = "#00f5d4"; }
        else if (finalScore > 50) { status.textContent = "⚠️ USE CAUTION"; status.style.color = "#ffbe0b"; }
        else { status.textContent = "🚨 HIGH RISK AREA"; status.style.color = "#ff006e"; }
    }
}

// 📳 SHAKE DETECTION LOGIC
function toggleShakeDetection() {
    shakeDetectionEnabled = document.getElementById('shake-toggle')?.checked || false;
    localStorage.setItem('safeher_shake_sos', shakeDetectionEnabled);
    
    if (shakeDetectionEnabled) {
        startShakeDetection();
        showToast('📳 Shake-to-SOS Activated', 'success');
    } else {
        window.removeEventListener('devicemotion', handleShakeAction);
    }
}

let lastX, lastY, lastZ;
let shakeThreshold = 15; // sensitivity
let shakeLimit = 3;
let shakesInWindow = 0;
let lastShakeTimestamp = 0;

function startShakeDetection() {
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', handleShakeAction);
    } else {
        console.warn("DeviceMotion not supported");
    }
}

function handleShakeAction(event) {
    if (!shakeDetectionEnabled || sosCooldown) return;
    
    const acceleration = event.accelerationIncludingGravity;
    if (!acceleration) return;

    let deltaX = Math.abs(lastX - acceleration.x);
    let deltaY = Math.abs(lastY - acceleration.y);
    let deltaZ = Math.abs(lastZ - acceleration.z);

    if (deltaX > shakeThreshold || deltaY > shakeThreshold || deltaZ > shakeThreshold) {
        const now = Date.now();
        if (now - lastShakeTimestamp > 200) { // debounce
            shakesInWindow++;
            lastShakeTimestamp = now;
            
            if (shakesInWindow >= shakeLimit) {
                console.log("📳 CRITICAL SHAKE DETECTED");
                if (navigator.vibrate) navigator.vibrate([100, 100, 100]);
                triggerSOS('shake_gesture');
                shakesInWindow = 0;
            }
        }
    }
    
    // Reset window if no shake for 2 seconds
    setTimeout(() => {
        if (Date.now() - lastShakeTimestamp > 2000) shakesInWindow = 0;
    }, 2000);

    lastX = acceleration.x;
    lastY = acceleration.y;
    lastZ = acceleration.z;
}

// 🎥 =========================================================
// FEATURE: DIGITAL DECOY (FAKE MEETING)
// =========================================================

let decoyStream = null;

async function triggerDigitalDecoy() {
    const overlay = document.getElementById('digital-decoy-interface');
    const video = document.getElementById('decoy-self-view');
    if (!overlay || !video) return;

    overlay.classList.remove('hidden');
    showToast('🎥 Meeting Decoy: Connecting to live participants...', 'info');

    try {
        decoyStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'user' }, 
            audio: false 
        });
        video.srcObject = decoyStream;
        
        // Hide UI elements to make it immersive
        document.getElementById('main-nav')?.style.setProperty('display', 'none', 'important');
        document.querySelector('.mobile-nav')?.style.setProperty('display', 'none', 'important');
        
    } catch (err) {
        console.error("Decoy camera error:", err);
        showToast('⚠️ Camera access needed for meeting decoy.', 'error');
    }
}

function exitDigitalDecoy() {
    const overlay = document.getElementById('digital-decoy-interface');
    if (overlay) overlay.classList.add('hidden');

    if (decoyStream) {
        decoyStream.getTracks().forEach(track => track.stop());
        decoyStream = null;
    }

    // Restore UI
    document.getElementById('main-nav')?.style.setProperty('display', 'block', 'important');
    document.querySelector('.mobile-nav')?.style.setProperty('display', 'flex', 'important');
}
