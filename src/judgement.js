import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { logInfo, logWarn, timestamp } from './logger.js';
import { fetchWithRetry } from './fetch.js';
import { RE_ART_REF_WITH_COUNTER, RE_ART_REF_NO_COUNTER, RE_ART_REF_NO_DATE, RE_REF_NO_ART, RE_LEGAL_PRINCIPLE } from './constants.js';
import {
  normalizeWhitespace,
  normalizeEliToFrench,
  normalizeCgiUrl,
  parseArticleNumbers,
  extractLegalBasisKey,
  extractDateFromBasisText,
  buildBasisTextLookup,
} from './utils.js';

/**
 * Labels used for legal bases in different languages.
 */
const LEGAL_BASES_LABELS = ['Bases légales:', 'Wettelijke bepalingen:'];

/**
 * Download the raw HTML for a judgement page.
 * Separated from parsing so callers can pre-fetch concurrently while other
 * work is still in progress.
 */
export async function fetchJudgementHtml(judgementUrl) {
  logInfo(`${timestamp()} Downloading judgement page: ${judgementUrl}`);
  return await fetchWithRetry(judgementUrl);
}

/**
 * Parse a previously downloaded judgement HTML string and return an array of
 * fiches: { abstract, legalBases: [{article, eli}], missingEliBases }.
 */
export function parseJudgementHtml(html) {
  const $ = cheerio.load(html);

  const fiches = [];
  const unextractable = [];

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
    const allBasisTexts = []; // { article, rawText, lang } — for FR/NL correlation
    $fieldset.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const $labelTd = $tr.find('td').first();
      const label = $labelTd.find('p').text().trim();
      
      // Check if this row contains legal bases (FR or NL label)
      if (!LEGAL_BASES_LABELS.includes(label)) return;
      const basisLang = label === 'Bases légales:' ? 'fr' : 'nl';

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
        // Also handle the unusual case where the trailing "- NN" counter is absent,
        // and references that have no date at all.
        const artGroupMatch =
          text.match(RE_ART_REF_WITH_COUNTER) ||
          text.match(RE_ART_REF_NO_COUNTER) ||
          text.match(RE_ART_REF_NO_DATE);
        if (artGroupMatch) {
          const articles = parseArticleNumbers(artGroupMatch[1].trim(), text);
          const lawKey = extractLegalBasisKey(text);
          logInfo(chalk.gray(`${timestamp()}       Legal basis parsed | raw="${text}" | articles=[${articles.join(', ')}] | eli=${eliLink || 'MISSING'}`));

          if (!eliLink) {
            for (const art of articles) {
              missingEliBases.push({
                article: art,
                rawLegalBasisText: lawKey,
              });
              allBasisTexts.push({ article: art, rawText: text, lang: basisLang });
            }
            continue;
          }

          for (const art of articles) {
            basesLegales.push({ article: art, eli: eliLink });
            allBasisTexts.push({ article: art, rawText: text, lang: basisLang });
          }
        } else if (text) {
          // Detect general legal principles: no date, no Art., no ELI
          if (RE_LEGAL_PRINCIPLE.test(text)) {
            logInfo(chalk.gray(`${timestamp()}       Legal principle | raw="${text}" | no ELI`));
            missingEliBases.push({ article: null, rawLegalBasisText: text });
          } else if (RE_REF_NO_ART.test(text)) {
            // Law reference with a date but no specific article → use "general"
            const lawKey = extractLegalBasisKey(text);
            logInfo(chalk.gray(`${timestamp()}       No-article law ref | raw="${text}" | article=general | eli=${eliLink || 'MISSING'}`));
            if (eliLink) {
              basesLegales.push({ article: 'general', eli: eliLink });
            } else {
              missingEliBases.push({ article: 'general', rawLegalBasisText: lawKey });
            }
            allBasisTexts.push({ article: 'general', rawText: text, lang: basisLang });
          } else {
            logWarn(`⚠ Could not extract article from legal basis text: "${text}"`);
            unextractable.push(text);
          }
        }
      }
    });

    // Enrich legal bases with FR/NL raw texts
    const basisTextLookup = buildBasisTextLookup(allBasisTexts);
    for (const b of basesLegales) {
      const date = extractDateFromBasisText(
        (allBasisTexts.find(t => t.article === b.article) || {}).rawText || ''
      ) || 'no-date';
      const texts = basisTextLookup[`${b.article}|${date}`] || {};
      b.legalBasisFR = texts.fr || null;
      b.legalBasisNL = texts.nl || null;
    }
    for (const m of missingEliBases) {
      const date = extractDateFromBasisText(m.rawLegalBasisText || '') || 'no-date';
      const texts = basisTextLookup[`${m.article}|${date}`] || {};
      m.legalBasisFR = texts.fr || null;
      m.legalBasisNL = texts.nl || null;
    }

    fiches.push({
      abstract: abstractText,
      legalBases: basesLegales,
      missingEliBases,
    });
  });

  return { fiches, unextractable };
}
/**
 * Convenience wrapper: fetch + parse in one call.
 * Used by targeted (single-URL) runs that don't need pre-fetching.
 */
export async function parseJudgementPage(judgementUrl) {
  const html = await fetchJudgementHtml(judgementUrl);
  return parseJudgementHtml(html); // returns { fiches, unextractable }
}