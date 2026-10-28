/* RADIO MERCADO DON MANUEL — reproductor de sede para televisores.
 * Escrito en JavaScript ES5 a propósito: muchos navegadores de Smart TV son antiguos.
 * Responsabilidades:
 *  - Reproducir la ÚNICA señal central (HLS) y unirse siempre al punto actual de la emisión.
 *  - Mantener un retraso común respecto a la hora oficial de emisión (EXT-X-PROGRAM-DATE-TIME)
 *    para que las cinco sedes suenen alineadas, y MEDIR el desfase real.
 *  - Reconectar solo, informar su estado y confirmar al servidor qué segmentos reprodujo.
 *  - Respaldo local SOLO si el navegador lo admite (service worker + Cache Storage + HTTPS).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utilidades
  function $(id) { return document.getElementById(id); }
  function now() { return new Date().getTime(); }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var s = '', i, r;
    for (i = 0; i < 32; i++) { r = Math.floor(Math.random() * 16); s += r.toString(16); if (i === 7 || i === 11 || i === 15 || i === 19) s += '-'; }
    return s;
  }
  function lsGet(k, d) { try { var v = window.localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* almacenamiento no disponible */ } }
  function http(method, url, body, cb, timeoutMs) {
    var x = new XMLHttpRequest(); var done = false;
    x.open(method, url, true);
    x.timeout = timeoutMs || 8000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      done = true;
      var data = null; try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
      if (x.status >= 200 && x.status < 300) cb(null, data); else cb(new Error('HTTP ' + x.status), data);
    };
    x.ontimeout = function () { if (!done) { done = true; cb(new Error('tiempo de espera agotado')); } };
    x.onerror = function () { if (!done) { done = true; cb(new Error('sin conexión')); } };
    try { x.send(body ? JSON.stringify(body) : null); } catch (e) { if (!done) { done = true; cb(e); } }
  }

  var m = /\/player\/([a-z0-9-]+)/.exec(location.pathname);
  var SLUG = m ? m[1] : 'sin-sede';
  var API = '/api/public/sites/' + SLUG;
  // Modo local (?local=1): descarga la programación una vez y la reproduce en el propio televisor (casi sin Internet).
  var LOCAL = /[?&]local=1/.test(location.search);
  var video = $('live');
  var P = {
    sessionId: uuid(), state: 'cargando', mode: null, hls: null, cfg: null, configVersion: null,
    clockOffset: 0, clockRtt: null, targetDelay: 18000, seg: 4, delay: null, syncErr: null,
    lastSeq: null, seqs: [], events: lsGet('rmdm-events-' + SLUG, []), backupPlays: lsGet('rmdm-bplays-' + SLUG, []),
    lastError: null, soundOn: false, disconnectedAt: null, lastProgressAt: now(), lastTime: -1, retry: 0,
    engineMode: 'running', backup: { status: 'sin evaluar', ready: false, active: false, manifest: lsGet('rmdm-backup-manifest', null) },
    reloadFailures: 0, waitingForEngine: false, hlsErrors: [], syncLog: []
  };

  function setState(s) { P.state = s; updateBadge(); }
  function logEvent(type, detail) {
    P.events.push({ id: uuid(), type: type, at: serverNow(), detail: detail || null });
    if (P.events.length > 200) P.events.splice(0, P.events.length - 200);
    lsSet('rmdm-events-' + SLUG, P.events);
  }
  function serverNow() { return now() + P.clockOffset; }

  // ---------------------------------------------------------------- pantallas
  function showWait(msg, sub) {
    $('wait').className = 'screen';
    $('waitMsg').innerHTML = msg || 'Conectando con la señal…';
    $('waitSub').innerHTML = sub || '';
  }
  function hideWait() { $('wait').className = 'screen hidden'; }
  function updateBadge() {
    var b = $('badge'); var t = $('badgeText');
    var map = {
      reproduciendo: ['quiet', 'En vivo'], cargando: ['warn', 'Conectando…'], reconectando: ['warn', 'Reconectando…'],
      sin_senal: ['err', 'Sin señal'], respaldo: ['warn', 'Respaldo local — sin señal central'], bloqueado_autoplay: ['warn', 'Sonido desactivado'],
      en_espera: ['warn', 'Señal detenida'], error: ['err', 'Error'], pausado: ['warn', 'Pausado']
    };
    var v = map[P.state] || ['warn', P.state];
    b.className = 'badge ' + v[0];
    t.innerHTML = v[1];
  }
  setInterval(function () {
    var d = new Date(serverNow());
    try { $('clock').innerHTML = d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { $('clock').innerHTML = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  }, 1000);

  // ---------------------------------------------------------------- reloj común (estimación tipo NTP)
  function syncClock(samples, cb) {
    var best = null; var n = 0;
    function one() {
      var t0 = now();
      http('GET', '/api/public/time?_=' + t0, null, function (err, d) {
        var t1 = now();
        if (!err && d && d.now) {
          var rtt = t1 - t0; var off = d.now - (t0 + rtt / 2);
          if (!best || rtt < best.rtt) best = { rtt: rtt, off: off };
        }
        n++;
        if (n < samples) setTimeout(one, 150); else { if (best) { P.clockOffset = Math.round(best.off); P.clockRtt = best.rtt; } if (cb) cb(); }
      }, 4000);
    }
    one();
  }

  // ---------------------------------------------------------------- arranque
  function loadState(cb) {
    http('GET', API + '/state?_=' + now(), null, function (err, d) {
      if (err || !d) return cb(err || new Error('respuesta vacía'));
      P.cfg = d; P.targetDelay = d.stream.targetDelayMs; P.seg = d.stream.segmentSeconds;
      P.configVersion = d.configVersion; P.engineMode = d.engine.mode;
      document.title = d.site.name + ' — ' + d.appName;
      cb(null, d);
    });
  }

  function boot() {
    setState('cargando');
    showWait('Conectando con la señal…', '');
    loadState(function (err) {
      if (err) {
        P.retry++;
        setState('sin_senal');
        var wait = Math.min(30, 2 * P.retry);
        showWait('Sin señal', 'Reconectando automáticamente en ' + wait + ' s');
        if (!P.disconnectedAt) { P.disconnectedAt = now(); logEvent('desconexion', { motivo: 'no se pudo obtener el estado' }); }
        if (LOCAL) { if (P.backup.ready && P.backup.manifest) { startBackup(); return; } }
        else maybeStartBackup();
        return setTimeout(boot, wait * 1000);
      }
      P.retry = 0;
      if (LOCAL) { syncClock(3, startLocal); return; }
      syncClock(5, function () {
        if (P.engineMode !== 'running') { enterEngineStopped(); return; }
        startLive();
      });
    });
  }

  // ---------------------------------------------------------------- señal en vivo
  function destroyLive() {
    if (P.hls) { try { P.hls.destroy(); } catch (e) { /* ignore */ } P.hls = null; }
    try { video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
  }

  function startLive() {
    if (P.backup.active) return; // la vuelta desde el respaldo se hace de forma controlada
    destroyLive();
    S.aligned = false; S.lastBig = null; S.settle = 0;
    var url = P.cfg.stream.url;
    var delayS = P.targetDelay / 1000;
    if (window.Hls && window.Hls.isSupported()) {
      P.mode = 'hls.js ' + window.Hls.version;
      var hls = new window.Hls({
        liveSyncDuration: delayS + P.seg,          // distancia al borde en vivo ~ retraso objetivo
        liveMaxLatencyDuration: delayS + P.seg * 6,
        maxLiveSyncPlaybackRate: 1,                 // la corrección fina la hace este reproductor
        lowLatencyMode: false, enableWorker: true, backBufferLength: 30,
        manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6
      });
      P.hls = hls;
      hls.on(window.Hls.Events.FRAG_CHANGED, function (ev, data) {
        var sn = data && data.frag ? data.frag.sn : null;
        if (typeof sn === 'number') { P.lastSeq = sn; if (P.seqs.indexOf(sn) < 0) P.seqs.push(sn); if (P.seqs.length > 300) P.seqs.shift(); }
      });
      hls.on(window.Hls.Events.ERROR, function (ev, data) {
        P.hlsErrors.push({ at: now(), fatal: !!data.fatal, type: data.type, details: data.details });
        if (P.hlsErrors.length > 30) P.hlsErrors.shift();
        if (!data.fatal) return;
        P.lastError = 'hls: ' + data.type + ' / ' + data.details;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) { onSignalLost(data.details); setTimeout(function () { if (P.hls === hls) hls.startLoad(); }, 3000); }
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); }
        else { onSignalLost(data.details); setTimeout(restartLive, 4000); }
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { play(); });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      P.mode = 'HLS nativo';
      video.src = url;
      play();
    } else {
      P.mode = 'no compatible';
      setState('error');
      P.lastError = 'El navegador no puede reproducir HLS (sin MSE ni HLS nativo).';
      showWait('Este navegador no es compatible', 'Abra /diagnostico en este televisor y consulte la documentación.');
      logEvent('error', { motivo: P.lastError });
    }
  }

  function restartLive() { if (!P.backup.active) { setState('reconectando'); startLive(); } }

  function play() {
    // Primero se intenta con sonido. Si el navegador lo impide, se reproduce en silencio y se pide una pulsación.
    video.muted = false;
    var p = video.play();
    if (p && p['catch']) {
      p.then(function () { P.soundOn = true; $('unmute').className = 'screen hidden'; }, function () {
        video.muted = true;
        var p2 = video.play();
        if (p2 && p2['catch']) p2['catch'](function () { /* se reintenta con el ciclo de vigilancia */ });
        askForSound();
      });
    } else {
      P.soundOn = !video.muted;
    }
  }

  function askForSound() {
    if (P.soundOn) return;
    if (P.state !== 'bloqueado_autoplay') logEvent('autoplay_bloqueado', null);
    setState('bloqueado_autoplay');
    $('unmute').className = 'screen';
    try { $('unmuteBtn').focus(); } catch (e) { /* ignore */ }
  }

  function enableSound() {
    video.muted = false;
    var bv = $('bvideo'); var ba = $('baudio');
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* ignore */ });
    // Desbloquea también los elementos del respaldo con el mismo gesto del usuario.
    try { ba.muted = false; if (P.backup.active && ba.paused && ba.getAttribute('src')) { var pb = ba.play(); if (pb && pb['catch']) pb['catch'](function () { /* ignore */ }); } } catch (e) { /* ignore */ }
    P.soundOn = true;
    $('unmute').className = 'screen hidden';
    logEvent('sonido_activado', null);
    var el = document.documentElement;
    var fs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fs) { try { var r = fs.call(el); if (r && r['catch']) r['catch'](function () { /* ignore */ }); } catch (e) { /* ignore */ } }
    if (!P.backup.active) setState(video.paused ? 'cargando' : 'reproduciendo');
    void bv;
  }
  $('unmuteBtn').onclick = enableSound;
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if ((k === 13 || k === 32 || k === 415 || k === 179) && !P.soundOn) { e.preventDefault(); enableSound(); }
  });

  video.addEventListener('playing', function () {
    P.lastProgressAt = now();
    hideWait();
    if (P.disconnectedAt) {
      logEvent('reconexion', { sinSenalMs: now() - P.disconnectedAt });
      P.disconnectedAt = null;
    }
    if (!P.soundOn && video.muted) askForSound(); else setState('reproduciendo');
  });
  video.addEventListener('ended', function () {
    // La lista terminó con EXT-X-ENDLIST: el administrador detuvo la señal.
    enterEngineStopped();
  });

  function enterEngineStopped() {
    destroyLive();
    setState('en_espera');
    showWait('La señal está detenida temporalmente', 'Volverá automáticamente cuando se reanude la emisión.');
    if (!P.waitingForEngine) { P.waitingForEngine = true; logEvent('senal_detenida', null); }
  }

  function onSignalLost(reason) {
    if (P.backup.active || LOCAL) return;
    if (!P.disconnectedAt) { P.disconnectedAt = now(); logEvent('desconexion', { motivo: reason || 'señal interrumpida' }); }
    var stalled = now() - P.lastProgressAt > 4000 || video.paused;
    if (stalled) setState('reconectando');
    if (stalled && now() - P.disconnectedAt > 8000) showWait('Sin señal', 'Reconectando automáticamente…');
    maybeStartBackup();
  }

  // ---------------------------------------------------------------- vigilancia y sincronización
  function playingDate() {
    if (P.hls && P.hls.playingDate) return P.hls.playingDate.getTime();
    if (video.getStartDate) {
      var sd = video.getStartDate();
      if (sd && !isNaN(sd.getTime()) && sd.getTime() > 0) return sd.getTime() + video.currentTime * 1000;
    }
    return null;
  }

  var rateSupported = true;
  setInterval(function () {
    if (P.backup.active || P.state === 'en_espera') return;
    var t = video.currentTime;
    if (!video.paused && t !== P.lastTime) { P.lastProgressAt = now(); P.lastTime = t; }
    // Estancamiento: no avanza durante 12 s => se reconstruye el reproductor.
    var blocked = P.state === 'bloqueado_autoplay' && video.paused;
    if (P.cfg && now() - P.lastProgressAt > 12000 && P.state !== 'error' && !blocked) {
      P.lastProgressAt = now();
      P.reloadFailures++;
      onSignalLost('reproducción detenida');
      if (P.reloadFailures >= 10) { logEvent('recarga', { motivo: 'fallos repetidos' }); flush(function () { location.reload(); }); return; }
      restartLive();
      return;
    }
    if (!video.paused && P.state === 'reproduciendo') P.reloadFailures = 0;
    var pd = playingDate();
    if (pd == null || video.paused) { P.delay = null; P.syncErr = null; return; }
    P.delay = Math.round(serverNow() - pd);
    P.syncErr = P.delay - P.targetDelay;
    var err = P.syncErr;
    if (S.settle > 0) { S.settle--; return; }          // tras un salto, se espera a que la medición se estabilice
    var big = Math.abs(err) > (S.aligned ? 1000 : 150);
    // Un salto solo se hace si dos mediciones seguidas lo confirman (evita reaccionar a lecturas espurias).
    if (big && S.lastBig != null && (S.lastBig > 0) === (err > 0) && Math.abs(S.lastBig - err) < 800) {
      try {
        var target = video.currentTime + err / 1000;
        var r = video.seekable;
        if (r && r.length) target = Math.max(r.start(0), Math.min(target, r.end(r.length - 1) - 0.5));
        video.currentTime = target;
        if (S.aligned) logEvent('resincronizacion', { desvioMs: err });
        S.aligned = true; S.settle = 2;
      } catch (e) { /* ignore */ }
      S.lastBig = null;
      setRate(1);
      return;
    }
    S.lastBig = big ? err : null;
    if (!big) S.aligned = true;
    if (Math.abs(err) > 100) {
      // Corrección suave: hasta ±5 % de velocidad (el navegador conserva el tono); se recupera 1 s en unos 20 s.
      setRate(1 + Math.max(-0.05, Math.min(0.05, err / 10000)));
    } else {
      setRate(1);
    }
  }, 1000);
  var S = { aligned: false, settle: 0, lastBig: null };
  P.sync = S;

  function setRate(r) {
    if (!rateSupported) return;
    try { if (Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r; } catch (e) { rateSupported = false; }
  }

  // ---------------------------------------------------------------- latido (telemetría)
  var flushing = false;
  function flush(cb) {
    if (flushing) { if (cb) cb(); return; }
    flushing = true;
    var events = P.events.slice(0, 100); var seqs = P.seqs.slice(); var bplays = P.backupPlays.slice(0, 100);
    var body = {
      sessionId: P.sessionId, state: P.state, mode: LOCAL ? 'modo local' : (P.backup.active ? 'respaldo local' : P.mode),
      seq: P.lastSeq, seqs: P.backup.active ? [] : seqs, delayMs: P.delay, syncErrorMs: P.syncErr,
      configVersion: P.configVersion, events: events, backupPlays: bplays, backupStatus: P.backup.status, error: P.lastError
    };
    http('POST', API + '/heartbeat', body, function (err, d) {
      flushing = false;
      if (!err && d && d.ok) {
        // Solo se borra lo que el servidor confirmó; si se reenvía, el servidor no lo duplica.
        P.events.splice(0, events.length); lsSet('rmdm-events-' + SLUG, P.events);
        P.backupPlays.splice(0, bplays.length); lsSet('rmdm-bplays-' + SLUG, P.backupPlays);
        P.seqs = P.seqs.filter(function (s) { return seqs.indexOf(s) < 0; });
        P.lastError = null;
        if (d.serverNow) { /* reloj ya sincronizado; se corrige periódicamente con syncClock */ }
        P.configVersion = d.configVersion;
        if (d.targetDelayMs) P.targetDelay = d.targetDelayMs;
        var prev = P.engineMode; P.engineMode = d.engineMode;
        if (!LOCAL && P.engineMode === 'running' && (prev !== 'running' || P.waitingForEngine)) { P.waitingForEngine = false; if (!P.backup.active) startLive(); }
        if (!LOCAL && P.engineMode === 'stopped' && prev === 'running' && !P.backup.active) enterEngineStopped();
        onServerReachable();
      } else if (err) {
        onServerUnreachable();
      }
      if (cb) cb();
    }, 6000);
  }
  function heartbeatLoop() { flush(); setTimeout(heartbeatLoop, ((P.cfg && P.cfg.heartbeatSeconds) || 5) * 1000); }
  setInterval(function () { syncClock(3); }, 10 * 60 * 1000);

  var serverDownSince = null;
  function onServerUnreachable() { if (!serverDownSince) serverDownSince = now(); if (now() - serverDownSince > 15000) onSignalLost('servidor inalcanzable'); }
  function onServerReachable() { serverDownSince = null; if (P.backup.active && !LOCAL) scheduleReturnToLive(); }

  // ---------------------------------------------------------------- respaldo local
  var BACKUP_CACHE = 'rmdm-respaldo-v1';
  function backupCapable() {
    if (!('serviceWorker' in navigator)) return 'no compatible: el navegador no admite service workers';
    if (!window.caches) return 'no compatible: sin Cache Storage';
    if (window.isSecureContext === false) return 'no disponible: requiere HTTPS';
    if (!window.Promise || !window.fetch) return 'no compatible: navegador antiguo';
    return null;
  }

  function registerSW() {
    if (backupCapable()) return;
    try { navigator.serviceWorker.register('/player/sw.js', { scope: '/player/' })['catch'](function () { /* ignore */ }); } catch (e) { /* ignore */ }
  }

  function downloadBackup(done) {
    done = typeof done === 'function' ? done : function () {};
    var why = backupCapable();
    if (why) { P.backup.status = why; return done(new Error(why)); }
    http('GET', API + '/backup-manifest?_=' + now() + (LOCAL ? '&modo=local' : ''), null, function (err, man) {
      if (err || !man) return done(err || new Error('sin respuesta'));
      var items = man.ads.concat(man.songs);
      if (!items.length) { P.backup.status = 'sin contenido autorizado para respaldo'; return done(new Error(P.backup.status)); }
      var total = 0; for (var i = 0; i < items.length; i++) total += items[i].bytes || 0;
      var est = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
      est.then(function (q) {
        if (q && q.quota && q.quota - q.usage < total * 1.2) {
          P.backup.status = 'espacio insuficiente (' + Math.round((q.quota - q.usage) / 1048576) + ' MB libres, se requieren ' + Math.round(total * 1.2 / 1048576) + ' MB)';
          logEvent('respaldo_no_disponible', { motivo: P.backup.status });
          done(new Error(P.backup.status));
          return;
        }
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist()['catch'](function () { /* ignore */ });
        return caches.open(BACKUP_CACHE).then(function (cache) {
          return cache.keys().then(function (keys) {
            var wanted = {}; items.forEach(function (it) { wanted[location.origin + it.url] = true; });
            var removals = keys.filter(function (k) { return !wanted[k.url]; }).map(function (k) { return cache['delete'](k); });
            return Promise.all(removals).then(function () {
              // Descarga secuencial para no competir con la señal en vivo.
              var seq = Promise.resolve(); var n = 0;
              items.forEach(function (it) {
                seq = seq.then(function () {
                  return cache.match(it.url).then(function (hit) { if (!hit) return cache.add(it.url); }).then(function () {
                    n++; if (LOCAL && !P.backup.active) showWait('Descargando música y comerciales…', n + ' de ' + items.length + ' archivos (solo la primera vez)');
                  });
                });
              });
              return seq;
            });
          });
        }).then(function () {
          P.backup.manifest = man; P.backup.ready = !!man.songs.length || !!man.ads.length;
          lsSet('rmdm-backup-manifest', man);
          P.backup.status = 'listo: ' + man.ads.length + ' comercial(es), ' + man.songs.length + ' canción(es), ' + Math.round(total / 1048576) + ' MB';
          logEvent('respaldo_descargado', { version: man.version, bytes: total });
          done(null);
        });
      })['catch'](function (e) { P.backup.status = 'error al descargar: ' + (e && e.message); done(e); });
    });
  }

  function checkCachedBackup() {
    if (backupCapable() || !P.backup.manifest) return;
    caches.open(BACKUP_CACHE).then(function (c) { return c.keys(); }).then(function (keys) {
      if (keys.length) { P.backup.ready = true; if (P.backup.status === 'sin evaluar') P.backup.status = 'listo (descargado previamente)'; }
    })['catch'](function () { /* ignore */ });
  }

  function blobUrl(url) {
    return caches.open(BACKUP_CACHE).then(function (c) { return c.match(url); }).then(function (r) {
      if (!r) throw new Error('no está en el respaldo');
      return r.blob();
    }).then(function (b) { return URL.createObjectURL(b); });
  }

  var B = { songIdx: 0, songsSince: 0, playing: null, urls: [], returnPending: false, returnDeadline: 0, current: null };

  function maybeStartBackup() {
    if (P.backup.active || !P.backup.ready || !P.backup.manifest) return;
    var stalled = now() - P.lastProgressAt > 5000 || video.paused;
    var after = ((P.cfg && P.cfg.player && P.cfg.player.backupAfterSeconds) || 20) * 1000;
    if (!P.disconnectedAt || now() - P.disconnectedAt < after || !stalled) {
      if (!P.disconnectedAt || B.checking) return; // la señal volvió o ya hay una revisión pendiente
      B.checking = true;
      setTimeout(function () { B.checking = false; maybeStartBackup(); }, 5000);
      return;
    }
    if (P.state === 'en_espera') return; // señal detenida a propósito: no se suplanta con respaldo
    startBackup();
  }

  function startBackup() {
    var man = P.backup.manifest;
    destroyLive();
    P.backup.active = true;
    setState('respaldo');
    hideWait();
    $('backup').className = '';
    logEvent('respaldo_inicio', { version: man.version });
    var bv = $('bvideo');
    if (man.ads.length) {
      blobUrl(man.ads[0].url).then(function (u) { B.urls.push(u); B.loopUrl = u; bv.src = u; bv.loop = true; bv.muted = true; var p = bv.play(); if (p && p['catch']) p['catch'](function () { /* ignore */ }); })['catch'](function () { /* ignore */ });
    }
    nextBackupItem();
  }

  function nextBackupItem() {
    if (!P.backup.active) return;
    if (B.returnPending) { stopBackup(); return; }
    var man = P.backup.manifest;
    var n = Math.max(1, man.songsBetweenAds || 2);
    var ba = $('baudio'); var bv = $('bvideo');
    if (man.ads.length && (B.songsSince >= n || !man.songs.length)) {
      // Bloque comercial desde el respaldo: video desde el inicio, con su audio.
      B.songsSince = 0;
      var ad = man.ads[B.adIdx = ((B.adIdx || 0) + 1) % man.ads.length];
      blobUrl(ad.url).then(function (u) {
        B.urls.push(u);
        var rec = { id: uuid(), adId: ad.id, startedAt: serverNow(), endedAt: null, completed: false };
        B.current = rec;
        bv.loop = false; bv.src = u; bv.currentTime = 0; bv.muted = !P.soundOn;
        bv.onended = function () {
          rec.endedAt = serverNow(); rec.completed = true; P.backupPlays.push(rec); lsSet('rmdm-bplays-' + SLUG, P.backupPlays);
          B.current = null; bv.onended = null; bv.muted = true; bv.loop = true; if (B.loopUrl) bv.src = B.loopUrl;
          var p2 = bv.play(); if (p2 && p2['catch']) p2['catch'](function () { /* ignore */ });
          nextBackupItem();
        };
        var p = bv.play(); if (p && p['catch']) p['catch'](function () { nextBackupItem(); });
      })['catch'](function () { B.songsSince = 0; setTimeout(nextBackupItem, 1000); });
      return;
    }
    if (!man.songs.length) { setTimeout(nextBackupItem, 5000); return; }
    var song = man.songs[B.songIdx % man.songs.length];
    B.songIdx++;
    blobUrl(song.url).then(function (u) {
      B.urls.push(u);
      ba.src = u; ba.onended = function () { B.songsSince++; nextBackupItem(); };
      var p = ba.play(); if (p && p['catch']) p.then(function () { if (!P.soundOn) { P.soundOn = true; $('unmute').className = 'screen hidden'; } }, function () { askForSound(); });
    })['catch'](function () { setTimeout(nextBackupItem, 1000); });
    while (B.urls.length > 6) { try { URL.revokeObjectURL(B.urls.shift()); } catch (e) { /* ignore */ } }
  }

  function startLocal() {
    var why = backupCapable();
    if (why) { showWait('Este televisor no permite el modo local', why + '. Use el link sin "?local=1".'); return; }
    function go() { if (!P.backup.active && P.backup.ready && P.backup.manifest) startBackup(); }
    if (P.backup.ready && P.backup.manifest) go(); // ya descargado antes: arranca de inmediato sin Internet
    showWait('Descargando música y comerciales…', 'Solo la primera vez');
    downloadBackup(function (err) {
      if (!err) return go();
      if (P.backup.ready) return go();
      showWait('No se pudo descargar la programación', (P.backup.status || '') + ' — reintentando en 30 s');
      setTimeout(startLocal, 30000);
    });
  }

  function scheduleReturnToLive() {
    if (B.returnPending) return;
    // Vuelve a la señal central al terminar lo que suena en el respaldo (sin cortes bruscos), máximo 5 minutos.
    B.returnPending = true;
    B.returnDeadline = now() + 5 * 60 * 1000;
  }
  setInterval(function () {
    if (P.backup.active && B.returnPending && now() > B.returnDeadline && !B.current) stopBackup();
  }, 2000);

  function stopBackup() {
    var ba = $('baudio'); var bv = $('bvideo');
    // Desvanecimiento corto para evitar un salto de audio.
    var steps = 10; var i = 0;
    var fade = setInterval(function () {
      i++; try { ba.volume = Math.max(0, 1 - i / steps); } catch (e) { /* ignore */ }
      if (i >= steps) {
        clearInterval(fade);
        try { ba.pause(); bv.pause(); ba.removeAttribute('src'); bv.removeAttribute('src'); ba.volume = 1; } catch (e) { /* ignore */ }
        while (B.urls.length) { try { URL.revokeObjectURL(B.urls.shift()); } catch (e) { /* ignore */ } }
        $('backup').className = 'hidden';
        P.backup.active = false; B.returnPending = false;
        logEvent('respaldo_fin', null);
        P.disconnectedAt = P.disconnectedAt || now();
        setState('reconectando');
        boot();
      }
    }, 150);
  }

  // ---------------------------------------------------------------- inicio
  window.addEventListener('online', function () { if (!LOCAL && !P.backup.active && P.state !== 'reproduciendo') restartLive(); });
  window.addEventListener('offline', function () { onSignalLost('el dispositivo perdió Internet'); });
  if (navigator.wakeLock && navigator.wakeLock.request) { try { navigator.wakeLock.request('screen')['catch'](function () { /* ignore */ }); } catch (e) { /* ignore */ } }

  logEvent('inicio', { ua: navigator.userAgent.slice(0, 160) });
  registerSW();
  checkCachedBackup();
  boot();
  setTimeout(heartbeatLoop, 1500);
  // El respaldo se descarga cuando la señal ya está estable, y se revisa cada 30 minutos.
  (function scheduleBackup() {
    if (!P.cfg) { setTimeout(scheduleBackup, 2000); return; }
    if (LOCAL) { setInterval(downloadBackup, 10 * 60 * 1000); return; } // revisa comerciales nuevos cada 10 min
    setTimeout(downloadBackup, ((P.cfg.player && P.cfg.player.backupDownloadDelaySeconds) || 60) * 1000);
    setInterval(downloadBackup, 30 * 60 * 1000);
  })();
  window.RMDM = P; // expuesto para diagnóstico y pruebas automatizadas
})();
