// RADIO MERCADO DON MANUEL — Panel administrativo (sin dependencias, sin paso de compilación).
const S = { user: null, csrf: null, tz: 'America/Bogota', page: null, timers: [], advertisers: [], sites: [] };

// ------------------------------------------------------------------ utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = S.csrf || '';
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opts); } catch { throw new ApiError('No hay conexión con el servidor. Revise Internet y vuelva a intentar.', 0); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/auth/login')) { showLogin('Su sesión terminó. Ingrese de nuevo.'); throw new ApiError(data.error || 'Sesión vencida', 401, data); }
  if (!r.ok) throw new ApiError(data.error || `Error ${r.status}`, r.status, data);
  return data;
}

function fmtDT(ms, withSec = true) {
  if (ms == null) return '—';
  return new Intl.DateTimeFormat('es-CO', { timeZone: S.tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}), hour12: false }).format(new Date(ms));
}
function fmtTime(ms) {
  if (ms == null) return '—';
  return new Intl.DateTimeFormat('es-CO', { timeZone: S.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
}
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtAgo(ms) {
  if (!ms) return 'nunca';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `hace ${Math.max(s, 0)} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return fmtDT(ms, false);
}
function todayLocal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const fmtBytes = (b) => (b == null ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = `toast${isErr ? ' err' : ''}`; t.textContent = msg; t.setAttribute('role', isErr ? 'alert' : 'status');
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 8000 : 4500);
}
const fail = (e) => toast(e.message || String(e), true);

function modal(html, { wide = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => ($('input, select, textarea, button.primary', bg) || $('button', bg))?.focus(), 30);
  return { el: bg, close };
}

function confirmDialog(title, text, { confirmText = 'Confirmar', danger = false, requireWord = null } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><p>${text}</p>
      ${requireWord ? `<label class="f">Para confirmar escriba <b>${esc(requireWord)}</b><input type="text" id="cw" autocomplete="off"></label>` : ''}
      <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(confirmText)}</button></div>`);
    const ok = $('#ok', m.el);
    if (requireWord) { ok.disabled = true; $('#cw', m.el).addEventListener('input', (e) => { ok.disabled = e.target.value.trim().toUpperCase() !== requireWord; }); }
    ok.addEventListener('click', () => { m.close(); resolve(true); });
    $$('[data-close]', m.el).forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

function every(ms, fn) { const id = setInterval(fn, ms); S.timers.push(id); }
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }

const LABEL = {
  mode: { running: ['Emitiendo', 'live'], stopped: ['Señal detenida', 'err'] },
  kind: { song: 'Canción', ad: 'Comercial', slate: 'Cortinilla' },
  connection: { conectada: ['Conectada', 'ok'], desconectada: ['Desconectada', 'err'], desconocido: ['Sin datos', 'off'], deshabilitada: ['Deshabilitada', 'off'] },
  player: {
    reproduciendo: ['Reproduciendo', 'ok'], cargando: ['Cargando señal', 'info'], bloqueado_autoplay: ['Sonido bloqueado: pulse OK en el TV', 'warn'],
    sin_senal: ['Sin señal', 'err'], respaldo: ['Respaldo local (sin señal central)', 'warn'], reconectando: ['Reconectando', 'warn'], error: ['Error', 'err'],
    en_espera: ['Pantalla de espera', 'info'], pausado: ['Pausado en el TV', 'warn'], sin_datos_recientes: ['Estado desconocido', 'off'], nunca_conectada: ['Nunca conectada', 'off'], desconocido: ['Estado desconocido', 'off'],
  },
  adState: { al_aire: ['Al aire', 'live'], en_rotacion: ['En rotación', 'ok'], inactivo: ['Inactivo', 'off'], vencido: ['Vencido', 'warn'], programado: ['Vigencia futura', 'info'],
    procesando: ['Validando…', 'info'], rechazado: ['Rechazado', 'err'], danado: ['Dañado', 'err'], listo: ['Listo', 'ok'] },
  play: { completado: ['Completado', 'ok'], interrumpido: ['Interrumpido', 'warn'], fallido: ['Fallido', 'err'], emitiendo: ['Emitiendo', 'live'], incierto: ['Resultado incierto', 'warn'],
    programado: ['Programado', 'info'], descartado: ['Replanificado', 'off'] },
  sitePlay: { confirmada: ['Confirmada', 'ok'], parcial: ['Parcial', 'warn'], conectada_sin_confirmacion: ['Conectada, sin telemetría', 'info'], sin_conexion: ['Sin conexión', 'off'] },
  slate: { espera: 'Cortinilla de espera', pausa: 'Programación en pausa', fuera_horario: 'Fuera del horario', sin_contenido: 'Sin contenido programado' },
};
const chip = (pair, title) => (pair ? `<span class="chip ${pair[1]}"${title ? ` title="${esc(title)}"` : ''}>${esc(pair[0])}</span>` : '');

const ICON = {
  inicio: 'M3 11 12 3l9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  emision: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4',
  sedes: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  comerciales: 'M3 5h18v12H3zM8 21h8M12 17v4M10 9l5 2-5 2z',
  anunciantes: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0',
  musica: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  programacion: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4',
  reportes: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  registros: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
  cuenta: 'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM3 22a9 9 0 0 1 18 0',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[k]}"/></svg>`;
const PAGES = [['inicio', 'Inicio'], ['emision', 'Emisión y controles'], ['sedes', 'Sedes'], ['comerciales', 'Comerciales'], ['anunciantes', 'Anunciantes'],
  ['musica', 'Música'], ['programacion', 'Programación'], ['reportes', 'Reportes'], ['registros', 'Registros'], ['cuenta', 'Cuenta']];

// ------------------------------------------------------------------ sesión
function showLogin(message) {
  clearTimers();
  S.user = null;
  $('#app').innerHTML = `<div class="login"><form class="card" id="login" autocomplete="on">
    <div class="brand"><img src="/static/assets/logo.svg" alt=""><b>RADIO MERCADO<br><span>DON MANUEL</span></b></div>
    <h1>Panel administrativo</h1>
    <p class="muted small">Acceso privado. Los enlaces de las sedes no dan acceso a este panel.</p>
    ${message ? `<div class="alert warn">${esc(message)}</div>` : ''}
    <label class="f">Usuario<input type="text" name="username" required autocomplete="username"></label><br>
    <label class="f">Contraseña<input type="password" name="password" required autocomplete="current-password"></label><br>
    <div id="lerr"></div>
    <button class="btn primary" style="width:100%">Ingresar</button></form></div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('POST', '/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
      S.csrf = r.csrf; await boot();
    } catch (err) { $('#lerr').innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
  });
}

async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    S.user = me.user; S.csrf = me.csrf; S.tz = me.timezone || S.tz;
  } catch (e) { if (e.status !== 401) showLogin(e.message); else showLogin(); return; }
  $('#app').innerHTML = `<div class="layout">
    <aside class="sidebar"><div class="brand"><img src="/static/assets/logo.svg" alt=""><b>RADIO MERCADO<br><span>DON MANUEL</span></b></div>
      <nav class="nav">${PAGES.map(([k, t]) => `<a href="#/${k}" data-page="${k}">${icon(k)}<span>${t}</span></a>`).join('')}</nav>
      <div class="foot">Usuario: ${esc(S.user.username)}<br>Zona horaria: ${esc(S.tz)}</div></aside>
    <main class="main"><div class="topbar"><h1 id="ptitle"></h1><div class="right" id="tstatus"></div></div><div id="page"></div></main></div>`;
  window.addEventListener('hashchange', route);
  route();
  refreshTopStatus();
  setInterval(refreshTopStatus, 10_000);
}

async function refreshTopStatus() {
  if (!S.user) return;
  try {
    const st = await api('GET', '/api/admin/engine');
    const on = st.onAir;
    $('#tstatus').innerHTML = `${chip(LABEL.mode[st.mode])}
      ${on ? `<span class="small muted">Al aire: <b>${esc(LABEL.kind[on.kind])}</b> · ${esc(on.title)}</span>` : ''}
      <span class="chip off" title="Versión de configuración">v${st.configVersion}</span>`;
  } catch { /* el error ya se notificó */ }
}

function route() {
  clearTimers();
  const page = (location.hash.replace('#/', '') || 'inicio').split('?')[0];
  const def = PAGES.find(([k]) => k === page) || PAGES[0];
  S.page = def[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === S.page));
  $('#ptitle').textContent = def[1];
  const el = $('#page');
  el.innerHTML = '<p class="muted">Cargando…</p>';
  (RENDER[S.page] || RENDER.inicio)(el).catch((e) => { el.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; });
}

// ------------------------------------------------------------------ INICIO
function onAirCard(st) {
  const on = st.onAir;
  if (st.mode !== 'running') return `<div class="card onair"><h2>Al aire ${chip(LABEL.mode.stopped)}</h2><p>La señal central está detenida. Las sedes muestran la pantalla de espera.</p></div>`;
  if (!on) return '<div class="card onair"><h2>Al aire</h2><p class="muted">Preparando el primer elemento…</p></div>';
  const pct = on.startedAt && on.durationMs ? Math.min(100, Math.max(0, ((Date.now() - on.startedAt) / on.durationMs) * 100)) : 0;
  const nx = st.next;
  return `<div class="card onair"><h2>Al aire ahora ${chip(['En vivo', 'live'])}</h2>
    <div class="muted small">${esc(LABEL.kind[on.kind])}${on.kind === 'song' && on.loopAdId ? ' · video del comercial en ciclo silencioso' : ''}</div>
    <div class="title">${esc(on.title)}</div>
    <div class="small muted">Inició ${fmtTime(on.startedAt)} · termina ${fmtTime(on.endsAt)} · duración ${fmtDur(on.durationMs)}</div>
    <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
    <p class="small" style="margin-top:12px"><b>Siguiente:</b> ${nx ? `${esc(LABEL.kind[nx.kind])} · ${esc(nx.title)} ${nx.ready ? '' : '<span class="chip info">preparando</span>'}` : '<span class="muted">por decidir</span>'}</p>
    <p class="small muted">Canciones desde el último comercial: <b>${st.songsSinceAd}</b> de ${st.songsBetweenAds}
      ${st.musicPaused ? ' · <span class="chip warn">música en pausa</span>' : ''}${st.adsPaused ? ' · <span class="chip warn">publicidad en pausa</span>' : ''}</p></div>`;
}

function siteMini(s) {
  return `<div class="card site-card"><div class="name">${esc(s.name)}</div>
    <div>${chip(LABEL.connection[s.connection])}</div>
    <div class="small">${chip(LABEL.player[s.playerState] || LABEL.player.desconocido)}</div>
    <div class="small muted">Último contacto: ${fmtAgo(s.lastSeenAt)}</div>
    ${s.delayMs != null ? `<div class="small muted" title="Retraso medido por el televisor respecto a la hora oficial de emisión">Retraso: ${(s.delayMs / 1000).toFixed(2)} s${s.syncErrorMs != null ? ` (desvío ${s.syncErrorMs > 0 ? '+' : ''}${s.syncErrorMs} ms)` : ''}</div>` : '<div class="small muted">Retraso: no medido</div>'}
    ${s.connection === 'conectada' && !s.configUpToDate ? '<div class="small"><span class="chip info">configuración pendiente</span></div>' : ''}</div>`;
}

const RENDER = {};
RENDER.inicio = async (el) => {
  const draw = async () => {
    const d = await api('GET', '/api/admin/dashboard');
    el.innerHTML = `
      ${d.alerts.map((a) => `<div class="alert ${a.level === 'error' ? 'error' : a.level}">${esc(a.text)}</div>`).join('')}
      <div class="grid g2">
        ${onAirCard(d.engine)}
        <div class="card"><h2>Estado de la emisora</h2>
          <table><tbody>
            <tr><td>Señal central</td><td>${chip(LABEL.mode[d.engine.mode])}</td></tr>
            <tr><td>Servidor</td><td>${chip(['En línea', 'ok'])} <span class="small muted">activo desde hace ${fmtDur(d.engine.uptimeMs)}</span></td></tr>
            <tr><td>Lista en vivo</td><td>${Date.now() - d.engine.lastPlaylistWriteAt < 3 * d.engine.segmentSeconds * 1000 ? chip(['Actualizándose', 'ok']) : chip(['Sin actualizar', 'err'])} <span class="small muted">secuencia ${d.engine.mediaSequence}</span></td></tr>
            <tr><td>Horario de emisión</td><td>${d.inHours ? chip(['Dentro del horario', 'ok']) : chip(['Fuera del horario', 'warn'])}</td></tr>
            <tr><td>Contenido</td><td>${d.counts.songs} canciones habilitadas · ${d.counts.adsInRotation} comerciales en rotación</td></tr>
            <tr><td>Sedes conectadas</td><td><b>${d.sites.filter((s) => s.connection === 'conectada').length}</b> de ${d.sites.filter((s) => s.enabled).length}</td></tr>
            <tr><td title="Diferencia entre la sede más adelantada y la más atrasada, medida por los propios televisores">Desfase entre sedes</td><td>${d.sync.spreadMs != null ? `<b>${(d.sync.spreadMs / 1000).toFixed(2)} s</b> <span class="small muted">(medido en ${d.sync.measuredSites} sedes)</span>` : '<span class="muted">sin mediciones suficientes</span>'}</td></tr>
          </tbody></table></div>
      </div>
      <h2 class="section-gap">Sedes</h2>
      <div class="grid g5">${d.sites.map(siteMini).join('')}</div>
      <div class="card section-gap"><h2>Últimos eventos <a class="small" href="#/registros">ver todos</a></h2>
        <div class="table-wrap"><table><thead><tr><th>Hora</th><th>Origen</th><th>Tipo</th><th>Detalle</th></tr></thead><tbody>
        ${d.events.map((e) => `<tr><td class="small">${fmtDT(e.at)}</td><td>${esc(e.origen)}</td><td>${esc(e.tipo)}</td><td class="small">${esc(String(e.texto).slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin eventos.</td></tr>'}
        </tbody></table></div></div>`;
  };
  await draw();
  every(5000, () => draw().catch(() => {}));
};

// ------------------------------------------------------------------ EMISIÓN Y CONTROLES
RENDER.emision = async (el) => {
  const draw = async () => {
    const [st, cfg] = await Promise.all([api('GET', '/api/admin/engine'), api('GET', '/api/admin/settings')]);
    el.innerHTML = `<div class="grid g2">${onAirCard(st)}
      <div class="card"><h2>Regla de publicidad</h2>
        <p class="muted small">Cantidad de canciones que suenan antes de cada bloque comercial. El cambio se aplica de forma segura: el contenido que está al aire nunca se corta.</p>
        <div class="form-grid">
          <label class="f">Canciones entre comerciales<div class="stepper"><button type="button" data-step="-1">−</button><output id="sba">${cfg.songsBetweenAds}</output><button type="button" data-step="1">+</button></div></label>
          <label class="f">Comerciales por bloque<select id="apb">${[1, 2, 3, 4, 5].map((n) => `<option ${n === cfg.adsPerBlock ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" id="shuf" ${cfg.musicShuffle ? 'checked' : ''}> Música en orden aleatorio</label>
        </div>
        <div class="btn-row" style="margin-top:14px"><button class="btn primary" id="saveRule">Guardar regla</button><span class="small muted">Versión de configuración actual: v${cfg.configVersion}</span></div>
      </div></div>
      <h2 class="section-gap">Controles generales</h2>
      <p class="muted small">Cada botón hace una sola cosa. La emisión vive en el servidor: cerrar este panel o apagar el computador no la detiene.</p>
      <div class="grid g2">
        <div class="ctrl-group"><h3>Música ${st.musicPaused ? chip(['En pausa', 'warn']) : chip(['Activa', 'ok'])}</h3>
          <p>Pausar la música deja de programar canciones cuando termine lo que está al aire. Si hay comerciales activos, la señal continúa solo con bloques publicitarios.</p>
          ${st.musicPaused ? '<button class="btn primary" data-act="reanudar_musica">Reanudar la música</button>' : '<button class="btn" data-act="pausar_musica">Pausar la música</button>'}</div>
        <div class="ctrl-group"><h3>Bloques publicitarios ${st.adsPaused ? chip(['En pausa', 'warn']) : chip(['Activos', 'ok'])}</h3>
          <p>Pausar la publicidad deja de programar comerciales con audio; la música sigue sonando con el video en ciclo silencioso. Un comercial al aire termina completo.</p>
          ${st.adsPaused ? '<button class="btn primary" data-act="reanudar_publicidad">Reanudar la publicidad</button>' : '<button class="btn" data-act="pausar_publicidad">Pausar la publicidad</button>'}</div>
        <div class="ctrl-group"><h3>Programación completa</h3>
          <p>Pausa controlada: al terminar el elemento actual, las sedes ven la cortinilla «Programación en pausa» sin sonido. Los televisores siguen conectados.</p>
          <div class="btn-row"><button class="btn" data-act="pausar_programacion">Pausar programación</button><button class="btn" data-act="reanudar_programacion">Reanudar programación</button></div></div>
        <div class="ctrl-group" style="border-color:#f0c4bf"><h3>Señal central ${chip(LABEL.mode[st.mode])}</h3>
          <p><b>Detener la señal</b> corta de inmediato lo que está al aire en las cinco sedes y finaliza la transmisión. Úselo solo en caso necesario.</p>
          ${st.mode === 'running' ? '<button class="btn danger" data-act="detener">Detener toda la señal</button>' : '<button class="btn primary" data-act="iniciar">Iniciar la emisión</button>'}</div>
      </div>`;
    let val = cfg.songsBetweenAds;
    $$('[data-step]', el).forEach((b) => b.addEventListener('click', () => { val = Math.min(20, Math.max(1, val + Number(b.dataset.step))); $('#sba', el).textContent = val; }));
    $('#saveRule', el).addEventListener('click', async () => {
      try {
        const r = await api('PUT', '/api/admin/settings', { songsBetweenAds: val, adsPerBlock: Number($('#apb', el).value), musicShuffle: $('#shuf', el).checked });
        toast(r.message); draw();
      } catch (e) { fail(e); }
    });
    $$('[data-act]', el).forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      let body = { action: act };
      if (act === 'detener') {
        const ok = await confirmDialog('Detener toda la señal', 'Se cortará inmediatamente lo que está al aire en las <b>cinco sedes</b>. Los televisores mostrarán la pantalla de espera hasta que vuelva a iniciar la emisión.', { confirmText: 'Detener la señal', danger: true, requireWord: 'DETENER' });
        if (!ok) return;
        body.confirm = true;
      }
      try { b.disabled = true; const r = await api('POST', '/api/admin/engine/action', body); toast(r.message); await draw(); refreshTopStatus(); }
      catch (e) { fail(e); b.disabled = false; }
    }));
  };
  await draw();
  every(5000, () => { const pg = $('.onair', el); if (pg) api('GET', '/api/admin/engine').then((st) => { pg.outerHTML = onAirCard(st); }).catch(() => {}); });
};

// ------------------------------------------------------------------ SEDES
RENDER.sedes = async (el) => {
  const draw = async () => {
    const d = await api('GET', '/api/admin/sites');
    S.sites = d.sites;
    el.innerHTML = `<p class="muted small">Abra cada enlace en el navegador del televisor de la sede. Los enlaces son públicos (sin contraseña) pero solo permiten ver la señal.
      Para revisar la compatibilidad de un televisor use <a href="/diagnostico" target="_blank">/diagnostico</a>.</p>
      <div class="grid g2">${d.sites.map((s) => {
        const full = s.url.startsWith('http') ? s.url : location.origin + s.path;
        let diag = null; try { diag = s.lastDiagnostic ? JSON.parse(s.lastDiagnostic.report) : null; } catch { /* ignore */ }
        return `<div class="card site-card">
          <h2>${esc(s.name)} <span class="btn-row">${chip(LABEL.connection[s.connection])}</span></h2>
          <div class="small muted">Identificador: <span class="mono">${esc(s.slug)}</span>${s.description ? ` · ${esc(s.description)}` : ''}</div>
          <div class="linkbox"><code>${esc(full)}</code><button class="btn sm" data-copy="${esc(full)}">Copiar</button><a class="btn sm" href="${esc(s.path)}" target="_blank" rel="noopener">Abrir</a></div>
          <table class="small"><tbody>
            <tr><td>Estado de reproducción</td><td>${chip(LABEL.player[s.playerState] || LABEL.player.desconocido)}</td></tr>
            <tr><td>Último contacto</td><td>${fmtAgo(s.lastSeenAt)} ${s.lastSeenAt ? `<span class="muted">(${fmtDT(s.lastSeenAt)})</span>` : ''}</td></tr>
            <tr><td>Versión de configuración</td><td>${s.lastConfigVersion != null ? `v${s.lastConfigVersion} ${s.configUpToDate ? chip(['al día', 'ok']) : chip(['desactualizada', 'warn'])}` : '—'}</td></tr>
            <tr><td>Retraso medido</td><td>${s.delayMs != null ? `${(s.delayMs / 1000).toFixed(2)} s · desvío ${s.syncErrorMs ?? '—'} ms` : 'no medido'}</td></tr>
            <tr><td>Reproductor</td><td>${esc(s.playerMode || '—')}</td></tr>
            <tr><td>Respaldo local</td><td>${esc(s.backupStatus || '—')}</td></tr>
            <tr><td>Última reconexión</td><td>${s.lastReconnectAt ? `${fmtDT(s.lastReconnectAt)} · estuvo sin contacto ${fmtDur(s.lastDisconnectMs)}` : '—'}</td></tr>
            <tr><td>Último error</td><td>${s.lastError ? `${esc(s.lastError)} <span class="muted">(${fmtAgo(s.lastErrorAt)})</span>` : '—'}</td></tr>
            <tr><td>Diagnóstico del TV</td><td>${diag ? `${fmtDT(s.lastDiagnostic.at, false)} · HLS: ${esc(diag.hlsSupport || '?')} · Respaldo: ${diag.serviceWorker && diag.cacheStorage ? 'posible' : 'no disponible'}` : 'sin diagnóstico'}</td></tr>
          </tbody></table>
          <details><summary class="small">Eventos recientes (${s.recentEvents.length})</summary>
            <table class="small">${s.recentEvents.map((e) => `<tr><td>${fmtDT(e.at)}</td><td>${esc(e.type)}</td><td class="muted">${esc((e.detail || '').slice(0, 100))}</td></tr>`).join('') || '<tr><td class="muted">Sin eventos.</td></tr>'}</table></details>
          <div class="btn-row"><button class="btn sm" data-edit="${s.id}">Editar sede</button></div></div>`;
      }).join('')}</div>`;
    $$('[data-copy]', el).forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Enlace copiado.'); }
      catch { prompt('Copie el enlace:', b.dataset.copy); }
    }));
    $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => {
      const s = S.sites.find((x) => x.id === Number(b.dataset.edit));
      const m = modal(`<h2>Editar ${esc(s.name)}</h2><div class="grid">
        <label class="f">Nombre visible<input type="text" id="sn" value="${esc(s.name)}" maxlength="80"></label>
        <label class="f">Descripción (opcional)<input type="text" id="sd" value="${esc(s.description || '')}" maxlength="300"></label>
        <label class="check"><input type="checkbox" id="se" ${s.enabled ? 'checked' : ''}> Sede habilitada</label>
        <p class="small muted">El identificador del enlace (<span class="mono">${esc(s.slug)}</span>) no cambia para no romper la configuración de los televisores.</p></div>
        <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button></div>`);
      $('#ok', m.el).addEventListener('click', async () => {
        try { await api('PUT', `/api/admin/sites/${s.id}`, { name: $('#sn', m.el).value, description: $('#sd', m.el).value, enabled: $('#se', m.el).checked }); m.close(); toast('Sede actualizada.'); draw(); }
        catch (e) { fail(e); }
      });
    }));
  };
  await draw();
  every(10_000, () => { if (!document.querySelector('.modal-bg')) draw().catch(() => {}); });
};

// ------------------------------------------------------------------ carga de archivos con progreso
function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-CSRF-Token', S.csrf);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `Error ${xhr.status} al subir el archivo.`));
    };
    xhr.onerror = () => reject(new Error('La carga se interrumpió (conexión perdida o archivo rechazado por tamaño).'));
    xhr.send(file);
  });
}

function makeSortable(tbody, onDrop) {
  let dragRow = null;
  $$('tr[data-id]', tbody).forEach((tr) => {
    tr.draggable = true;
    tr.addEventListener('dragstart', (e) => { dragRow = tr; tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tr.dataset.id); });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); $$('.drop-target', tbody).forEach((x) => x.classList.remove('drop-target')); });
    tr.addEventListener('dragover', (e) => { e.preventDefault(); $$('.drop-target', tbody).forEach((x) => x.classList.remove('drop-target')); if (tr !== dragRow) tr.classList.add('drop-target'); });
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragRow || dragRow === tr) return;
      tbody.insertBefore(dragRow, tr);
      onDrop($$('tr[data-id]', tbody).map((r) => Number(r.dataset.id)));
    });
  });
}

// ------------------------------------------------------------------ COMERCIALES
async function loadAdvertisers() { S.advertisers = (await api('GET', '/api/admin/advertisers')).advertisers; return S.advertisers; }
const advOptions = (sel, empty = 'Sin anunciante') => `<option value="">${empty}</option>${S.advertisers.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}${a.active ? '' : ' (inactivo)'}</option>`).join('')}`;

RENDER.comerciales = async (el) => {
  await loadAdvertisers();
  el.innerHTML = `<div class="card"><h2>Subir comercial</h2>
    <p class="small muted">Recomendado: MP4 con video H.264 y audio AAC. También se aceptan MOV, WEBM, MKV, AVI. El sistema valida el archivo, lo convierte al formato común de la señal, calcula su huella SHA-256 y solo lo marca como disponible cuando todo termina bien.</p>
    <form id="upf" class="form-grid">
      <label class="f">Archivo de video<input type="file" id="upfile" accept="video/*,.mp4,.mov,.webm,.mkv,.avi" required></label>
      <label class="f">Nombre del comercial<input type="text" id="upname" maxlength="120" required></label>
      <label class="f">Anunciante<select id="upadv">${advOptions(null)}</select></label>
      <label class="f">Posición en la lista<select id="uppos"><option value="final">Al final</option><option value="inicio">Al inicio</option></select></label>
      <label class="check"><input type="checkbox" id="upact" checked> Activar al terminar la validación</label>
      <button class="btn primary">Subir</button>
    </form>
    <div id="upstat" class="hidden" style="margin-top:12px"><div class="small" id="uptext"></div><div class="upload-progress"><div id="upbar"></div></div></div></div>
    <div class="card section-gap"><h2>Biblioteca de comerciales <span class="small muted">Arrastre ⠿ para cambiar el orden de rotación</span></h2>
    <div class="form-grid" style="margin-bottom:12px">
      <label class="f">Buscar<input type="text" id="fq" placeholder="Nombre o anunciante"></label>
      <label class="f">Anunciante<select id="fadv">${advOptions(null, 'Todos')}</select></label>
      <label class="f">Estado<select id="fst"><option value="">Todos</option>${Object.entries(LABEL.adState).filter(([k]) => k !== 'listo').map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></label>
      <label class="f">Subido desde<input type="date" id="ffrom"></label><label class="f">Hasta<input type="date" id="fto"></label>
    </div><div id="adlist"></div></div>`;
  $('#upfile', el).addEventListener('change', (e) => { const f = e.target.files[0]; if (f && !$('#upname', el).value) $('#upname', el).value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '); });
  $('#upf', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('#upfile', el).files[0];
    if (!f) return;
    if (f.size > 2048 * 1048576) return toast('El archivo supera 2 GB. Comprímalo antes de subirlo.', true);
    const q = new URLSearchParams({ name: $('#upname', el).value, filename: f.name, activate: $('#upact', el).checked ? '1' : '0', position: $('#uppos', el).value });
    if ($('#upadv', el).value) q.set('advertiserId', $('#upadv', el).value);
    $('#upstat', el).classList.remove('hidden');
    const btn = $('#upf button', el); btn.disabled = true;
    try {
      await uploadFile(`/api/admin/ads/upload?${q}`, f, (p) => { $('#upbar', el).style.width = `${(p * 100).toFixed(0)}%`; $('#uptext', el).textContent = `Subiendo ${f.name}: ${(p * 100).toFixed(0)}% de ${fmtBytes(f.size)}`; });
      $('#uptext', el).textContent = 'Archivo recibido. Validando y procesando en el servidor…';
      toast('Comercial recibido. Se está validando.');
      e.target.reset(); list();
    } catch (err) { fail(err); $('#uptext', el).textContent = err.message; }
    finally { btn.disabled = false; }
  });
  const list = async () => {
    const q = new URLSearchParams();
    if ($('#fq', el).value) q.set('q', $('#fq', el).value);
    if ($('#fadv', el).value) q.set('advertiserId', $('#fadv', el).value);
    if ($('#fst', el).value) q.set('state', $('#fst', el).value);
    if ($('#ffrom', el).value) q.set('from', $('#ffrom', el).value);
    if ($('#fto', el).value) q.set('to', $('#fto', el).value);
    const d = await api('GET', `/api/admin/ads?${q}`);
    const filtered = [...q.keys()].length > 0;
    $('#adlist', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th></th><th>Vista</th><th>Comercial</th><th>Estado</th><th>Duración</th><th title="Frecuencia relativa dentro de la rotación">Frecuencia</th><th>Vigencia</th><th>Emisiones</th><th>Acciones</th></tr></thead>
      <tbody id="adbody">${d.ads.map((a) => `<tr data-id="${a.id}">
        <td>${filtered ? '' : '<span class="handle" title="Arrastrar para ordenar">⠿</span>'}<span class="small muted">${a.position}</span></td>
        <td>${a.thumbUrl ? `<img class="thumb" src="${a.thumbUrl}" alt="" loading="lazy">` : '<div class="thumb"></div>'}</td>
        <td><b>${esc(a.name)}</b>${a.id === d.nextAdId ? ' <span class="chip info">siguiente</span>' : ''}<div class="small muted">${esc(a.advertiserName || 'Sin anunciante')} · #${a.id}</div>
          ${a.error ? `<div class="small" style="color:var(--rojo)">${esc(a.error)}</div>` : ''}${a.warnings ? `<div class="small" style="color:#8a5a00">${esc(a.warnings)}</div>` : ''}
          ${a.activateOnReady ? '<div class="small muted">Se activará al terminar la validación.</div>' : ''}</td>
        <td>${chip(LABEL.adState[a.state])}</td><td>${fmtDur(a.durationMs)}</td><td>${a.weight}×</td>
        <td class="small">${a.validFrom ? `desde ${esc(a.validFrom)}` : ''}${a.validTo ? `<br>hasta ${esc(a.validTo)}` : ''}${!a.validFrom && !a.validTo ? '<span class="muted">sin límite</span>' : ''}</td>
        <td class="small">${a.plays}<div class="muted">${a.lastPlayedAt ? fmtAgo(a.lastPlayedAt) : ''}</div></td>
        <td><div class="btn-row">
          ${a.status === 'listo' ? (a.active ? `<button class="btn sm" data-a="off" data-id="${a.id}">Desactivar</button>` : `<button class="btn sm primary" data-a="on" data-id="${a.id}">Activar</button>`) : ''}
          ${a.status === 'procesando' && !a.activateOnReady ? `<button class="btn sm" data-a="on" data-id="${a.id}">Activar al terminar</button>` : ''}
          <button class="btn sm" data-a="edit" data-id="${a.id}">Editar</button>
          ${a.status === 'listo' ? `<button class="btn sm" data-a="view" data-id="${a.id}">Ver</button><button class="btn sm" data-a="replace" data-id="${a.id}">Reemplazar</button>` : ''}
          <button class="btn sm" data-a="hist" data-id="${a.id}">Historial</button>
          ${a.plays === 0 && a.status !== 'procesando' && a.state !== 'al_aire' ? `<button class="btn sm ghost-danger" data-a="del" data-id="${a.id}">Borrar</button>` : ''}
        </div></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No hay comerciales.</td></tr>'}</tbody></table></div>`;
    if (!filtered) makeSortable($('#adbody', el), async (ids) => { try { const r = await api('POST', '/api/admin/ads/reorder', { ids }); toast(r.appliedToNext ? 'Orden guardado. Ya aplica al siguiente bloque.' : 'Orden guardado.'); list(); } catch (e) { fail(e); } });
    $$('[data-a]', el).forEach((b) => b.addEventListener('click', () => adAction(b.dataset.a, Number(b.dataset.id), d.ads, list)));
  };
  ['#fq', '#fadv', '#fst', '#ffrom', '#fto'].forEach((s) => $(s, el).addEventListener(s === '#fq' ? 'input' : 'change', () => list().catch(fail)));
  await list();
  every(4000, () => { if (!document.querySelector('.modal-bg') && !document.querySelector('tr.dragging') && document.querySelector('#adbody')) list().catch(() => {}); });
};

async function adAction(act, id, ads, reload) {
  const a = ads.find((x) => x.id === id);
  try {
    if (act === 'on') { const r = await api('POST', `/api/admin/ads/${id}/activate`); toast(r.message); }
    if (act === 'off') {
      const m = modal(`<h2>Desactivar «${esc(a.name)}»</h2>
        <p>El archivo y su historial se conservan. Elija cuándo sale de la rotación:</p>
        <label class="check"><input type="radio" name="mode" value="al_terminar" checked> <span><b>Al terminar</b> (recomendado): si está al aire, termina completo y no vuelve a programarse.</span></label><br>
        <label class="check"><input type="radio" name="mode" value="inmediato"> <span><b>Inmediatamente</b>: si está al aire se corta ahora mismo en las cinco sedes y la emisión queda registrada como interrumpida.</span></label>
        <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Desactivar</button></div>`);
      await new Promise((resolve) => $('#ok', m.el).addEventListener('click', async () => {
        try { const r = await api('POST', `/api/admin/ads/${id}/deactivate`, { mode: $('input[name=mode]:checked', m.el).value }); toast(r.message); m.close(); } catch (e) { fail(e); }
        resolve();
      }));
    }
    if (act === 'edit') {
      const m = modal(`<h2>Editar comercial</h2><div class="grid">
        <label class="f">Nombre<input type="text" id="en" value="${esc(a.name)}" maxlength="120"></label>
        <label class="f">Anunciante<select id="ea">${advOptions(a.advertiserId)}</select></label>
        <label class="f">Frecuencia en la rotación <span class="hint">1 = normal. Con 2, sale el doble de veces que uno de frecuencia 1, sin repetirse seguido.</span>
          <select id="ew">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option ${n === a.weight ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="grid g2"><label class="f">Vigencia desde <span class="hint">hora de Colombia</span><input type="datetime-local" id="ef" value="${esc((a.validFrom || '').replace(' ', 'T'))}"></label>
        <label class="f">Vigencia hasta<input type="datetime-local" id="et" value="${esc((a.validTo || '').replace(' ', 'T'))}"></label></div>
        <p class="small muted">Archivo original: ${esc(a.originalName || '—')} · ${fmtBytes(a.sizeBytes)} · ${a.width || '?'}×${a.height || '?'}<br>SHA-256: <span class="mono">${esc(a.sha256 || '—')}</span></p></div>
        <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button></div>`);
      await new Promise((resolve) => $('#ok', m.el).addEventListener('click', async () => {
        try {
          await api('PUT', `/api/admin/ads/${id}`, { name: $('#en', m.el).value, advertiserId: $('#ea', m.el).value || null, weight: Number($('#ew', m.el).value),
            validFrom: $('#ef', m.el).value || null, validTo: $('#et', m.el).value || null });
          toast('Comercial actualizado.'); m.close();
        } catch (e) { fail(e); }
        resolve();
      }));
    }
    if (act === 'view') {
      modal(`<h2>${esc(a.name)}</h2><video src="${a.videoUrl}" controls style="width:100%;border-radius:8px;background:#000"></video>
        <p class="small muted">Vista previa del archivo procesado tal como sale en la señal.</p><div class="actions"><button class="btn" data-close>Cerrar</button></div>`, { wide: true });
      return;
    }
    if (act === 'replace') {
      const candidates = ads.filter((x) => x.id !== id && ['listo', 'procesando'].includes(x.status));
      const m = modal(`<h2>Reemplazar «${esc(a.name)}»</h2>
        <p class="small">El comercial actual termina normalmente si está al aire. El reemplazo toma su posición y frecuencia, y se usa en el siguiente ciclo. Para usar un video nuevo, súbalo primero en «Subir comercial».</p>
        <label class="f">Reemplazar por<select id="rw">${candidates.map((x) => `<option value="${x.id}">${esc(x.name)} (${LABEL.adState[x.state]?.[0] || x.state})</option>`).join('')}</select></label>
        <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok" ${candidates.length ? '' : 'disabled'}>Reemplazar</button></div>`);
      await new Promise((resolve) => $('#ok', m.el).addEventListener('click', async () => {
        try { const r = await api('POST', `/api/admin/ads/${id}/replace`, { withAdId: Number($('#rw', m.el).value) }); toast(r.message); m.close(); } catch (e) { fail(e); }
        resolve();
      }));
    }
    if (act === 'hist') {
      const h = await api('GET', `/api/admin/ads/${id}/history`);
      modal(`<h2>Historial de «${esc(a.name)}»</h2><p class="small muted">${h.total} eventos registrados (se conservan aunque el comercial se desactive).</p>
        <div class="table-wrap"><table><thead><tr><th>Inicio</th><th>Estado</th><th>Emitido</th><th>Sedes</th><th>Motivo</th></tr></thead><tbody>
        ${h.items.map((p) => `<tr><td class="small">${fmtDT(p.startedAt || p.scheduledAt)}</td><td>${chip(LABEL.play[p.status])}</td><td>${fmtDur(p.observedMs)} / ${fmtDur(p.expectedMs)}</td>
          <td>${p.sites.map((s) => chip(LABEL.sitePlay[s.status], `${s.site}: ${s.segmentsSeen}/${s.segmentsExpected ?? '?'} segmentos`)).join(' ')}</td><td class="small">${esc(p.interruptionReason || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin emisiones.</td></tr>'}
        </tbody></table></div><div class="actions"><button class="btn" data-close>Cerrar</button></div>`, { wide: true });
      return;
    }
    if (act === 'del') {
      if (!(await confirmDialog('Borrar comercial', `Se borrará «${esc(a.name)}» y sus archivos. Solo es posible porque nunca se ha emitido.`, { confirmText: 'Borrar', danger: true }))) return;
      await api('DELETE', `/api/admin/ads/${id}`); toast('Comercial borrado.');
    }
  } catch (e) { fail(e); }
  reload();
}

// ------------------------------------------------------------------ ANUNCIANTES
RENDER.anunciantes = async (el) => {
  const draw = async () => {
    await loadAdvertisers();
    el.innerHTML = `<div class="btn-row" style="margin-bottom:12px"><button class="btn primary" id="new">Nuevo anunciante</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Anunciante</th><th>Contacto</th><th>Vigencia</th><th>Estado</th><th>Comerciales</th><th>Emisiones completas</th><th></th></tr></thead><tbody>
      ${S.advertisers.map((a) => `<tr><td><b>${esc(a.name)}</b>${a.notes ? `<div class="small muted">${esc(a.notes)}</div>` : ''}</td>
        <td class="small">${esc(a.contactName || '')}<br>${esc(a.phone || '')} ${esc(a.email || '')}</td>
        <td class="small">${a.validFrom ? `desde ${esc(a.validFrom)}<br>` : ''}${a.validTo ? `hasta ${esc(a.validTo)}` : ''}${!a.validFrom && !a.validTo ? '<span class="muted">sin límite</span>' : ''}</td>
        <td>${a.active ? chip(['Activo', 'ok']) : chip(['Inactivo', 'off'])}</td><td>${a.ads}</td><td>${a.plays}</td>
        <td><button class="btn sm" data-edit="${a.id}">Editar</button> <a class="btn sm" href="#/reportes?advertiserId=${a.id}">Reporte</a></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aún no hay anunciantes.</td></tr>'}
      </tbody></table></div></div>
      <p class="small muted">Si un anunciante se desactiva o vence su vigencia, sus comerciales dejan de programarse aunque estén activos.</p>`;
    $('#new', el).addEventListener('click', () => advForm(null, draw));
    $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => advForm(S.advertisers.find((x) => x.id === Number(b.dataset.edit)), draw)));
  };
  await draw();
};

function advForm(a, done) {
  const v = a || { active: true };
  const m = modal(`<h2>${a ? 'Editar anunciante' : 'Nuevo anunciante'}</h2><div class="grid">
    <label class="f">Nombre del negocio<input type="text" id="an" value="${esc(v.name || '')}" maxlength="120"></label>
    <div class="grid g2"><label class="f">Persona de contacto<input type="text" id="ac" value="${esc(v.contactName || '')}"></label>
    <label class="f">Teléfono<input type="text" id="ap" value="${esc(v.phone || '')}"></label></div>
    <label class="f">Correo<input type="email" id="ae" value="${esc(v.email || '')}"></label>
    <div class="grid g2"><label class="f">Vigencia desde<input type="datetime-local" id="af" value="${esc((v.validFrom || '').replace(' ', 'T'))}"></label>
    <label class="f">Vigencia hasta<input type="datetime-local" id="at" value="${esc((v.validTo || '').replace(' ', 'T'))}"></label></div>
    <label class="f">Notas<textarea id="ano" rows="2">${esc(v.notes || '')}</textarea></label>
    <label class="check"><input type="checkbox" id="aa" ${v.active ? 'checked' : ''}> Activo</label></div>
    <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button></div>`);
  $('#ok', m.el).addEventListener('click', async () => {
    const body = { name: $('#an', m.el).value, contactName: $('#ac', m.el).value, phone: $('#ap', m.el).value, email: $('#ae', m.el).value,
      validFrom: $('#af', m.el).value || null, validTo: $('#at', m.el).value || null, notes: $('#ano', m.el).value, active: $('#aa', m.el).checked };
    try { await api(a ? 'PUT' : 'POST', a ? `/api/admin/advertisers/${a.id}` : '/api/admin/advertisers', body); m.close(); toast('Anunciante guardado.'); done(); }
    catch (e) { fail(e); }
  });
}

// ------------------------------------------------------------------ MÚSICA
RENDER.musica = async (el) => {
  el.innerHTML = `<div class="card"><h2>Subir canciones</h2>
    <p class="small muted">Archivos MP3 (también M4A, AAC, WAV, OGG, FLAC). Puede seleccionar varios a la vez. El volumen se normaliza para que todas las canciones y los comerciales suenen parejo.
    Use solo música con los derechos de difusión correspondientes.</p>
    <div class="btn-row"><input type="file" id="mfiles" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac" multiple><button class="btn primary" id="mup">Subir seleccionadas</button></div>
    <div id="mstat" class="small" style="margin-top:8px"></div></div>
    <div class="card section-gap"><h2>Lista musical <span class="small muted">Arrastre ⠿ para ordenar · «Respaldo» = se descarga en los televisores para sonar sin Internet</span></h2><div id="mlist"></div></div>`;
  $('#mup', el).addEventListener('click', async () => {
    const files = [...$('#mfiles', el).files];
    if (!files.length) return toast('Seleccione uno o más archivos.', true);
    let ok = 0;
    for (const [i, f] of files.entries()) {
      try {
        await uploadFile(`/api/admin/music/upload?${new URLSearchParams({ filename: f.name })}`, f,
          (p) => { $('#mstat', el).textContent = `Subiendo ${i + 1} de ${files.length}: ${f.name} (${(p * 100).toFixed(0)}%)`; });
        ok++;
      } catch (e) { toast(`${f.name}: ${e.message}`, true); }
    }
    $('#mstat', el).textContent = `${ok} de ${files.length} archivo(s) recibidos. Se están procesando.`;
    $('#mfiles', el).value = ''; list();
  });
  const list = async () => {
    const d = await api('GET', '/api/admin/music');
    const total = d.songs.filter((s) => s.enabled && s.status === 'listo').reduce((a, s) => a + (s.durationMs || 0), 0);
    $('#mlist', el).innerHTML = `<p class="small muted">${d.songs.length} canciones · duración habilitada: ${fmtDur(total)}</p>
      <div class="table-wrap"><table><thead><tr><th></th><th>Título</th><th>Artista</th><th>Duración</th><th>Estado</th><th>Habilitada</th><th>Respaldo</th><th></th></tr></thead><tbody id="mbody">
      ${d.songs.map((s) => `<tr data-id="${s.id}"><td><span class="handle">⠿</span></td>
        <td><b>${esc(s.title)}</b>${s.id === d.onAirSongId ? ' <span class="chip live">al aire</span>' : ''}${s.error ? `<div class="small" style="color:var(--rojo)">${esc(s.error)}</div>` : ''}</td>
        <td>${esc(s.artist || '')}</td><td>${fmtDur(s.durationMs)}</td><td>${chip(LABEL.adState[s.status] || [s.status, 'off'])}</td>
        <td><input type="checkbox" data-t="enabled" data-id="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Habilitada"></td>
        <td><input type="checkbox" data-t="backup" data-id="${s.id}" ${s.backup ? 'checked' : ''} aria-label="Respaldo"></td>
        <td><div class="btn-row">${s.audioUrl ? `<button class="btn sm" data-play="${s.audioUrl}">▶</button>` : ''}<button class="btn sm" data-edit="${s.id}">Editar</button><button class="btn sm ghost-danger" data-arch="${s.id}">Quitar</button></div></td></tr>`).join('')
        || '<tr><td colspan="8" class="muted">La biblioteca musical está vacía. Suba los MP3 cuando los tenga listos.</td></tr>'}</tbody></table></div><audio id="prev" controls class="hidden" style="width:100%;margin-top:10px"></audio>`;
    makeSortable($('#mbody', el), async (ids) => { try { await api('POST', '/api/admin/music/reorder', { ids }); toast('Orden guardado.'); } catch (e) { fail(e); } });
    const save = async (s, patch) => { try { await api('PUT', `/api/admin/music/${s.id}`, { title: s.title, artist: s.artist, enabled: s.enabled, backup: s.backup, ...patch }); toast('Guardado.'); list(); } catch (e) { fail(e); } };
    $$('[data-t]', el).forEach((c) => c.addEventListener('change', () => save(d.songs.find((s) => s.id === Number(c.dataset.id)), { [c.dataset.t]: c.checked })));
    $$('[data-play]', el).forEach((b) => b.addEventListener('click', () => { const a = $('#prev', el); a.classList.remove('hidden'); a.src = b.dataset.play; a.play(); }));
    $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => {
      const s = d.songs.find((x) => x.id === Number(b.dataset.edit));
      const m = modal(`<h2>Editar canción</h2><div class="grid"><label class="f">Título<input type="text" id="st" value="${esc(s.title)}"></label>
        <label class="f">Artista<input type="text" id="sa" value="${esc(s.artist || '')}"></label></div>
        <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ok">Guardar</button></div>`);
      $('#ok', m.el).addEventListener('click', async () => { await save(s, { title: $('#st', m.el).value, artist: $('#sa', m.el).value }); m.close(); });
    }));
    $$('[data-arch]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Quitar canción', 'La canción deja de sonar y desaparece de la lista. El registro de emisiones se conserva.', { confirmText: 'Quitar', danger: true }))) return;
      try { await api('POST', `/api/admin/music/${b.dataset.arch}/archive`); toast('Canción retirada.'); list(); } catch (e) { fail(e); }
    }));
  };
  await list();
  every(5000, () => { if (!document.querySelector('.modal-bg') && !document.querySelector('tr.dragging') && $('#prev', el)?.paused !== false) list().catch(() => {}); });
};

// ------------------------------------------------------------------ PROGRAMACIÓN
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
RENDER.programacion = async (el) => {
  const [sch, cfg] = await Promise.all([api('GET', '/api/admin/schedule'), api('GET', '/api/admin/settings')]);
  let hours = sch.hours.map((h) => ({ ...h }));
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const drawWeek = () => {
    const H = 336; const px = (m) => (m / 1440) * H;
    const nowP = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: S.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const nowMin = Number(nowP.hour) * 60 + Number(nowP.minute);
    const blocks = Array.from({ length: 7 }, () => []);
    for (const h of hours) {
      const s = toMin(h.start); const e = toMin(h.end);
      if (e > s) blocks[h.weekday].push([s, e, `${h.start}–${h.end}`]);
      else { blocks[h.weekday].push([s, 1440, `${h.start}–24:00`]); blocks[(h.weekday + 1) % 7].push([0, e, `00:00–${h.end}`]); }
    }
    return `<div class="week"><div></div>${DAYS.map((d, i) => `<div class="dname">${d.slice(0, 3)}${i === sch.weekdayNow ? ' •' : ''}</div>`).join('')}
      <div class="hours">${[0, 6, 12, 18, 24].map((h) => `<span style="top:${px(h * 60)}px">${String(h).padStart(2, '0')}:00</span>`).join('')}</div>
      ${blocks.map((bs, i) => `<div class="col">${bs.map(([s, e, t]) => `<div class="block" style="top:${px(s)}px;height:${Math.max(px(e - s), 10)}px">${t}</div>`).join('')}
        ${i === sch.weekdayNow ? `<div class="now" style="top:${px(nowMin)}px" title="Ahora"></div>` : ''}</div>`).join('')}</div>`;
  };
  const drawRows = () => hours.map((h, i) => `<div class="btn-row" style="margin-bottom:6px">
      <select data-i="${i}" data-k="weekday">${DAYS.map((d, n) => `<option value="${n}" ${n === h.weekday ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <input type="time" data-i="${i}" data-k="start" value="${h.start}"> a <input type="time" data-i="${i}" data-k="end" value="${h.end}">
      <button class="btn sm ghost-danger" data-del="${i}">Quitar</button></div>`).join('') || '<p class="muted">Sin franjas: la radio quedará fuera del horario todo el tiempo.</p>';
  const PATCH_LABEL = { songs_between_ads: 'Canciones entre comerciales', ads_per_block: 'Comerciales por bloque', music_paused: 'Música en pausa', ads_paused: 'Publicidad en pausa' };
  el.innerHTML = `<div class="grid g2">
    <div class="card"><h2>Horario de emisión <span class="small muted">${esc(sch.timezone)} · ahora ${esc(sch.nowLocal)}</span></h2>
      <div id="week">${drawWeek()}</div>
      <p class="small muted">Fuera del horario, las sedes ven la cortinilla «Fuera del horario de emisión» sin sonido. Una franja que termina antes de empezar (p. ej. 20:00 a 02:00) cruza la medianoche. Una canción o comercial al aire termina completo aunque se cumpla la hora.</p></div>
    <div class="card"><h2>Franjas</h2><div id="rows">${drawRows()}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" id="add">Agregar franja</button><button class="btn" id="copy">Copiar el lunes a todos los días</button><button class="btn primary" id="saveH">Guardar horario</button></div></div></div>
    <div class="grid g2 section-gap">
      <div class="card"><h2>Programar un cambio futuro</h2>
        <p class="small muted">El servidor lo aplica solo, a la hora indicada (hora de Colombia), aunque el panel esté cerrado. Regla actual: ${cfg.songsBetweenAds} canciones, ${cfg.adsPerBlock} comercial(es) por bloque.</p>
        <div class="form-grid">
          <label class="f">Fecha y hora<input type="datetime-local" id="cat"></label>
          <label class="f">Canciones entre comerciales<input type="number" id="csba" min="1" max="20" placeholder="sin cambio"></label>
          <label class="f">Comerciales por bloque<input type="number" id="capb" min="1" max="5" placeholder="sin cambio"></label>
          <label class="f">Música<select id="cmp"><option value="">sin cambio</option><option value="true">Pausar</option><option value="false">Reanudar</option></select></label>
          <label class="f">Publicidad<select id="cap"><option value="">sin cambio</option><option value="true">Pausar</option><option value="false">Reanudar</option></select></label>
          <label class="f">Descripción<input type="text" id="cde" maxlength="200" placeholder="Ej.: más publicidad en fin de semana"></label>
        </div><div class="btn-row" style="margin-top:10px"><button class="btn primary" id="addC">Programar cambio</button></div></div>
      <div class="card"><h2>Cambios programados</h2><div class="table-wrap"><table><thead><tr><th>Cuándo</th><th>Cambio</th><th>Estado</th><th></th></tr></thead><tbody>
        ${sch.changes.map((c) => `<tr><td class="small">${esc(c.effectiveAt)}${c.description ? `<div class="muted">${esc(c.description)}</div>` : ''}</td>
          <td class="small">${Object.entries(c.patch).map(([k, v]) => `${PATCH_LABEL[k] || k}: <b>${v === true ? 'sí' : v === false ? 'no' : esc(v)}</b>`).join('<br>')}</td>
          <td>${chip({ pendiente: ['Pendiente', 'info'], aplicado: ['Aplicado', 'ok'], cancelado: ['Cancelado', 'off'] }[c.status])}${c.appliedAt ? `<div class="small muted">${esc(c.appliedAt)}</div>` : ''}</td>
          <td>${c.status === 'pendiente' ? `<button class="btn sm" data-cancel="${c.id}">Cancelar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No hay cambios programados.</td></tr>'}
      </tbody></table></div></div></div>`;
  const rebind = () => {
    $('#rows', el).innerHTML = drawRows(); $('#week', el).innerHTML = drawWeek();
    $$('#rows [data-i]', el).forEach((inp) => inp.addEventListener('change', () => { const h = hours[Number(inp.dataset.i)]; h[inp.dataset.k] = inp.dataset.k === 'weekday' ? Number(inp.value) : inp.value; $('#week', el).innerHTML = drawWeek(); }));
    $$('#rows [data-del]', el).forEach((b) => b.addEventListener('click', () => { hours.splice(Number(b.dataset.del), 1); rebind(); }));
  };
  rebind();
  $('#add', el).addEventListener('click', () => { hours.push({ weekday: 1, start: '07:00', end: '21:00' }); rebind(); });
  $('#copy', el).addEventListener('click', () => {
    const mon = hours.filter((h) => h.weekday === 1);
    if (!mon.length) return toast('Primero defina al menos una franja para el lunes.', true);
    hours = []; for (let d = 0; d < 7; d++) for (const h of mon) hours.push({ ...h, weekday: d });
    rebind();
  });
  $('#saveH', el).addEventListener('click', async () => {
    try { await api('PUT', '/api/admin/schedule/hours', { hours }); toast('Horario guardado. Se aplica en la siguiente transición.'); } catch (e) { fail(e); }
  });
  $('#addC', el).addEventListener('click', async () => {
    try {
      await api('POST', '/api/admin/schedule/changes', { effectiveAt: $('#cat', el).value, songsBetweenAds: $('#csba', el).value, adsPerBlock: $('#capb', el).value,
        musicPaused: $('#cmp', el).value, adsPaused: $('#cap', el).value, description: $('#cde', el).value });
      toast('Cambio programado.'); RENDER.programacion(el);
    } catch (e) { fail(e); }
  });
  $$('[data-cancel]', el).forEach((b) => b.addEventListener('click', async () => {
    try { await api('DELETE', `/api/admin/schedule/changes/${b.dataset.cancel}`); toast('Cambio cancelado.'); RENDER.programacion(el); } catch (e) { fail(e); }
  }));
};

// ------------------------------------------------------------------ REPORTES
RENDER.reportes = async (el) => {
  await loadAdvertisers();
  const [ads, sites] = await Promise.all([api('GET', '/api/admin/ads'), api('GET', '/api/admin/sites')]);
  const pre = new URLSearchParams(location.hash.split('?')[1] || '');
  const today = todayLocal();
  el.innerHTML = `<div class="alert info small">Los reportes muestran solo eventos registrados por el sistema. «Completado» significa que el motor central emitió el comercial entero en la señal común (una sola emisión para las cinco sedes).
    «Confirmada» en una sede significa que su televisor informó haber reproducido al menos el 90&nbsp;% de los segmentos del comercial. Nada de esto prueba que una persona lo haya visto.</div>
    <div class="card"><div class="form-grid">
      <label class="f">Desde<input type="date" id="rf" value="${pre.get('from') || today}"></label>
      <label class="f">Hasta<input type="date" id="rt" value="${pre.get('to') || today}"></label>
      <label class="f">Anunciante<select id="radv">${advOptions(Number(pre.get('advertiserId')) || null, 'Todos')}</select></label>
      <label class="f">Comercial<select id="rad"><option value="">Todos</option>${ads.ads.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
      <label class="f">Sede (con confirmación)<select id="rs"><option value="">Todas</option>${sites.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="f">Estado<select id="rst"><option value="">Todos</option>${['completado', 'interrumpido', 'fallido', 'emitiendo', 'incierto'].map((k) => `<option value="${k}">${LABEL.play[k][0]}</option>`).join('')}</select></label>
      <div class="btn-row"><button class="btn primary" id="rgo">Consultar</button><a class="btn" id="rcsv" href="#">Exportar CSV</a></div></div></div>
    <div class="card section-gap" id="rsum"></div>
    <div class="card section-gap"><h2>Emisiones <span class="small muted" id="rtotal"></span></h2><div id="rlist"></div><div class="btn-row" id="rpag" style="margin-top:10px"></div></div>
    <div class="card section-gap"><h2>Reproducciones con respaldo local <span class="small muted">(sin señal central, informadas por el televisor al reconectarse)</span></h2><div id="rback"></div></div>`;
  let offset = 0; const LIMIT = 100;
  const params = () => {
    const q = new URLSearchParams({ from: $('#rf', el).value, to: $('#rt', el).value, limit: LIMIT, offset });
    for (const [id, k] of [['#radv', 'advertiserId'], ['#rad', 'adId'], ['#rs', 'siteId'], ['#rst', 'status']]) if ($(id, el).value) q.set(k, $(id, el).value);
    return q;
  };
  const load = async () => {
    const q = params();
    $('#rcsv', el).href = `/api/admin/reports/plays.csv?${q}`;
    const [d, sum, back] = await Promise.all([api('GET', `/api/admin/reports/plays?${q}`), api('GET', `/api/admin/reports/summary?date=${$('#rt', el).value}`), api('GET', '/api/admin/reports/backup')]);
    $('#rtotal', el).textContent = `${d.total} registros`;
    $('#rsum', el).innerHTML = `<h2>Resumen del ${esc(sum.date)} <span class="small muted">${sum.songsAired} canciones emitidas</span></h2>
      <div class="table-wrap"><table><thead><tr><th>Comercial</th><th>Anunciante</th><th>Completados</th><th>Interrumpidos</th><th>Fallidos</th><th>Tiempo emitido</th><th>Confirmaciones por sede</th></tr></thead><tbody>
      ${sum.ads.map((a) => `<tr><td>${esc(a.ad_name)}</td><td>${esc(a.advertiser_name || '—')}</td><td><b>${a.completados}</b></td><td>${a.interrumpidos}</td><td>${a.fallidos}</td><td>${fmtDur(a.ms_emitidos)}</td>
        <td class="small">${sum.perSite.filter((p) => p.ad_id === a.ad_id).map((p) => `${esc(p.name)}: ${p.confirmadas}/${p.emisiones_con_telemetria}`).join(' · ') || '<span class="muted">sin telemetría</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin emisiones ese día.</td></tr>'}
      </tbody></table></div>`;
    $('#rlist', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Inicio</th><th>Fin</th><th>Comercial</th><th>Estado central</th><th>Emitido / esperado</th><th>Sedes</th><th>Detalle</th></tr></thead><tbody>
      ${d.items.map((p) => `<tr><td class="small">${fmtDT(p.startedAt || p.scheduledAt)}</td><td class="small">${fmtTime(p.endedAt)}</td>
        <td><b>${esc(p.adName)}</b><div class="small muted">${esc(p.advertiserName || '')}</div></td><td>${chip(LABEL.play[p.status])}</td>
        <td>${fmtDur(p.observedMs)} / ${fmtDur(p.expectedMs)}</td>
        <td>${p.sites.map((s) => chip(LABEL.sitePlay[s.status], `${s.site}: ${s.segmentsSeen}/${s.segmentsExpected ?? '?'} segmentos confirmados`)).join(' ')}</td>
        <td class="small">${esc(p.interruptionReason || '')}<div class="muted mono">${esc(p.id.slice(0, 8))} · v${p.configVersion ?? '?'} · seq ${p.firstSeq ?? '?'}–${p.lastSeq ?? '?'}</div></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin resultados.</td></tr>'}
      </tbody></table></div>`;
    $('#rpag', el).innerHTML = `${offset > 0 ? '<button class="btn sm" id="prev">← Anteriores</button>' : ''}${offset + LIMIT < d.total ? '<button class="btn sm" id="next">Siguientes →</button>' : ''}`;
    $('#prev', el)?.addEventListener('click', () => { offset = Math.max(0, offset - LIMIT); load().catch(fail); });
    $('#next', el)?.addEventListener('click', () => { offset += LIMIT; load().catch(fail); });
    $('#rback', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Sede</th><th>Comercial</th><th>Inicio (reloj del TV)</th><th>Completo</th></tr></thead><tbody>
      ${back.items.map((b) => `<tr><td>${esc(b.site_name)}</td><td>${esc(b.ad_name || `#${b.ad_id}`)}</td><td class="small">${fmtDT(b.started_at)}</td><td>${b.completed ? 'sí' : 'no'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin reproducciones de respaldo.</td></tr>'}
      </tbody></table></div>`;
  };
  $('#rgo', el).addEventListener('click', () => { offset = 0; load().catch(fail); });
  await load();
};

// ------------------------------------------------------------------ REGISTROS
RENDER.registros = async (el) => {
  const tabs = [['engine', 'Motor y errores'], ['asrun', 'Emisión (as-run)'], ['sites', 'Eventos de sedes'], ['audit', 'Acciones administrativas'], ['diagnostics', 'Diagnósticos de TV']];
  el.innerHTML = `<div class="tabs">${tabs.map(([k, t], i) => `<button data-t="${k}" class="${i === 0 ? 'active' : ''}">${t}</button>`).join('')}</div><div id="lg"></div>`;
  const load = async (type) => {
    const d = await api('GET', `/api/admin/logs?type=${type}`);
    const rows = {
      engine: (r) => `<tr><td class="small">${fmtDT(r.at)}</td><td>${chip({ error: ['Error', 'err'], warn: ['Aviso', 'warn'], info: ['Info', 'info'] }[r.level] || [r.level, 'off'])}</td><td>${esc(r.message)}<div class="small muted mono">${esc(r.detail || '')}</div></td></tr>`,
      asrun: (r) => `<tr><td class="small">${fmtDT(r.actual_start)}</td><td>${esc(LABEL.kind[r.kind])}</td><td>${esc(r.title || LABEL.slate[r.slate] || '')}</td><td>${esc(r.status)}</td><td>${fmtDur(r.duration_ms)}</td><td class="small muted">${r.first_seq ?? ''}–${r.last_seq ?? ''} ${esc(r.note || '')}</td></tr>`,
      sites: (r) => `<tr><td class="small">${fmtDT(r.at)}</td><td>${esc(r.site_name)}</td><td>${esc(r.type)}</td><td class="small muted">${esc(r.detail || '')}</td></tr>`,
      audit: (r) => `<tr><td class="small">${fmtDT(r.at)}</td><td>${esc(r.username || '—')}</td><td>${esc(r.action)}</td><td class="small muted">${esc(r.entity || '')} ${esc(r.entity_id || '')} ${esc(r.detail || '')}</td><td class="small muted">${esc(r.ip || '')}</td></tr>`,
      diagnostics: (r) => `<tr><td class="small">${fmtDT(r.at)}</td><td>${esc(r.site_name || 'sin sede')}</td><td class="small mono" style="max-width:700px;white-space:pre-wrap">${esc(r.report)}</td></tr>`,
    }[type];
    $('#lg', el).innerHTML = `<div class="card"><div class="table-wrap"><table><tbody>${d.items.map(rows).join('') || '<tr><td class="muted">Sin registros.</td></tr>'}</tbody></table></div></div>`;
  };
  $$('.tabs button', el).forEach((b) => b.addEventListener('click', () => { $$('.tabs button', el).forEach((x) => x.classList.remove('active')); b.classList.add('active'); load(b.dataset.t).catch(fail); }));
  await load('engine');
};

// ------------------------------------------------------------------ CUENTA
RENDER.cuenta = async (el) => {
  el.innerHTML = `<div class="grid g2"><div class="card"><h2>Cambiar contraseña</h2><div class="grid">
    <label class="f">Contraseña actual<input type="password" id="pc" autocomplete="current-password"></label>
    <label class="f">Nueva contraseña <span class="hint">Mínimo 10 caracteres, con letras y números.</span><input type="password" id="pn" autocomplete="new-password"></label>
    <label class="f">Repita la nueva contraseña<input type="password" id="pr" autocomplete="new-password"></label></div>
    <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="pw">Cambiar contraseña</button></div></div>
    <div class="card"><h2>Sesión</h2><p>Usuario: <b>${esc(S.user.username)}</b></p><p class="small muted">Cerrar sesión no afecta la emisión: la radio sigue funcionando en el servidor.</p>
    <button class="btn" id="lo">Cerrar sesión</button></div></div>`;
  $('#pw', el).addEventListener('click', async () => {
    if ($('#pn', el).value !== $('#pr', el).value) return toast('Las contraseñas nuevas no coinciden.', true);
    try { await api('POST', '/api/auth/password', { current: $('#pc', el).value, next: $('#pn', el).value }); toast('Contraseña actualizada. Las otras sesiones se cerraron.'); $$('input', el).forEach((i) => { i.value = ''; }); }
    catch (e) { fail(e); }
  });
  $('#lo', el).addEventListener('click', async () => { await api('POST', '/api/auth/logout').catch(() => {}); showLogin('Sesión cerrada.'); });
};

boot();
