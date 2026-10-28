// Planificador PURO de la programación (sin E/S): decide qué sigue al aire.
// Al ser determinista y sin efectos secundarios, se puede probar exhaustivamente y re-planificar
// restaurando el estado anterior cuando el administrador cambia algo antes de que empiece un elemento.

export function initialSchedulerState() {
  return {
    songsSinceAd: 0,     // canciones emitidas desde el último bloque comercial
    adsInBlock: 0,       // comerciales ya emitidos dentro del bloque actual
    lastSongId: null,    // última canción decidida (el ciclo musical continúa desde aquí)
    shuffleRound: 0,
    playedInRound: [],
    wrr: {},             // pesos actuales del reparto ponderado (smooth weighted round-robin)
    lastAiredAdId: null, // comercial que vuelve al ciclo silencioso tras emitirse
    loopPos: {},         // posición (ms) del ciclo silencioso de cada comercial
  };
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

/** Barajado determinista (mulberry32) para el modo aleatorio de música. */
function seededShuffle(ids, seed) {
  let a = seed >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const arr = ids.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/**
 * Selección ponderada suave (algoritmo usado por nginx): determinista, respeta la frecuencia
 * configurada (peso) y evita que un comercial monopolice el ciclo: con pesos 3 y 1 la secuencia
 * es A A B A..., nunca A A A A seguidos de B.
 * Empates: gana el de menor posición en la lista ordenada por el administrador.
 */
export function pickAd(state, ads, { mutate = true } = {}) {
  if (!ads.length) return null;
  const wrr = mutate ? state.wrr : { ...state.wrr };
  const ids = new Set(ads.map((a) => String(a.id)));
  for (const k of Object.keys(wrr)) if (!ids.has(k)) delete wrr[k];
  let total = 0; let best = null;
  for (const ad of ads) {
    const w = Math.max(1, Math.floor(ad.weight || 1));
    total += w;
    wrr[ad.id] = (wrr[ad.id] || 0) + w;
    if (best === null || wrr[ad.id] > wrr[best.id]) best = ad;
  }
  wrr[best.id] -= total;
  if (mutate) state.wrr = wrr;
  return best;
}

function nextSong(state, songs, shuffle) {
  if (!songs.length) return null;
  if (!shuffle) {
    const idx = songs.findIndex((s) => s.id === state.lastSongId);
    return songs[(idx + 1) % songs.length];
  }
  const ids = songs.map((s) => s.id);
  let played = new Set(state.playedInRound.filter((id) => ids.includes(id)));
  if (played.size >= ids.length) { state.shuffleRound += 1; played = new Set(); }
  const order = seededShuffle(ids, 0x9E3779B1 ^ state.shuffleRound);
  // Evita repetir la misma canción justo al cambiar de ronda.
  let pick = order.find((id) => !played.has(id) && id !== state.lastSongId) ?? order.find((id) => !played.has(id));
  played.add(pick);
  state.playedInRound = [...played];
  return songs.find((s) => s.id === pick);
}

/**
 * Decide el siguiente elemento de la señal central.
 * @param {object} state  estado del planificador (se devuelve una copia modificada)
 * @param {object} ctx    { settings, ads (elegibles, ordenados), songs (elegibles, ordenadas), inHours, stopped }
 * @returns {{ item: object, state: object }}
 */
export function decideNext(stateIn, ctx) {
  const state = clone(stateIn);
  const s = ctx.settings;
  if (!ctx.inHours) return { item: { kind: 'slate', slate: 'fuera_horario' }, state };
  const musicPaused = !!s.music_paused;
  const adsPaused = !!s.ads_paused;
  if (musicPaused && adsPaused) return { item: { kind: 'slate', slate: 'pausa' }, state };

  const n = Math.max(1, Math.floor(Number(s.songs_between_ads) || 1));
  const perBlock = Math.max(1, Math.floor(Number(s.ads_per_block) || 1));
  const songsAvailable = !musicPaused && ctx.songs.length > 0;
  const adsAvailable = !adsPaused && ctx.ads.length > 0;

  const blockInProgress = state.adsInBlock > 0;
  const adDue = adsAvailable && (blockInProgress || state.songsSinceAd >= n || !songsAvailable);
  if (adDue) {
    const ad = pickAd(state, ctx.ads);
    state.adsInBlock += 1;
    if (state.adsInBlock >= perBlock) { state.adsInBlock = 0; state.songsSinceAd = 0; }
    state.lastAiredAdId = ad.id;
    state.loopPos[ad.id] = 0; // al terminar de emitirse, su ciclo silencioso vuelve a empezar desde el inicio
    return { item: { kind: 'ad', adId: ad.id, durationMs: ad.duration_ms }, state };
  }
  if (!songsAvailable) {
    return { item: { kind: 'slate', slate: musicPaused ? 'pausa' : 'sin_contenido' }, state };
  }
  // Si el bloque quedó a medias porque ya no hay comerciales elegibles, se cierra limpiamente.
  if (state.adsInBlock > 0) { state.adsInBlock = 0; state.songsSinceAd = 0; }

  const song = nextSong(state, ctx.songs, !!s.music_shuffle);
  state.lastSongId = song.id;
  state.songsSinceAd += 1;

  // Video del ciclo silencioso: el último comercial emitido si sigue vigente; si no, el próximo en turno.
  let loopAd = ctx.ads.find((a) => a.id === state.lastAiredAdId);
  if (!loopAd && ctx.ads.length) loopAd = pickAd(state, ctx.ads, { mutate: false });
  let loopOffsetMs = 0;
  if (loopAd && loopAd.duration_ms > 0) {
    loopOffsetMs = (state.loopPos[loopAd.id] || 0) % loopAd.duration_ms;
    state.loopPos[loopAd.id] = (loopOffsetMs + (song.duration_ms || 0)) % loopAd.duration_ms;
  }
  return {
    item: { kind: 'song', songId: song.id, durationMs: song.duration_ms, loopAdId: loopAd ? loopAd.id : null, loopOffsetMs },
    state,
  };
}
