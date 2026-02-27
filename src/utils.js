import { ELI_TYPE_NL_TO_FR } from './constants.js';

/**
 * Normalize whitespace in text: collapse multiple spaces/newlines into single space.
 */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a Belgian ELI URL to always use French document type terminology.
 * e.g. https://.../eli/wet/... → https://.../eli/loi/...
 */
export function normalizeEliToFrench(eli) {
  if (!eli) return eli;
  return eli.replace(/\/eli\/([^/]+)\//, (match, type) => {
    const frType = ELI_TYPE_NL_TO_FR[type] || type;
    return `/eli/${frType}/`;
  });
}

/**
 * Normalize a cgi law URL: convert Dutch cgi_wet form to French cgi_loi form.
 * cgi_loi URLs are kept as-is (they are treated as valid identifiers).
 * Returns null if the URL is not a recognizable cgi_loi / cgi_wet URL.
 */
export function normalizeCgiUrl(url) {
  try {
    const parsed = new URL(url);
    // Only handle ejustice cgi paths
    if (!parsed.pathname.includes('cgi_loi') && !parsed.pathname.includes('cgi_wet')) return null;

    if (parsed.pathname.includes('cgi_wet')) {
      // Convert cgi_wet → cgi_loi
      parsed.pathname = parsed.pathname.replace('cgi_wet', 'cgi_loi');
      // Switch language params to French
      if (parsed.searchParams.get('language') === 'nl') parsed.searchParams.set('language', 'fr');
      if (parsed.searchParams.get('la') === 'N') parsed.searchParams.set('la', 'F');
      // Normalize Dutch table_name to French equivalent
      const tableName = parsed.searchParams.get('table_name');
      if (tableName && ELI_TYPE_NL_TO_FR[tableName]) {
        parsed.searchParams.set('table_name', ELI_TYPE_NL_TO_FR[tableName]);
      }
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Detect whether a raw legal-basis text refers to an international instrument
 * (convention, protocol, EU directive/regulation, treaty…) rather than a
 * purely national law.
 *
 * In international instruments the article decimal notation "6.3" means
 * article 6, paragraph 3, whereas in national codes it denotes a genuine
 * hierarchical article number.
 *
 * Exclusions: "Convention collective" and "Convention de travail" are domestic
 * labour-law instruments, not international treaties.
 */
export function isInternationalInstrument(text) {
  if (!text) return false;
  // Negative look-ahead prevents matching domestic collective-agreement labels
  return /\b(?:Convention(?!\s+(?:collectiv|de\s+travail))|Protocole|Protocol(?:\s+(?:bij|nr|to)\b)?|Directive\s+\d{4}[\/\\]|Richtlijn\s+\d{4}[\/\\]|Règlement\s+\((?:CE|UE|CEE|Euratom)\)|Verordening\s+\((?:EG|EU|EEG)\)|Traité\b|Verdrag\b|Charte\s+(?:sociale|des\s+droits|of\s+Fundamental)|Accord\s+(?:international|européen|européenne|de\s+coopération|du\s+Conseil\s+de\s+l'Europe|relatif\s+au\s+transport))/i.test(text);
}

/**
 * Parse article numbers from a string like "23/1" or "2, § 1er".
 * @param {string} raw               - The articles portion captured by the regex.
 * @param {string} rawLegalBasisText - The full raw legal-basis line (used for
 *                                     international-instrument detection).
 * Returns an array of article strings.
 */
export function parseArticleNumbers(raw, rawLegalBasisText = '') {
  const text = normalizeWhitespace(raw || '');
  if (!text) return [];

  const intl = isInternationalInstrument(rawLegalBasisText);

  // Split multi-article references like "26 et 31" / "26 en 31" / "17, 27 en 37".
  // Both branches now require 2+ digits on the right-hand side so that
  // sub-item qualifiers such as "al. 1er et 2" or "1°, 4°, 5° et 12°" are not
  // mistaken for separate article numbers.
  const chunks = text
    .split(/(?:,\s*(?=[0-9]{2,})|\s+(?:et|en)\s+(?=[0-9]{2,}))/i)
    .map(chunk => normalizeArticleNumber(chunk, intl))
    .filter(Boolean);

  // Keep unique values in original order
  const unique = [...new Set(chunks)];

  // Articles in a legal basis are typically listed in ascending order.
  // Filter out any purely-numeric article that is smaller than the last
  // accepted numeric article — such entries are sub-paragraph qualifiers
  // (§, al., lid) that were not caught earlier.
  let lastNumeric = 0;
  return unique.filter(art => {
    const n = parseInt(art, 10);
    if (!isNaN(n) && String(n) === art) {
      // Purely numeric article
      if (n < lastNumeric) return false;
      lastNumeric = n;
    }
    return true;
  });
}

/**
 * Normalize an article reference to its base number only.
 * Strips sub-paragraph qualifiers (§ N, alinéa, lid, etc.) but preserves the
 * full article identifier, including special forms used in Belgian codes:
 *
 *   Pattern A – Letter-prefixed   : "L 1124-17" → "L1124-17"  (Code démocratie locale)
 *   Pattern B – Roman-numeral.N   : "XX.194"                   (Code de droit économique)
 *   Pattern C – Colon-separated   : "3:1"                      (Code des sociétés)
 *   Pattern D – Standard numeric  : "14", "235bis", "23/1"
 *   Pattern E – Dotted numeric:
 *     National (isInternational=false) : N.M and N.M.P… are genuine article
 *       numbers and kept as-is: "8.4"→"8.4", "6.33"→"6.33", "5.4.3.4"→"5.4.3.4"
 *     International (isInternational=true) : exactly two segments N.M are
 *       stripped to N (M is a paragraph/sub-article qualifier, e.g. ECHR
 *       "6.3" = article 6 § 3). Three or more segments are always kept.
 *
 * @param {string}  art             - The raw chunk to normalise.
 * @param {boolean} isInternational - Whether the source law is an international
 *                                    instrument (affects dotted-form handling).
 * Returns an empty string for non-article fragments (e.g. "zesde lid") so
 * callers can filter them out.
 */
export function normalizeArticleNumber(art, isInternational = false) {
  // Reject sub-paragraph qualifiers: § N, al. N, alinéa N, lid N
  // These denote paragraphs/alineas, not article numbers.
  const trimmed = (art || '').trim();
  if (/^(?:§|al\.|alin[ée]a|lid)\s/i.test(trimmed)) return '';

  // Strip sub-paragraph qualifiers after a comma ("14, § 7" → "14")
  // Also strip French/Dutch ordinal suffixes: "1er" → "1", "2ème" → "2",
  // "3e" → "3", "1ière" → "1". The suffix must immediately follow digits
  // and be at a word boundary so that "bis", "ter" etc. are not affected.
  const text = art
    .replace(/,.*$/, '')
    .replace(/^([0-9]+)(?:ère?|ième|ème|ste|de|nd|er)\b/i, '$1')
    .trim();
  if (!text) return '';

  // Reject Belgian sub-item markers: a plain number followed immediately by °
  // (e.g. "1°", "12°"). These denote sub-items of an article, not article numbers.
  if (/^[0-9]+°\s*$/.test(text)) return ''

  // Pattern A: letter-prefix followed (with optional space) by digits
  // e.g. "L 1124-17", "L1124-17", "R 123-4"
  // The letter(s) must be directly followed (opt. space) by digits — this
  // excludes Roman-numeral.decimal forms which have a dot before the digits.
  const letterPrefixMatch = text.match(/^([A-Z]+\s*[0-9]+(?:[/.-][0-9]+)*(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)?)\b/i);
  if (letterPrefixMatch) {
    // Collapse internal spaces: "L 1124-17" → "L1124-17"
    return letterPrefixMatch[1].replace(/\s+/g, '');
  }

  // Pattern B: Roman-numeral chapter dot article number
  // e.g. "XX.194", "IV.27bis"  (Code de droit économique)
  const romanDotMatch = text.match(/^([IVXLCDM]+\.[0-9]+(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)?)\b/i);
  if (romanDotMatch) {
    return romanDotMatch[1];
  }

  // Pattern E: Dotted numeric article numbers.
  //
  // Any sequence of dot-separated digit groups (e.g. "8.4", "6.33", "5.4.3.4")
  // is matched here.
  //   3+ segments → always kept regardless of context (e.g. "5.4.3.4" in ADR).
  //   2 segments  → kept as-is for national law ("8.4"→"8.4", "6.33"→"6.33");
  //                 stripped to base integer for international instruments
  //                 ("6.3"→"6" since M is a paragraph qualifier).
  const dotMatch = text.match(/^(\d+(?:\.\d+)+)(?:[^0-9.]|$)/);
  if (dotMatch) {
    const full = dotMatch[1];
    const segments = full.split('.');
    if (segments.length >= 3 || !isInternational) {
      return full;   // always keep 3+; keep N.M for national
    }
    // International + exactly 2 segments: strip the paragraph qualifier
    return segments[0];
  }

  // Pattern C/D: standard numeric, colon-separated ("3:1"), slash-separated ("23/1"),
  // or hyphen-separated ("577-2", "577-7") as used in the Belgian Civil Code.
  const match = text.match(/^([0-9]+(?:[-:/][0-9]+)?(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)?)\b/i);
  return match ? match[1] : '';
}

/**
 * Extract a "Law Name - DD-MM-YYYY" key from a full reference text.
 * Used as the grouping key in missing_eli.json so that all articles of
 * the same law are collected under one entry.
 * e.g. "Gerechtelijk Wetboek - 10-10-1967 - Art. 1068, tweede lid - 30"
 *   → "Gerechtelijk Wetboek - 10-10-1967"
 */
export function extractLegalBasisKey(text) {
  if (!text) return text;
  const match = text.match(/^(.*?-\s*\d{2}-\d{2}-\d{4})/);
  return match ? match[1].trim() : text;
}

/**
 * Converts an ELI or cgi_loi URL to a safe filename.
 * e.g. https://www.ejustice.just.fgov.be/eli/loi/1984/06/28/1984900065/justel
 *   → eli_loi_1984_06_28_1984900065_justel.json
 * e.g. https://www.ejustice.just.fgov.be/cgi_loi/change_lg.pl?table_name=loi&cn=1966121931
 *   → cgi_loi_loi_1966121931.json
 */
export function eliToFilename(eli) {
  try {
    const url = new URL(eli);
    if (url.pathname.includes('cgi_loi')) {
      // Use table_name + cn to create a unique filename
      const tableName = url.searchParams.get('table_name') || 'loi';
      const cn = url.searchParams.get('cn') || 'unknown';
      return `cgi_loi_${tableName}_${cn}.json`;
    }
    // ELI URL: take the path, remove leading slash, replace / with _
    const safeName = url.pathname.replace(/^\//, '').replace(/\//g, '_');
    return `${safeName}.json`;
  } catch {
    // Fallback for non-URL ELIs
    return eli.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
  }
}

/**
 * Simple text similarity based on shared words ratio.
 * Returns a value between 0 (no match) and 1 (perfect match).
 */
export function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  return (2 * shared) / (wordsA.size + wordsB.size);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract a DD-MM-YYYY date from a legal-basis reference text.
 * Returns the first date found, or null if none.
 */
export function extractDateFromBasisText(text) {
  const m = (text || '').match(/(\d{2}-\d{2}-\d{4})/);
  return m ? m[1] : null;
}

/**
 * Build a lookup from `${article}|${date}` to `{ fr: rawText, nl: rawText }`
 * so that FR and NL raw texts for the same legal basis can be correlated.
 *
 * @param {Array<{article: string, rawText: string, lang: string}>} entries
 * @returns {Object<string, {fr?: string, nl?: string}>}
 */
export function buildBasisTextLookup(entries) {
  const lookup = {};
  for (const { article, rawText, lang } of entries) {
    const date = extractDateFromBasisText(rawText) || 'no-date';
    const key = `${article}|${date}`;
    if (!lookup[key]) lookup[key] = {};
    lookup[key][lang || 'fr'] = rawText;
  }
  return lookup;
}
