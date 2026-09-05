import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCitingSummaries, decodeEjusticeHtml } from '../src/find_missing_eli.js';

function latin1Bytes(value) {
  const buffer = Buffer.from(value, 'latin1');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('decodes eJustice ISO-8859-1 titles without replacing accented characters', () => {
  const html = decodeEjusticeHtml(latin1Bytes(
    '<meta charset="iso-8859-1"><title>Arrêté royal relatif à l energie</title>'
  ));

  assert.match(html, /Arrêté royal relatif à l energie/);
  assert.doesNotMatch(html, /�|\?/);
});

test('collects distinct citing summaries with their judgment context', () => {
  const summaries = collectCitingSummaries([
    {
      ecli: 'ECLI:BE:CASS:2026:ARR.1',
      article: '12',
      roleNumber: 'C.25.0065.N',
      abstractFR: ['Résumé français', 'Résumé français'],
      abstractNL: 'Nederlandse samenvatting',
    },
  ]);

  assert.deepEqual(summaries, [
    {
      ecli: 'ECLI:BE:CASS:2026:ARR.1',
      article: '12',
      roleNumber: 'C.25.0065.N',
      language: 'FR',
      text: 'Résumé français',
    },
    {
      ecli: 'ECLI:BE:CASS:2026:ARR.1',
      article: '12',
      roleNumber: 'C.25.0065.N',
      language: 'NL',
      text: 'Nederlandse samenvatting',
    },
  ]);
});
