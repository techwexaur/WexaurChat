/* WexaurChat service worker: offline-safe app shell + FCM push notifications */
try {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js'
  );
} catch (e) { /* offline: push handler is skipped, app shell still works */ }

if (self.firebase) {
  firebase.initializeApp({
    apiKey: 'AIzaSyBvN9e0xIjFqiN4qRFQ-5kPv1sOWQg6EpM',
    authDomain: 'wexaurchat.firebaseapp.com',
    databaseURL: 'https://wexaurchat-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'wexaurchat',
    storageBucket: 'wexaurchat.firebasestorage.app',
    messagingSenderId: '540870466881',
    appId: '1:540870466881:web:99d6c46c0aa93dfb6a95c0'
  });
  const messaging = firebase.messaging();
  // Data-only messages: we build the notification ourselves.
  messaging.onBackgroundMessage(async payload => {
    const d = payload.data || {};
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.visibilityState === 'visible')) return; // app is open: it shows its own banner
    return self.registration.showNotification(d.title || 'WexaurChat', {
      body: d.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || d.cid || 'wx',
      renotify: true,
      data: { cid: d.cid || '' }
    });
  });
}

const CACHE = 'wx-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates always arrive), cache only as offline fallback. Same-origin GET only.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const cid = (e.notification.data && e.notification.data.cid) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.length) { list[0].postMessage({ openChat: cid }); return list[0].focus(); }
    return self.clients.openWindow('./' + (cid ? '?chat=' + encodeURIComponent(cid) : ''));
  }));
});
