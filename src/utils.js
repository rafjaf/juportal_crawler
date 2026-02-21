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
 * Parse article numbers from a string like "23/1" or "2, § 1er".
 * Returns an array of article strings.
 */
export function parseArticleNumbers(raw) {
  const text = normalizeWhitespace(raw || '');
  if (!text) return [];

  // Split multi-article references like "26 et 31" / "26 en 31" / "17, 27 en 37".
  // The lookahead (?=[0-9]) on the et/en branch ensures we only split when the
  // second part starts with a digit, preventing "eerste en zesde lid" splits.
  // The comma branch only splits before 2+ digits to avoid mistaking sub-item
  // markers like "42, 3°" for article-number separators.
  const chunks = text
    .split(/(?:,\s*(?=[0-9]{2,})|\s+(?:et|en)\s+(?=[0-9]))/i)
    .map(chunk => normalizeArticleNumber(chunk))
    .filter(Boolean);

  // Keep unique values in original order
  return [...new Set(chunks)];
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
 *
 * Returns an empty string for non-article fragments (e.g. "zesde lid") so
 * callers can filter them out.
 */
export function normalizeArticleNumber(art) {
  // Strip sub-paragraph qualifiers after a comma ("14, § 7" → "14")
  // Also strip French/Dutch ordinal suffixes: "1er" → "1", "2ème" → "2",
  // "3e" → "3", "1ière" → "1". The suffix must immediately follow digits
  // and be at a word boundary so that "bis", "ter" etc. are not affected.
  const text = art
    .replace(/,.*$/, '')
    .replace(/^([0-9]+)(?:ère?|ième|ème|ste|de|nd|er)\b/i, '$1')
    .trim();
  if (!text) return '';

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

  // Pattern C/D: standard numeric, colon-separated ("3:1"), or slash-separated ("23/1").
  // Only strip the decimal sub-paragraph dot for pure-numeric articles ("14.7" → "14").
  const normalized = text
    .replace(/\.([0-9]).*$/, '') // "14.7" → "14"
    .trim();

  const match = normalized.match(/^([0-9]+(?:[:/][0-9]+)?(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)?)\b/i);
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
