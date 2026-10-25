'use strict';
/* Service worker : l'application et ses bibliothèques restent disponibles hors ligne. */
const VERSION = 'clairscan-v3';
const LIB_CACHE = 'clairscan-lib';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'scanner.js', 'db.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
// Noms versionnés : un fichier en cache n'a jamais besoin d'être retéléchargé.
const LIBS = ['lib/opencv-4.12.0.js', 'lib/jspdf-4.2.1.umd.min.js'];
const libUrls = LIBS.map(p => new URL(p, self.registration.scope).href);

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    await (await caches.open(VERSION)).addAll(SHELL);
    const libs = await caches.open(LIB_CACHE);
    for (const url of libUrls) if (!(await libs.match(url))) await libs.add(url);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== LIB_CACHE) await caches.delete(k);
    // Supprime les anciennes versions des bibliothèques.
    const libs = await caches.open(LIB_CACHE);
    for (const req of await libs.keys()) if (!libUrls.includes(req.url)) await libs.delete(req);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Bibliothèques : le cache d'abord.
  if (libUrls.includes(url.href)) {
    ev.respondWith(caches.open(LIB_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Fichiers de l'application : le réseau d'abord pour recevoir les mises à jour, le cache hors ligne.
  ev.respondWith(fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
