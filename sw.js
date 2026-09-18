/* Service Worker for 离职必薅福利 PWA
 * Scope: /benefits/ms/
 * - Web Push: 展示发薪日/假期提醒
 * - 离线兜底：缓存壳页面
 */
const CACHE = 'benefits-ms-open-v2';
const BASE = new URL('./', self.location.href).pathname;
const SHELL = [BASE, BASE + 'index.html', BASE + 'manifest.webmanifest', BASE + 'icon.svg'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('benefits-ms-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面请求立即更新时，跳过等待直接接管
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function putCache(request, response) {
  if (!response || (!response.ok && response.type !== 'opaque')) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
}

function networkUpdate(request, cacheKey) {
  return fetch(request).then((response) => putCache(cacheKey || request, response).then(() => response)).catch(() => null);
}

// PWA 冷启动：App Shell 缓存优先，后台更新。避免杀掉后重开先等网络导致白屏/慢渲染。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 运行时缓存外部静态资源（Tailwind CDN / QRCode / Fonts），首访后重开更快。
  const externalHosts = new Set(['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);
  if (url.origin !== self.location.origin) {
    if (!externalHosts.has(url.hostname)) return;
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) {
        event.waitUntil(networkUpdate(req));
        return cached;
      }
      return await networkUpdate(req) || fetch(req);
    })());
    return;
  }

  if (!url.pathname.startsWith(BASE)) return;
  if (url.pathname.endsWith('/sw.js')) return;

  const isShell = req.mode === 'navigate' || url.pathname === BASE || url.pathname === BASE + 'index.html';
  if (isShell) {
    event.respondWith((async () => {
      const cached = await caches.match(BASE) || await caches.match(BASE + 'index.html');
      const update = networkUpdate(req, BASE);
      if (cached) {
        event.waitUntil(update);
        return cached;
      }
      return await update || await caches.match(BASE + 'index.html');
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(networkUpdate(req));
      return cached;
    }
    return await networkUpdate(req) || fetch(req);
  })());
});

// 接收推送
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text ? event.data.text() : '' }; }
  const title = data.title || '💰 发薪日提醒';
  const options = {
    body: data.body || '别忘了查看本月工资发放日',
    icon: BASE + 'icon.svg',
    badge: BASE + 'icon.svg',
    tag: data.tag || 'payday',
    renotify: true,
    data: { url: data.url || BASE + '?tab=payday' },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 点击通知 → 打开/聚焦页面
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(BASE) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
