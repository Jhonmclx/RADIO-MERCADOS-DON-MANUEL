/* Diagnóstico de compatibilidad para televisores (ES5). */
(function () {
  'use strict';
  var R = {}; var rows = [];
  function $(id) { return document.getElementById(id); }
  function add(key, name, status, detail) {
    R[key] = { status: status, detail: detail };
    rows.push([name, status, detail]);
    var tr = document.createElement('tr');
    var label = { ok: 'Sí', no: 'No', warn: 'Parcial' }[status] || status;
    tr.innerHTML = '<td>' + name + '</td><td class="' + status + '">' + label + '</td><td>' + String(detail == null ? '' : detail).replace(/</g, '&lt;') + '</td>';
    $('results').getElementsByTagName('tbody')[0].appendChild(tr);
  }
  function xhr(method, url, body, cb) {
    var x = new XMLHttpRequest(); x.open(method, url, true); x.timeout = 8000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () { if (x.readyState === 4) { var d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* ignore */ } cb(x.status >= 200 && x.status < 300 ? null : new Error('HTTP ' + x.status), d); } };
    x.ontimeout = function () { cb(new Error('tiempo agotado')); };
    x.send(body ? JSON.stringify(body) : null);
  }
  function silentWavUrl() {
    var sr = 8000, n = 1600, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), i;
    function s(o, t) { for (var k = 0; k < t.length; k++) v.setUint8(o + k, t.charCodeAt(k)); }
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
    for (i = 0; i < n; i++) v.setInt16(44 + i * 2, 0, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  var qs = /[?&]sede=([a-z0-9-]+)/.exec(location.search);
  if (qs) $('site').value = qs[1];

  function run() {
    $('run').disabled = true;
    $('results').getElementsByTagName('tbody')[0].innerHTML = ''; rows = []; R = {};
    var v = $('v');
    add('ua', 'Navegador (User-Agent)', 'ok', navigator.userAgent);
    add('screen', 'Pantalla', 'ok', screen.width + '×' + screen.height + ' · ventana ' + window.innerWidth + '×' + window.innerHeight + ' · escala ' + (window.devicePixelRatio || 1));
    var mse = !!(window.MediaSource && window.MediaSource.isTypeSupported && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f,mp4a.40.2"'));
    add('mse', 'Media Source Extensions (H.264 + AAC)', mse ? 'ok' : 'no', mse ? 'Permite usar hls.js' : 'No disponible');
    var hlsjs = !!(window.Hls && window.Hls.isSupported());
    var nativeHls = v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL') || '';
    add('hlsjs', 'Reproductor hls.js', hlsjs ? 'ok' : 'no', hlsjs ? 'versión ' + window.Hls.version : 'no compatible');
    add('nativeHls', 'HLS nativo del televisor', nativeHls ? 'ok' : 'no', nativeHls || 'no');
    R.hlsSupport = hlsjs ? 'hls.js' : nativeHls ? 'nativo' : 'ninguno';
    var mp4 = v.canPlayType('video/mp4; codecs="avc1.4d401f, mp4a.40.2"');
    add('mp4', 'Video MP4 H.264/AAC (respaldo)', mp4 ? 'ok' : 'no', mp4 || 'no');
    add('fullscreen', 'Pantalla completa', (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) ? 'ok' : 'warn', 'API de pantalla completa');
    var ls = false; try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); ls = true; } catch (e) { /* ignore */ }
    add('localStorage', 'Almacenamiento local (localStorage)', ls ? 'ok' : 'no', ls ? '' : 'Los eventos sin conexión no sobreviven a una recarga');
    var sw = 'serviceWorker' in navigator; var cs = !!window.caches; var sec = window.isSecureContext !== false;
    R.serviceWorker = sw; R.cacheStorage = cs; R.secureContext = sec;
    add('sw', 'Service worker', sw ? 'ok' : 'no', sw ? '' : 'Sin respaldo offline');
    add('cache', 'Cache Storage', cs ? 'ok' : 'no', '');
    add('secure', 'Conexión segura (HTTPS)', sec ? 'ok' : 'no', sec ? location.protocol : 'El respaldo local exige HTTPS');
    try { v.playbackRate = 1.02; add('rate', 'Ajuste fino de velocidad (sincronización)', v.playbackRate === 1.02 ? 'ok' : 'warn', 'playbackRate'); v.playbackRate = 1; }
    catch (e) { add('rate', 'Ajuste fino de velocidad (sincronización)', 'no', 'Solo se corrige con saltos'); }
    add('startDate', 'Hora de emisión en HLS nativo (getStartDate)', v.getStartDate ? 'ok' : 'warn', v.getStartDate ? '' : 'Con HLS nativo no se podrá medir el retraso');
    var pending = 4;
    function done() {
      pending--;
      if (pending > 0) return;
      var live = R.liveStream && R.liveStream.status === 'ok';
      var backup = sw && cs && sec && R.storage && R.storage.status !== 'no';
      var sum = $('summary'); sum.innerHTML = '';
      function line(cls, txt) { var d = document.createElement('div'); d.className = cls; d.innerHTML = txt; sum.appendChild(d); }
      line(live ? 's-ok' : 's-no', live ? 'Señal en vivo: COMPATIBLE' : 'Señal en vivo: NO se pudo reproducir en este navegador');
      line(R.autoplaySound && R.autoplaySound.status === 'ok' ? 's-ok' : 's-warn', R.autoplaySound && R.autoplaySound.status === 'ok' ? 'Sonido automático: permitido' : 'Sonido automático: requiere pulsar OK una vez al encender');
      line(backup ? 's-ok' : 's-warn', backup ? 'Respaldo local sin Internet: posible' : 'Respaldo local sin Internet: NO disponible (mostrará pantalla de reconexión)');
      $('send').disabled = false; $('run').disabled = false;
    }
    // Sonido automático
    var a = new Audio(); a.src = silentWavUrl();
    var p = a.play();
    if (p && p.then) p.then(function () { add('autoplaySound', 'Reproducción automática con sonido', 'ok', 'permitida'); done(); }, function (e) { add('autoplaySound', 'Reproducción automática con sonido', 'warn', 'bloqueada: ' + (e && e.name)); done(); });
    else { add('autoplaySound', 'Reproducción automática con sonido', 'warn', 'no se pudo determinar'); done(); }
    // Espacio
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (q) {
        var free = q.quota - q.usage;
        add('storage', 'Espacio para respaldo', free > 300 * 1048576 ? 'ok' : free > 50 * 1048576 ? 'warn' : 'no', Math.round(free / 1048576) + ' MB disponibles de ' + Math.round(q.quota / 1048576) + ' MB');
        done();
      }, function () { add('storage', 'Espacio para respaldo', 'warn', 'no se pudo consultar'); done(); });
    } else { add('storage', 'Espacio para respaldo', 'warn', 'API no disponible'); done(); }
    // Reloj
    var t0 = new Date().getTime();
    xhr('GET', '/api/public/time?_=' + t0, null, function (err, d) {
      var t1 = new Date().getTime();
      if (err || !d) add('clock', 'Reloj del televisor vs servidor', 'no', 'sin respuesta del servidor');
      else { var off = Math.round(d.now - (t0 + (t1 - t0) / 2)); add('clock', 'Reloj del televisor vs servidor', Math.abs(off) < 2000 ? 'ok' : 'warn', 'diferencia ' + off + ' ms (latencia ' + (t1 - t0) + ' ms). El reproductor la compensa.'); R.clockOffsetMs = off; }
      done();
    });
    // Señal en vivo
    var started = new Date().getTime(); var finished = false; var hls = null;
    function liveDone(ok, detail) {
      if (finished) return; finished = true;
      add('liveStream', 'Reproducción de la señal en vivo', ok ? 'ok' : 'no', detail);
      try { v.pause(); if (hls) hls.destroy(); } catch (e) { /* ignore */ }
      done();
    }
    v.muted = true;
    v.addEventListener('playing', function () {
      setTimeout(function () {
        var ok = v.currentTime > 1;
        liveDone(ok, ok ? 'primer cuadro en ' + (new Date().getTime() - started) + ' ms; reproducidos ' + v.currentTime.toFixed(1) + ' s' : 'se detuvo al iniciar');
      }, 6000);
    });
    if (hlsjs) { hls = new window.Hls({ liveSyncDurationCount: 4 }); hls.on(window.Hls.Events.ERROR, function (e, d) { if (d.fatal) liveDone(false, d.details); }); hls.loadSource('/live/index.m3u8'); hls.attachMedia(v); v.play(); }
    else if (nativeHls) { v.src = '/live/index.m3u8'; v.play(); }
    else liveDone(false, 'sin reproductor compatible');
    setTimeout(function () { liveDone(false, 'no inició en 25 s'); }, 25000);
  }

  $('run').onclick = run;
  $('send').onclick = function () {
    xhr('POST', '/api/public/diagnostics', { site: $('site').value || null, report: R }, function (err) {
      alert(err ? 'No se pudo enviar el diagnóstico.' : 'Diagnóstico enviado. Lo verá en el panel, sección Sedes y Registros.');
    });
  };
})();
