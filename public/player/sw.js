/* Service worker del reproductor (alcance /player/).
 * Guarda la "carcasa" del reproductor para que, si el televisor se reinicia sin Internet, la página abra
 * y pueda usar el respaldo local ya descargado. NUNCA guarda la señal en vivo ni datos del panel. */
var SHELL = 'rmdm-shell-v1';
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
  // Señal en vivo, API y respaldo: siempre a la red (el respaldo lo maneja la página directamente).
  if (url.pathname.indexOf('/live/') === 0 || url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/media/') === 0) return;
  var isPlayerPage = /^\/player\/[a-z0-9-]+$/.test(url.pathname);
  if (isPlayerPage || ASSETS.indexOf(url.pathname) >= 0) {
    // Red primero (para recibir actualizaciones); si no hay Internet, la copia guardada.
    e.respondWith(fetch(e.request).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(e.request, copy); }); }
      return res;
    })['catch'](function () { return caches.match(e.request); }));
  }
});
