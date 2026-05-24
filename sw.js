const SHELL_CACHE  = 'vooar-shell-v4';
const MEDIA_CACHE  = 'vooar-media-v1';

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

// ── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove caches antigos ─────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== MEDIA_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // ── Arquivos de mídia (/uploads/) → cache-first com fallback de rede ──────
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(res => {
            if (res.ok && res.status === 200) {
              // Só cacheia arquivos de mídia (imagem/vídeo/.mind)
              const ct = res.headers.get('content-type') || '';
              if (/image|video|octet/.test(ct)) {
                cache.put(request, res.clone());
              }
            }
            return res;
          });
        })
      )
    );
    return;
  }

  // ── API: sempre rede, sem cache ───────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) return;

  // ── App shell (same-origin HTML/JS/CSS): stale-while-revalidate ──────────
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fresh = fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }

  // ── CDN externo (MindAR, A-Frame, fontes): network-first ─────────────────
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          caches.open(SHELL_CACHE).then(c => c.put(request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
