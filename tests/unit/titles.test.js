import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSongTitle } from '../../src/media/library.js';

test('nombres de canciones limpios', () => {
  assert.equal(cleanSongTitle('.trashed-1796139548-Rechazame - Prince Royce (Lyrics)(MP3 160K)'), 'Rechazame - Prince Royce');
  assert.equal(cleanSongTitle('Aventura - Inmortal (Official Video)(MP3 160K)'), 'Aventura - Inmortal');
  assert.equal(cleanSongTitle('Esa mujer tony vega con letra(MP3 160K)'), 'Esa mujer tony vega con letra');
  assert.equal(cleanSongTitle('Canción normal'), 'Canción normal');
  assert.equal(cleanSongTitle('(MP3 160K)'), '(MP3 160K)', 'si quedaría vacío, se conserva');
});
