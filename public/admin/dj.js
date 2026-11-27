/* Panel DJ — diseño (versión 1). Los botones aún no controlan la radio:
   falta conectarlos con admin-routes.js y scheduler.js. */
class Panel {

  constructor(p) { this.state = { auto: true, cross: 30, tab: 'todo', playA: true, playB: false, fx: { FILTRO: true } }; }
  bars(n, seed, f) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.31 + seed) * 0.6 + Math.sin(i * 0.07 + seed * 3) * 0.4);
      out.push(f(i, 14 + Math.round(v * 84)));
    }
    return out;
  }
  renderVals() {
    const s = this.state;
    const mk = (id, color, dim, playing, prog, label, title, artist, bpm, key, pitch, pitchTop, rot, elapsed, remain, order) => ({
      id, color, label, glow: id === 'A' ? 'rgba(255,140,0,0.35)' : 'rgba(0,229,255,0.35)', title, artist, bpm, key, pitch, pitchTop, rot, elapsed, remain, order,
      progress: prog + '%',
      zoom: this.bars(160, id === 'A' ? 1.1 : 3.7, (i, h) => ({ h: h + '%', c: i < 80 ? dim : color })),
      overview: this.bars(100, id === 'A' ? 0.4 : 2.2, (i, h) => ({ h: h + '%', c: i < prog ? color : '#3A4350' })),
      pads: ['Inicio', 'Coro', 'Puente', 'Final', 'Cue 5', 'Cue 6', 'Cue 7', 'Cue 8'].map((l, i) => ({
        label: l, border: i < 4 ? color : '#33405A', bg: i < 4 ? dim : '#18202E', fg: i < 4 ? '#FFFFFF' : '#6B7584'
      })),
      playLabel: playing ? 'PAUSA' : 'PLAY',
      playBg: playing ? color : '#18202E',
      playFg: playing ? '#060810' : color,
      togglePlay: () => this.setState(id === 'A' ? { playA: !s.playA } : { playB: !s.playB })
    });
    const decks = [
      mk('A', '#FF8C00', '#8A3F00', s.playA, 62, 'PLATO A · AL AIRE', '[Nombre de la canción]', '[Artista]', '[BPM]', '[Tono]', '+0.0%', '48%', '128deg', '2:14', '−1:22', 0),
      mk('B', '#00E5FF', '#00606E', s.playB, 4, 'PLATO B · SIGUIENTE', '[Nombre de la canción]', '[Artista]', '[BPM]', '[Tono]', '−1.2%', '55%', '20deg', '0:09', '−3:39', 2)
    ];
    const grid = Array.from({ length: 12 }, (_, i) => ({ x: (i * 100 / 12 + 4) + '%', c: i % 4 === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)' }));
    const segColor = (i, n, lit) => !lit ? '#1A2028' : i >= n - 2 ? '#FF2D55' : i >= n - 5 ? '#FFE600' : '#1EFF6A';
    const vu = (level) => Array.from({ length: 18 }, (_, j) => { const i = 17 - j; return { c: segColor(i, 18, i < level) }; });
    const arc = (v) => (v * 70.7).toFixed(1) + ' 94.2';
    const channels = [
      { id: 'A', color: '#FF8C00', order: 0, midOrder: 1, fader: '18%', vu: vu(14), knobs: [['GANANCIA', 0.6], ['AGUDOS', 0.5], ['MEDIOS', 0.55], ['GRAVES', 0.7], ['FILTRO', 0.5]].map(([label, v]) => ({ label, dash: arc(v) })) },
      { id: 'B', color: '#00E5FF', order: 3, midOrder: 2, fader: '62%', vu: vu(5), knobs: [['GANANCIA', 0.55], ['AGUDOS', 0.5], ['MEDIOS', 0.5], ['GRAVES', 0.35], ['FILTRO', 0.5]].map(([label, v]) => ({ label, dash: arc(v) })) }
    ];
    const master = ['L', 'R'].map((ch, k) => ({ ch, segs: Array.from({ length: 28 }, (_, i) => ({ c: segColor(i, 28, i < 21 - k * 2) })) }));
    const fx = ['ECO', 'FILTRO', 'REVERB', 'FLANGER'].map((l) => {
      const on = !!s.fx[l];
      return { label: l, bg: on ? '#3A1F00' : '#18202E', border: on ? '#FF8C00' : '#33405A', fg: on ? '#FFB347' : '#AEB7C4', glow: on ? 'rgba(255,140,0,0.45)' : 'transparent',
        toggle: () => this.setState({ fx: { ...s.fx, [l]: !on } }) };
    });
    const sampler = ['Jingle Don Manuel', 'Bienvenida', 'Ofertas', 'Cortina 1', 'Cortina 2', 'Hora exacta', '[Cuña]', '[Cuña]'].map((l, i) => ({
      label: l, bg: i < 6 ? '#26103D' : '#11161C', border: i < 6 ? '#B14CFF' : '#33405A', glow: i < 6 ? 'rgba(177,76,255,0.35)' : 'transparent'
    }));
    const rules = [
      { k: 'Comercial cada', v: '3 canciones' },
      { k: 'Energía 7–10 a.m.', v: 'Tranquila' },
      { k: 'Energía 5–8 p.m.', v: 'Movida' },
      { k: 'No repetir artista en', v: '45 min' }
    ];
    const all = [
      { title: '[Canción 1]', artist: '[Artista]', type: 'CANCIÓN', bpm: '[BPM]', key: '[Tono]', en: 4, dur: '3:36', sede: 'Todas', state: 'Al aire' },
      { title: '[Canción 2]', artist: '[Artista]', type: 'CANCIÓN', bpm: '[BPM]', key: '[Tono]', en: 3, dur: '3:48', sede: 'Todas', state: 'En plato B' },
      { title: '[Canción 3]', artist: '[Artista]', type: 'CANCIÓN', bpm: '[BPM]', key: '[Tono]', en: 5, dur: '4:02', sede: 'Todas', state: 'Activa' },
      { title: '[Canción 4]', artist: '[Artista]', type: 'CANCIÓN', bpm: '[BPM]', key: '[Tono]', en: 2, dur: '3:15', sede: 'Todas', state: 'Inactiva' },
      { title: 'Ofertas de la semana', artist: 'Mercado Don Manuel', type: 'COMERCIAL', bpm: '—', key: '—', en: 0, dur: '0:30', sede: 'Todas', state: 'Activo' },
      { title: 'Precios Terminal', artist: 'Mercado Don Manuel', type: 'COMERCIAL', bpm: '—', key: '—', en: 0, dur: '0:20', sede: 'Terminal', state: 'Activo' },
      { title: '[Comercial 3]', artist: 'Mercado Don Manuel', type: 'COMERCIAL', bpm: '—', key: '—', en: 0, dur: '0:25', sede: 'Todas', state: 'Inactivo' }
    ];
    const filt = { todo: () => true, canciones: (r) => r.type === 'CANCIÓN', comerciales: (r) => r.type === 'COMERCIAL',
      activos: (r) => !r.state.startsWith('Inactiv'), inactivos: (r) => r.state.startsWith('Inactiv'), terminal: (r) => r.sede === 'Terminal' };
    const rows = all.filter(filt[s.tab]).map((r) => ({
      ...r,
      rowBg: r.state === 'Al aire' ? 'rgba(255,140,0,0.12)' : r.state === 'En plato B' ? 'rgba(0,229,255,0.10)' : 'transparent',
      typeBg: r.type === 'COMERCIAL' ? '#3A1F00' : '#00343D', typeFg: r.type === 'COMERCIAL' ? '#FFB347' : '#5CF2FF',
      stateFg: r.state === 'Al aire' ? '#FF8C00' : r.state === 'En plato B' ? '#00E5FF' : r.state.startsWith('Inactiv') ? '#6B7584' : '#3DFF7F',
      energy: Array.from({ length: 5 }, (_, i) => ({ c: i < r.en ? '#3DFF7F' : '#1F2630' }))
    }));
    const tabs = [['todo', 'Todo'], ['canciones', 'Canciones'], ['comerciales', 'Comerciales'], ['activos', 'Activos'], ['inactivos', 'Inactivos'], ['terminal', 'Sede Terminal']].map(([id, label]) => ({
      label, n: all.filter(filt[id]).length, bg: s.tab === id ? '#1E2630' : 'transparent', fg: s.tab === id ? '#FFFFFF' : '#AEB7C4',
      pick: () => this.setState({ tab: id })
    }));
    const queue = [
      { t: '11:24', title: '[Canción 2]', kind: 'CANCIÓN · PLATO B', c: '#00E5FF' },
      { t: '11:28', title: 'Ofertas de la semana', kind: 'COMERCIAL · TODAS', c: '#FF8C00' },
      { t: '11:28', title: 'Precios Terminal', kind: 'COMERCIAL · TERMINAL', c: '#FF8C00' },
      { t: '11:29', title: '[Canción 3]', kind: 'CANCIÓN', c: '#3A4350' },
      { t: '11:33', title: '[Canción 5]', kind: 'CANCIÓN', c: '#3A4350' },
      { t: '11:37', title: 'Jingle Don Manuel', kind: 'JINGLE', c: '#B14CFF' }
    ];
    return {
      decks, grid, channels, master, fx, sampler, rules, rows, tabs, queue,
      loops: ['1', '2', '4', '8', '16'],
      cross: s.cross,
      setCross: (e) => { this.state.cross = Number(e.target.value); },
      autoLabel: s.auto ? 'ENCENDIDO' : 'APAGADO',
      autoBg: s.auto ? '#003A18' : '#18202E',
      autoBorder: s.auto ? '#1EFF6A' : '#33405A',
      autoFg: s.auto ? '#9CFFBE' : '#AEB7C4',
      autoDot: s.auto ? '#1EFF6A' : '#4A5363',
      toggleAuto: () => this.setState({ auto: !s.auto })
    };
  }
  setState(patch) { Object.assign(this.state, patch); render(); }
}
const panel = new Panel({});
function get(path, scope) {
  path = path.trim();
  if (path === 'true') return true; if (path === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
}
const interp = (str, scope) => str.replace(/\{\{([^}]+)\}\}/g, (_, p) => { const v = get(p, scope); return v == null ? '' : v; });
function build(node, scope, out) {
  if (node.nodeType === 3) { out.appendChild(document.createTextNode(interp(node.textContent, scope))); return; }
  if (node.nodeType !== 1) return;
  const tag = node.tagName.toLowerCase();
  if (tag === 'sc-for' || node.hasAttribute('data-for')) {
    const isAttr = tag !== 'sc-for';
    const listExpr = isAttr ? node.getAttribute('data-for') : node.getAttribute('list').replace(/[{}\s]/g, '');
    const as = isAttr ? node.getAttribute('data-as') : node.getAttribute('as');
    const list = get(listExpr, scope) || [];
    list.forEach((item, i) => {
      const sc = Object.assign(Object.create(scope), { [as]: item, $index: i });
      if (isAttr) { const c = node.cloneNode(true); c.removeAttribute('data-for'); c.removeAttribute('data-as'); build(c, sc, out); }
      else node.childNodes.forEach((ch) => build(ch, sc, out));
    });
    return;
  }
  const el = node.namespaceURI === 'http://www.w3.org/2000/svg' ? document.createElementNS(node.namespaceURI, tag) : document.createElement(tag);
  for (const a of node.attributes) {
    const m = a.value.match(/^\{\{([^}]+)\}\}$/);
    if (/^on[A-Z]/.test(a.name) || /^on[a-z]+$/.test(a.name) && m) {
      const fn = m && get(m[1], scope); if (typeof fn === 'function') el.addEventListener(a.name.slice(2).toLowerCase(), fn);
      continue;
    }
    if (a.name === 'value' && tag === 'input') { el.value = interp(a.value, scope); el.setAttribute('value', interp(a.value, scope)); continue; }
    el.setAttribute(a.name, interp(a.value, scope));
  }
  node.childNodes.forEach((ch) => build(ch, scope, el));
  out.appendChild(el);
}
function render() {
  const vals = panel.renderVals();
  const frag = document.createDocumentFragment();
  document.getElementById('tpl').content.childNodes.forEach((n) => build(n, vals, frag));
  const app = document.getElementById('app'); app.replaceChildren(frag);
}
render();
