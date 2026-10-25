'use strict';
/* Service worker : l'application et ses bibliothèques restent disponibles hors ligne. */
const VERSION = 'clairscan-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'scanner.js', 'db.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
const LIBS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Bibliothèques (versions figées) : le cache d'abord.
  if (LIBS.includes(url.hostname)) {
    ev.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }

  // Fichiers de l'application : le réseau d'abord pour recevoir les mises à jour, le cache hors ligne.
  if (url.origin === self.location.origin) {
    ev.respondWith(fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
