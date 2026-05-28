const SHELL_CACHE = 'vooar-shell-v6';
const MEDIA_CACHE = 'vooar-media-v2';
const CDN_CACHE   = 'vooar-cdn-v1';

const KEEP_CACHES = [SHELL_CACHE, MEDIA_CACHE, CDN_CACHE];

// URLs do app shell (mesmo domínio)
const SHELL = [
  './',
  './index.html',
  './dashboard.html',
  './editor.html',
  './viewer.html',
  './profile.html',
  './admin.html',
  './drive.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Bibliotecas CDN — versões fixas, imutáveis — pre-cacheamos no install
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js',
  'https://aframe.io/releases/1.5.0/aframe.min.js',
  'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js',
];

// ── Install: pre-cache app shell + CDN ──────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      // App shell — obrigatório
      caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)),
      // CDN — opcional (não falha o install se CDN estiver fora)
      caches.open(CDN_CACHE).then(cache =>
        Promise.allSettled(CDN_URLS.map(url =>
          cache.match(url).then(hit => {
            if (hit) return; // já cacheado
            return fetch(url, { cache: 'no-cache' })
              .then(res => { if (res.ok) cache.put(url, res); })
              .catch(() => {});
          })
        ))
      ),
    ]).then(() => self.skipWaiting())
  );
});

// ── Activate: remove caches antigos ─────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !KEEP_CACHES.includes(k))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // ── /uploads/ → cache-first (após primeiro download nunca mais pede rede)
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(res => {
            if (res.ok) {
              const ct = res.headers.get('content-type') || '';
              if (/image|video|octet/.test(ct)) cache.put(request, res.clone());
            }
            return res;
          });
        })
      )
    );
    return;
  }

  // ── /api/ → sempre rede, sem cache ───────────────────────────────────────
  if (url.pathname.startsWith('/api/')) return;

  // ── CDN externo (MindAR, A-Frame) → cache-first ──────────────────────────
  // URLs versionadas não mudam; servimos do cache imediatamente.
  // Se ainda não estiver no cache, busca na rede e guarda.
  const isCDN = CDN_URLS.includes(request.url);
  if (isCDN || url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => caches.match(request)); // fallback geral
        })
      )
    );
    return;
  }

  // ── App shell (mesmo domínio) → stale-while-revalidate ───────────────────
  event.respondWith(
    caches.open(SHELL_CACHE).then(cache =>
      cache.match(request).then(cached => {
        const fresh = fetch(request)
          .then(res => { if (res.ok) cache.put(request, res.clone()); return res; })
          .catch(() => cached);
        return cached || fresh;
      })
    )
  );
});
