importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyD4wskB-DCtWhdOlft6sZ5mCreyeORu9k8",
    authDomain: "safeher-1fb18.firebaseapp.com",
    projectId: "safeher-1fb18",
    storageBucket: "safeher-1fb18.firebasestorage.app",
    messagingSenderId: "717418341821",
    appId: "1:717418341821:web:6413b5f28ec7140bbe9ed4"
});

const messaging = firebase.messaging();

// Handle Background Messages
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/logo.png', // Add a icon to your public folder if you have one
    data: { url: payload.data.url }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
