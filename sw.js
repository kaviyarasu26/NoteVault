// App-shell cache only — never intercepts Firebase Auth/Firestore or the
// CDN'd crypto-js/firebase SDKs, since those must always be live/current.
// This buys instant repeat loads and a non-blank screen on a flaky
// connection; it does NOT provide offline access to notes/flashcards
// themselves, since the app requires a verified sign-in and Firestore is
// the only data source (see js/firebase-init.js).
const CACHE_NAME = 'notevault-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/folder-context.css',
  './css/daily-tracker.css',
  './css/notifications.css',
  './css/growth.css',
  './js/app-core.js',
  './js/folder-context.js',
  './js/folder-share.js',
  './js/daily-tracker.js',
  './js/notifications.js',
  './js/achievements.js',
  './js/growth.js',
  './js/app-lock.js',
  './js/backup.js',
  './js/firebase-init.js',
  './icons/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Review Now / Snooze 1h buttons on a web notification (see
// pushReminderNotification, js/notifications.js) — this service worker is a
// separate execution context from the page, so it can't call reviewTab()
// or similar directly; it just relays which action was pressed to whichever
// page client is open, which handles it via its own 'message' listener.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action; // '' for a click on the notification body itself
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const client = clients.find(c => 'focus' in c);
      if (client) {
        client.focus();
        client.postMessage({ type: 'notification-action', action });
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request)
        .then(resp => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
