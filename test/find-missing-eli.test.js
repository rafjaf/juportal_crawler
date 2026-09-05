import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectCitingSummaries,
  decodeEjusticeHtml,
  extractSummaryKeywords,
  parseEjusticeResultPage,
} from '../src/find_missing_eli.js';

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

test('reads the last eJustice result page so same-day result sets can be fully fetched', () => {
  const page = parseEjusticeResultPage(`
    <a class="pagination-last" href="list.pl?language=fr&dt=ARRETE+ROYAL&page=3">last</a>
    <div class="list-item--content">
      <a class="list-item--title" href="article.pl?numac_search=2026001234">Arrêté royal relatif à la mobilité</a>
      <p class="list-item--date">2026-01-15</p>
    </div>
  `);

  assert.equal(page.lastPage, 3);
  assert.equal(new URL(page.pageUrl).searchParams.get('page'), '3');
  assert.deepEqual(page.results, [{
    numac: '2026001234',
    title: 'Arrêté royal relatif à la mobilité',
    pubDate: '2026-01-15',
  }]);
});

test('derives focused search terms from the citing summary without legal boilerplate', () => {
  const keywords = extractSummaryKeywords([{
    abstractFR: 'Le tribunal applique les articles au secteur des télécommunications.',
  }], 'FR');

  assert.match(keywords, /telecommunications/);
  assert.doesNotMatch(keywords, /tribunal|articles/);
});
