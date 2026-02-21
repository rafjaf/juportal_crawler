import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { logInfo, logWarn, timestamp } from './logger.js';
import { fetchWithRetry } from './fetch.js';
import {
  normalizeWhitespace,
  normalizeEliToFrench,
  normalizeCgiUrl,
  parseArticleNumbers,
  extractLegalBasisKey,
} from './utils.js';

/**
 * Labels used for legal bases in different languages.
 */
const LEGAL_BASES_LABELS = ['Bases légales:', 'Wettelijke bepalingen:'];

/**
 * Fetch and parse a judgement page to determine which abstract goes with which legal basis.
 * Returns an array of { abstract, legalBases: [{article, eli}] }
 */
export async function parseJudgementPage(judgementUrl) {
  logInfo(`${timestamp()} Downloading judgement page: ${judgementUrl}`);
  const html = await fetchWithRetry(judgementUrl);
  const $ = cheerio.load(html);

  const fiches = [];

  // Each fieldset with "Fiche(s) N" legend groups an abstract with its legal bases
  $('fieldset').each((_, fieldset) => {
    const $fieldset = $(fieldset);
    const legend = $fieldset.find('legend').first().text().trim();
    
    // Check if this is a "Fiche" or "Fiches" fieldset
    if (!legend.startsWith('Fiche')) return;

    // Extract abstract text from the div inside the fieldset  
    const abstractDiv = $fieldset.children('div').first();
    const abstractText = normalizeWhitespace(abstractDiv.text());
    if (!abstractText) return;

    // Extract legal bases from "Bases légales:" / "Wettelijke bepalingen:" rows
    const basesLegales = [];
    const missingEliBases = [];
    $fieldset.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const $labelTd = $tr.find('td').first();
      const label = $labelTd.find('p').text().trim();
      
      // Check if this row contains legal bases (FR or NL label)
      if (!LEGAL_BASES_LABELS.includes(label)) return;

      const $descTd = $labelTd.next('td');
      if (!$descTd.length) return;

      // Find all ELI links and their associated text
      const descHtml = $descTd.find('p.description-notice-table').html();
      if (!descHtml) return;

      // Split by <br> to get individual legal basis entries
      const entries = descHtml.split(/<br\s*\/?>/i);
      for (const entry of entries) {
        const $entry = cheerio.load(entry);
        const text = normalizeWhitespace($entry.root().text());

        // Prefer a proper ELI link; fall back to cgi_loi / cgi_wet link
        let eliLink = normalizeEliToFrench($entry('a[href*="/eli/"]').attr('href'));
        if (!eliLink) {
          const cgiHref = $entry('a[href*="cgi_loi"], a[href*="cgi_wet"]').attr('href');
          if (cgiHref) eliLink = normalizeCgiUrl(cgiHref);
        }

        // Extract article number from the text.
        // Use a date-anchored pattern to skip any "Art." that appears inside
        // the law title (e.g. "Boek II (Art. 137 tot en met 216septies)") and
        // only capture the article that follows the date separator.
        // Also handle the unusual case where the trailing "- NN" counter is absent.
        const artGroupMatch =
          text.match(/\d{2}-\d{2}-\d{4}\s*-\s*Art\.\s*(.+?)\s*-\s*\d+\w*\s*$/) ||
          text.match(/\d{2}-\d{2}-\d{4}\s*-\s*Art\.\s*(.+?)\s*$/);
        if (artGroupMatch) {
          const articles = parseArticleNumbers(artGroupMatch[1].trim());
          const lawKey = extractLegalBasisKey(text);
          logInfo(chalk.gray(`${timestamp()}       Legal basis parsed | raw="${text}" | articles=[${articles.join(', ')}] | eli=${eliLink || 'MISSING'}`));

          if (!eliLink) {
            for (const art of articles) {
              missingEliBases.push({
                article: art,
                rawLegalBasisText: lawKey,
              });
            }
            continue;
          }

          for (const art of articles) {
            basesLegales.push({ article: art, eli: eliLink });
          }
        } else if (text) {
          // Detect general legal principles: no date, no Art., no ELI
          if (/^(Principe général du droit|Algemeen rechtsbeginsel)\b/i.test(text)) {
            logInfo(chalk.gray(`${timestamp()}       Legal principle | raw="${text}" | no ELI`));
            missingEliBases.push({ article: null, rawLegalBasisText: text });
          } else {
            logWarn(`⚠ Could not extract article from legal basis text: "${text}"`);
          }
        }
      }
    });

    fiches.push({
      abstract: abstractText,
      legalBases: basesLegales,
      missingEliBases,
    });
  });

  return fiches;
}
