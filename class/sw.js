/* 학생/학부모 앱 서비스 워커
 * - 홈 화면 '앱 설치' 조건을 맞추기 위한 최소한의 것 (파일을 저장해 두지 않음 → 업데이트가 바로 반영됨)
 * - 인터넷이 끊겼을 때만 안내 화면을 보여줌 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // 화면 이동만 처리, 나머지는 브라우저 기본 동작
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>안강엽 수학</title><body style="font-family:sans-serif;text-align:center;padding:30vh 20px;color:#555">'
    + '<div style="font-size:40px">📶</div><p>인터넷에 연결되어 있지 않아요.<br>연결한 뒤 다시 열어 주세요.</p>'
    + '<button onclick="location.reload()" style="padding:10px 18px;border-radius:10px;border:1px solid #ccc;background:#fff">다시 시도</button></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});
