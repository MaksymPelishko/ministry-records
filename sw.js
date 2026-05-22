/* =============================================================
 * Service worker — keeps the app shell available offline.
 *
 *   • Same-origin GETs (index.html, ./):
 *       network-first, with cache fallback when offline.
 *       The cache is refreshed on every successful network response.
 *
 *   • External static assets we depend on (GSI client, Google Fonts):
 *       stale-while-revalidate, so they keep working without network.
 *
 *   • API calls (workers.dev, api.notion.com) are NOT intercepted —
 *       the app layer manages its own data cache and mutation queue.
 * ============================================================= */

// Bump the suffix to force-invalidate the previous cache when shipping HTML/JS/CSS changes.
const CACHE_NAME = 'ministry-shell-v2';
const SHELL_URLS = ['./', './index.html'];

const STATIC_HOSTS = [
    'accounts.google.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // Use Request objects so we can opt-in to opaque (no-cors) responses for cross-origin
            cache.addAll(SHELL_URLS).catch(() => null)
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    let url;
    try { url = new URL(request.url); } catch { return; }

    // Same-origin shell — network-first with cache fallback.
    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
        return;
    }

    // External static assets (GSI, fonts) — stale-while-revalidate.
    if (STATIC_HOSTS.includes(url.hostname)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // Cross-origin images (territory cards, Google avatars, etc.) — cache-first
    // so they survive offline reloads even though Notion's signed URLs would
    // otherwise be unreachable.
    if (request.destination === 'image') {
        event.respondWith(imageCacheFirst(request));
        return;
    }

    // Everything else (API, etc.) — let the network handle it directly.
});

async function networkFirst(request) {
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
            const clone = fresh.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone)).catch(() => {});
        }
        return fresh;
    } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Last resort: serve the cached root document
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
        throw e;
    }
}

async function staleWhileRevalidate(request) {
    const cache  = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const network = fetch(request).then((res) => {
        if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
        return res;
    }).catch(() => null);
    return cached || network || fetch(request);
}

// Cross-origin <img> requests (Notion S3 URLs, Google avatars, etc.) typically
// have no CORS headers, so fetch() returns an *opaque* response: status 0,
// ok false, type 'opaque'. We still need to cache those — the browser will
// happily render them from cache, it just can't read the pixels.
function isCacheable(res) {
    if (!res) return false;
    if (res.type === 'opaque') return true;          // cross-origin no-CORS
    return res.ok && res.status < 400;
}

async function imageCacheFirst(request) {
    const cache  = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
        // Refresh in the background if we're online, so the next reload has the latest bytes.
        fetch(request).then((res) => {
            if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
        }).catch(() => {});
        return cached;
    }
    try {
        const fresh = await fetch(request);
        if (isCacheable(fresh)) cache.put(request, fresh.clone()).catch(() => {});
        return fresh;
    } catch {
        // Offline and not in cache — return a transparent placeholder rather than throwing
        return new Response('', { status: 504, statusText: 'Image offline' });
    }
}
