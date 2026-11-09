/* Service worker del reproductor (alcance /player/).
 * Guarda la "carcasa" del reproductor para que, si el televisor se reinicia sin Internet, la página abra
 * y pueda usar el respaldo local ya descargado. NUNCA guarda la señal en vivo ni datos del panel. */
var SHELL = 'rmdm-shell-v2';
var BACKUP_CACHE = 'rmdm-respaldo-v1';
var ASSETS = ['/static/player/player.js', '/static/player/player.css', '/static/vendor/hls.min.js', '/static/assets/logo.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('rmdm-shell-') === 0 && k !== SHELL; }).map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Música y comerciales ya descargados (modo local / respaldo): se entregan desde la copia del TV, con soporte de
  // "Range" (los reproductores de video piden el archivo por partes). Así el <video> usa una dirección normal:
  // algunos navegadores de televisor no reproducen video desde direcciones blob:.
  if (url.pathname.indexOf('/media/local/') === 0 || url.pathname.indexOf('/media/backup/') === 0) {
    e.respondWith(caches.open(BACKUP_CACHE).then(function (c) { return c.match(url.origin + url.pathname); }).then(function (hit) {
      if (!hit) return fetch(e.request);
      var range = e.request.headers.get('range');
      if (!range) return hit;
      return hit.blob().then(function (b) {
        var m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        var size = b.size;
        var start = m[1] ? parseInt(m[1], 10) : 0;
        var end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
        if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
        return new Response(b.slice(start, end + 1, hit.headers.get('Content-Type') || ''), {
          status: 206,
          headers: { 'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
        });
      });
    }));
    return;
  }
  // Señal en vivo y API: siempre a la red.
  if (url.pathname.indexOf('/live/') === 0 || url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/media/') === 0) return;
  var isPlayerPage = /^\/player\/[a-z0-9-]+$/.test(url.pathname);
  if (isPlayerPage || ASSETS.indexOf(url.pathname) >= 0) {
    // Red primero (para recibir actualizaciones). Si no hay Internet, o el servidor responde con error (por ejemplo
    // mientras el PC del almacén se reinicia o se actualiza), se usa la copia guardada: así el TV nunca queda en
    // «Página web no disponible» y sigue sonando con lo que tiene descargado.
    e.respondWith(fetch(e.request).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(e.request, copy); }); return res; }
      return caches.match(e.request).then(function (hit) { return hit || res; });
    })['catch'](function () { return caches.match(e.request); }));
  }
});
