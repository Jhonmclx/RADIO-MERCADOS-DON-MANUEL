// Envoltorio de FFmpeg/FFprobe. Nunca se pasa contenido del usuario a una shell: se usa spawn con argumentos.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class FfmpegError extends Error {
  constructor(message, stderr) { super(message); this.stderr = stderr; }
}

export function runProcess(cmd, args, { timeoutMs = 0, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { reject(e); return; }
    onSpawn?.(child);
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    let timer;
    if (timeoutMs) timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new FfmpegError(`No se pudo ejecutar ${cmd}: ${e.message}`, err)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new FfmpegError(`${path.basename(cmd)} terminó con código ${code ?? signal}`, err));
    });
  });
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Lee propiedades del archivo. Lanza error si FFprobe no puede interpretarlo. */
export async function probe(cfg, file) {
  const { stdout } = await runProcess(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString('utf8'));
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const dur = Number(j.format?.duration || v?.duration || a?.duration || 0);
  return {
    formatName: j.format?.format_name || '',
    durationMs: Math.round(dur * 1000),
    sizeBytes: Number(j.format?.size || 0),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
}

function x264Args(cfg, { keyframeSeconds }) {
  const { fps, bitrateK, preset } = cfg.video;
  const gop = Math.round(fps * keyframeSeconds);
  return ['-c:v', 'libx264', '-preset', preset, '-profile:v', 'main', '-level:v', '3.1', '-pix_fmt', 'yuv420p',
    '-b:v', `${bitrateK}k`, '-maxrate', `${Math.round(bitrateK * 1.2)}k`, '-bufsize', `${bitrateK * 2}k`,
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${keyframeSeconds})`];
}

function audioArgs(cfg) {
  return ['-c:a', 'aac', '-b:a', `${cfg.video.audioBitrateK}k`, '-ar', '48000', '-ac', '2'];
}

function scaleFilter(w, h, fps) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
}

/**
 * Normaliza un comercial a un formato común (H.264 main + AAC 48 kHz, resolución y fps fijos,
 * fotogramas clave cada segmento HLS, volumen normalizado). Así todas las piezas de la señal comparten
 * parámetros y los televisores no tienen que reconfigurar decodificadores entre canciones y comerciales.
 */
export async function normalizeAd(cfg, input, output, { hasAudio }) {
  const { width, height, fps } = cfg.video;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  args.push('-vf', scaleFilter(width, height, fps));
  if (hasAudio) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000');
  args.push(...x264Args(cfg, { keyframeSeconds: cfg.hls.segmentSeconds }), ...audioArgs(cfg));
  if (!hasAudio) args.push('-shortest');
  args.push('-movflags', '+faststart', output);
  await runProcess(cfg.ffmpeg, args);
}

/** Versión liviana del comercial para el respaldo local de los televisores. */
export async function makeBackupVideo(cfg, input, output) {
  const h = cfg.video.backupHeight;
  const w = Math.round((h * 16) / 9 / 2) * 2;
  await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', scaleFilter(w, h, cfg.video.fps), '-c:v', 'libx264', '-preset', cfg.video.preset, '-profile:v', 'main', '-level:v', '3.0',
    '-b:v', `${cfg.video.backupBitrateK}k`, '-maxrate', `${cfg.video.backupBitrateK}k`, '-bufsize', `${cfg.video.backupBitrateK * 2}k`,
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output]);
}

export async function makeThumbnail(cfg, input, output, durationMs) {
  const at = Math.max(0, Math.min(durationMs / 1000 * 0.1, 5));
  await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', input,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output]);
}

/** Normaliza una canción a AAC 48 kHz estéreo con volumen uniforme (EBU R128). */
export async function normalizeSong(cfg, input, output) {
  await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-vn',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', ...audioArgs(cfg), '-movflags', '+faststart', output]);
}

function escapeDrawtext(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');
}

export function findFont(cfg) {
  const candidates = [cfg.fontFile,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].filter(Boolean);
  return candidates.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

/**
 * Genera una imagen de cortinilla (PNG) con la identidad de la radio.
 * Si FFmpeg no tiene drawtext o no hay fuente, genera la imagen sin texto (nunca falla en silencio: se registra).
 */
export async function makeSlateImage(cfg, output, { title, subtitle }) {
  const { width: w, height: h } = cfg.video;
  const font = findFont(cfg);
  const base = `color=c=0x0E5A32:s=${w}x${h}:d=1`;
  const filters = [
    `drawbox=x=0:y=${Math.round(h * 0.82)}:w=${w}:h=${Math.round(h * 0.18)}:color=0xF4B41A@1:t=fill`,
    `drawbox=x=${Math.round(w * 0.08)}:y=${Math.round(h * 0.2)}:w=${Math.round(w * 0.012)}:h=${Math.round(h * 0.42)}:color=0xF4B41A@1:t=fill`,
  ];
  if (font) {
    const ff = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(`drawtext=fontfile='${ff}':text='${escapeDrawtext('RADIO MERCADO')}':fontcolor=0xFFF8E7:fontsize=${Math.round(h * 0.1)}:x=${Math.round(w * 0.12)}:y=${Math.round(h * 0.22)}`);
    filters.push(`drawtext=fontfile='${ff}':text='${escapeDrawtext('DON MANUEL')}':fontcolor=0xF4B41A:fontsize=${Math.round(h * 0.1)}:x=${Math.round(w * 0.12)}:y=${Math.round(h * 0.34)}`);
    if (title) filters.push(`drawtext=fontfile='${ff}':text='${escapeDrawtext(title)}':fontcolor=0xFFF8E7:fontsize=${Math.round(h * 0.05)}:x=${Math.round(w * 0.12)}:y=${Math.round(h * 0.52)}`);
    if (subtitle) filters.push(`drawtext=fontfile='${ff}':text='${escapeDrawtext(subtitle)}':fontcolor=0x0E5A32:fontsize=${Math.round(h * 0.045)}:x=(w-text_w)/2:y=${Math.round(h * 0.885)}`);
  }
  try {
    await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', base, '-vf', filters.join(','), '-frames:v', '1', output]);
    return { withText: !!font };
  } catch (e) {
    await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', base, '-vf', filters.slice(0, 2).join(','), '-frames:v', '1', output]);
    return { withText: false, error: e.message };
  }
}

/** Codifica una cortinilla de `seconds` segundos (imagen fija + silencio) en el formato común de la señal. */
export async function makeSlateVideo(cfg, image, output, seconds) {
  const { fps } = cfg.video;
  await runProcess(cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-framerate', String(fps), '-i', image,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', String(seconds),
    '-vf', scaleFilter(cfg.video.width, cfg.video.height, fps),
    ...x264Args(cfg, { keyframeSeconds: cfg.hls.segmentSeconds }), ...audioArgs(cfg),
    '-movflags', '+faststart', output]);
}
