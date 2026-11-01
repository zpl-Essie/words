// 拍拍学 · Service Worker
// 缓存策略：Stale-While-Revalidate（先返回缓存，后台更新）

const CACHE = 'words-v20261101DEMO';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/demo-data.js',
  'demo/desk.jpg',
  'demo/kitchen.jpg',
  'data/dict.json',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 不缓存 API 请求：豆包域名 + SCF 代理（含 ?tts= 发音音频，避免缓存错版本/跨域 opaque）
  if (url.host.includes('volces.com') || url.host.includes('tencentscf.com') || url.pathname.startsWith('/api/')) return;
  // 只处理 GET；POST 等直接放行，不参与缓存
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          // 只缓存成功的 GET
          if (res.ok && e.request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
