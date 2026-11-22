/* 껍데기와 바뀌지 않는 라이브러리·글꼴을 저장해 두어 빨리 열리게 한다. 데이터(GitHub·Supabase)는 건드리지 않는다. */
const CACHE = 'knu1-shell-v6';
const LIBS = 'knu1-libs-v1';
const SHELL = ['./', 'index.html', 'shell.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
// 주소에 버전이 들어 있어 내용이 안 바뀌는 것 + 글꼴 → 저장해 둔 것을 바로 씀
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== LIBS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (LIB_HOSTS.includes(u.hostname)) {
    // 글꼴 목록(css)은 뒤에서 새로 받아 두고, 나머지(버전 고정 파일·글꼴 파일)는 저장한 것 그대로
    e.respondWith(caches.open(LIBS).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; });
      if (hit) { if (u.hostname === 'fonts.googleapis.com') net.catch(() => {}); return hit; }
      return net;
    }));
    return;
  }
  if (u.origin !== location.origin) return;
  // 껍데기: 늘 새 것을 먼저, 안 되면 저장해 둔 것
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
