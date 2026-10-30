// Un comercial que ya viene en el formato de emisión se copia sin recodificar (rápido en el servidor gratis).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildConfig } from '../../src/config.js';
import { videoAlreadyNormalized, normalizeAd } from '../../src/media/ffmpeg.js';

test('comercial ya normalizado: se copia el video; uno distinto se recodifica', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const cfg = buildConfig({ VIDEO_WIDTH: '640', VIDEO_HEIGHT: '360', VIDEO_BITRATE_KBPS: '800', DATA_DIR: dir });
  const seg = cfg.hls.segmentSeconds; const g = 30 * seg;
  const ok = path.join(dir, 'ok.mp4'); const bad = path.join(dir, 'bad.mp4');
  const base = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', String(seg * 3)];
  execFileSync('ffmpeg', [...base, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '600k', '-g', String(g), '-keyint_min', String(g), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-c:a', 'aac', ok]);
  execFileSync('ffmpeg', [...base, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '600k', '-g', '250', '-c:a', 'aac', bad]);
  assert.equal(await videoAlreadyNormalized(cfg, ok), true);
  assert.equal(await videoAlreadyNormalized(cfg, bad), false, 'cuadros clave desalineados');
  const out = path.join(dir, 'out.mp4');
  const r = await normalizeAd(cfg, ok, out, { hasAudio: true });
  assert.equal(r?.copied, true);
  assert.equal(await videoAlreadyNormalized(cfg, out), true, 'la salida conserva el formato');
  const r2 = await normalizeAd(cfg, bad, path.join(dir, 'out2.mp4'), { hasAudio: true });
  assert.notEqual(r2?.copied, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
