/**
 * Shared utilities for texts that are split across multiple ELIs,
 * loaded from split_texts.json.
 *
 * Used by --find-missing-eli (to assign the correct ELI per article)
 * and --process-missing-eli (to reassign misplaced abstracts).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_TEXTS = JSON.parse(readFileSync(join(__dirname, '..', 'split_texts.json'), 'utf8'));

/**
 * Parse an article identifier into a comparable tuple [baseNum, subNum].
 * "1341" → [1341, 0], "555/16" → [555, 16], "1385octiesdecies" → [1385, 0], "710bis" → [710, 0.1]
 * The sub-number captures /N suffixes; Latin suffixes (bis, ter, …) are treated as small fractions.
 */
const LATIN_SUFFIXES = { bis: 0.1, ter: 0.2, quater: 0.3, quinquies: 0.4, sexies: 0.5, septies: 0.6, octies: 0.7, novies: 0.8, decies: 0.9, undecies: 0.91, duodecies: 0.92, terdecies: 0.93, quaterdecies: 0.94, quinquiesdecies: 0.95, sexiesdecies: 0.96, septiesdecies: 0.97, octiesdecies: 0.98 };

function parseArticleTuple(article) {
  if (!article) return null;
  const s = String(article);
  const m = s.match(/^(\d+)(?:\/(\d+))?(.*)$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  if (m[2]) return [base, parseInt(m[2], 10)]; // e.g. 555/16
  const suffix = (m[3] || '').toLowerCase();
  const latinVal = LATIN_SUFFIXES[suffix] || 0;
  return [base, latinVal];
}

/**
 * Compare two article tuples. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareArticles(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * Check if a legal basis key (from missing_eli.json) matches a split text.
 * Matches against both FR and NL names, case-insensitive.
 * Returns the split text definition or null.
 */
export function findSplitText(key) {
  const keyLower = key.toLowerCase();
  for (const st of SPLIT_TEXTS) {
    for (const name of Object.values(st.names)) {
      if (keyLower.includes(name.toLowerCase())) {
        return st;
      }
    }
  }
  return null;
}

/**
 * Extract a DD-MM-YYYY date from an ELI URL path.
 * e.g. "https://www.ejustice.just.fgov.be/eli/loi/1878/04/17/1878041750/justel"
 *   → "17-04-1878"
 */
function extractDateFromEli(eli) {
  const m = (eli || '').match(/\/eli\/\w+\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Given a split text definition and an article identifier, find the ELI
 * whose range covers that article.  Returns the ELI URL string or null.
 *
 * When multiple parts have overlapping ranges (e.g. TPCPP articles 1-32
 * overlap with CIC first part articles 8-136ter), the optional dateHint
 * (DD-MM-YYYY from the raw legal-basis text) is used to pick the part
 * whose ELI date matches.  Without a dateHint the first matching part wins.
 */
export function findEliForArticle(splitText, article, dateHint) {
  if (!article || article === 'general') return null;

  const target = parseArticleTuple(article);
  if (!target) return null;

  const matches = [];
  for (const part of splitText.parts) {
    const from = parseArticleTuple(part.from);
    const to = parseArticleTuple(part.to);
    if (from && to && compareArticles(target, from) >= 0 && compareArticles(target, to) <= 0) {
      matches.push(part);
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1 || !dateHint) return matches[0].eli;

  // Multiple matching parts — use dateHint to disambiguate
  for (const part of matches) {
    if (extractDateFromEli(part.eli) === dateHint) return part.eli;
  }
  return matches[0].eli;
}

/**
 * Correct an already-assigned ELI using the date from the raw legal-basis
 * text.  Handles the case where ejustice.be assigns the wrong ELI within
 * a split text (e.g. CIC first-part ELI for an article that belongs to the
 * TPCPP based on its law date).
 *
 * Returns the corrected ELI, or the original if no correction is needed.
 */
export function correctEliByDate(eli, article, rawTextDate) {
  if (!eli || !rawTextDate || !article || article === 'general') return eli;

  const found = findSplitTextByEli(eli);
  if (!found) return eli;

  const eliDate = extractDateFromEli(eli);
  if (!eliDate || eliDate === rawTextDate) return eli;

  // The date in the legal-basis text differs from the ELI date.
  // Look for another part in the same split text whose ELI date matches
  // the raw text date and whose article range covers the article.
  const { splitText } = found;
  for (const part of splitText.parts) {
    if (part.eli === eli) continue;
    if (extractDateFromEli(part.eli) !== rawTextDate) continue;

    const from = parseArticleTuple(part.from);
    const to = parseArticleTuple(part.to);
    const target = parseArticleTuple(article);
    if (from && to && target &&
        compareArticles(target, from) >= 0 &&
        compareArticles(target, to) <= 0) {
      return part.eli;
    }
  }

  return eli;
}

/**
 * Given an ELI URL, check whether it belongs to a split text.
 * Returns { splitText, part } or null.
 */
export function findSplitTextByEli(eli) {
  if (!eli) return null;
  const normalized = eli.replace(/^http:\/\//, 'https://');
  for (const st of SPLIT_TEXTS) {
    for (const part of st.parts) {
      if (normalized === part.eli || normalized === part.eli.replace(/^http:\/\//, 'https://')) {
        return { splitText: st, part };
      }
    }
  }
  return null;
}

/**
 * Return all ELIs for a given split text (all parts).
 */
export function getAllSplitTextElis() {
  const result = [];
  for (const st of SPLIT_TEXTS) {
    for (const part of st.parts) {
      result.push({ splitText: st, part });
    }
  }
  return result;
}

/**
 * Check if an article belongs to a specific part of a split text.
 */
export function articleBelongsToPart(article, part) {
  if (!article || article === 'general') return true; // can't determine, assume ok
  const target = parseArticleTuple(article);
  if (!target) return true; // non-parseable, assume ok
  const from = parseArticleTuple(part.from);
  const to = parseArticleTuple(part.to);
  if (!from || !to) return true;
  return compareArticles(target, from) >= 0 && compareArticles(target, to) <= 0;
}
