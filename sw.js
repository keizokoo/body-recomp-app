// 바디 리컴포지션 PWA Service Worker
const CACHE_NAME = 'bodyrecomp-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 캐싱하면 안 되는(항상 네트워크로 직행해야 하는) 요청 판별
function shouldBypassCache(url) {
  return (
    url.includes('script.google.com') ||   // Apps Script 동기화 호출
    url.includes('googleapis.com') ||      // Google Drive/기타 API
    url.includes('drive.google.com')
  );
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // 동기화 POST 등은 그대로 네트워크로
  if (shouldBypassCache(request.url)) return; // 구글 동기화는 캐싱 제외, 항상 최신 요청

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // 오프라인이면 캐시로 폴백

      // 캐시가 있으면 즉시 캐시 응답 + 백그라운드로 최신화, 없으면 네트워크 응답 대기
      return cached || network;
    })
  );
});
