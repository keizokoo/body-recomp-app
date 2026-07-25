// 바디 리컴포지션 PWA Service Worker
// 2026-07-25 수정: 기존 cache-first(있으면 캐시 즉시 반환 + 백그라운드로만 갱신) 전략이
// 배포할 때마다 "한 버전씩 계속 뒤처져서 보이는" 문제의 근본 원인이었음. 개발 중인 앱이라
// 최신 코드 반영이 성능보다 훨씬 중요하므로 network-first(항상 네트워크 우선, 실패시에만
// 캐시 폴백)로 전략 변경. CACHE_NAME도 v1→v2로 올려서 이번 배포 시 낡은 캐시를 강제 정리.
const CACHE_NAME = 'bodyrecomp-cache-v2';
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
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // 동기화 POST 등은 그대로 네트워크로
  if (shouldBypassCache(request.url)) return; // 구글 동기화는 캐싱 제외, 항상 최신 요청

  // network-first: 항상 네트워크를 먼저 시도해서 최신 버전을 받고, 캐시는 오프라인일 때만 사용.
  // (기존 cache-first 전략은 배포 직후에도 예전 화면을 계속 보여주는 문제가 있었음)
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
