/**
 * --find-missing-eli implementation
 *
 * For each entry in missing_eli.json that has no ELI, tries to detect the
 * correct ELI by:
 *
 * 1. Consulting log.json for the same legal basis key with a known ELI.
 *    For codes with multiple ELIs, only trusts the match when nearby
 *    articles confirm the same ELI covers the requested article range.
 *
 * 2. Searching the ejustice website when log.json is insufficient.
 *    - Named codes: search by code name, parse article ranges from titles
 *    - Generic types (LOI, ARRETE ROYAL …): search by type + date + title
 *    - International instruments / general principles: skipped
 *
 * See ejustice_search_reference.md for detailed website documentation.
 */

import chalk from 'chalk';
import readline from 'node:readline';
import * as cheerio from 'cheerio';
import { logInfo, logSuccess, logWarn, logError, timestamp } from './logger.js';
import {
  loadMissingEliFile, saveMissingEliFile, loadLogFile,
  loadDataFile, saveDataFile,
} from './storage.js';
import {
  extractLegalBasisKey, normalizeArticleNumber, eliToFilename,
  normalizeEliToFrench, sleep, isInternationalInstrument,
} from './utils.js';
import { progress } from './progress.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const EJUSTICE_SEARCH_URL = 'https://www.ejustice.just.fgov.be/cgi_loi/rech_res.pl';
const EJUSTICE_ARTICLE_URL = 'https://www.ejustice.just.fgov.be/cgi_loi/article.pl';
const REQUEST_DELAY_MS = 1500;

// Per-run caches – cleared at the start of findMissingEli().
const _ejusticeSearchCache = new Map();
const _numacEliCache = new Map();

/**
 * Map common French/Dutch legal basis name patterns to the ejustice
 * "Nature juridique" (dt) option value (French form).
 * Tested in order; first match wins.
 */
const NATURE_JURIDIQUE_PATTERNS = [
  // Named codes
  { pattern: /\bCode\s+judiciaire\b|\bGerechtelijk\s+Wetboek\b/i, dt: 'CODE JUDICIAIRE' },
  { pattern: /\bancien\s+Code\s+[Cc]ivil\b|\boud\s+Burgerlijk\s+Wetboek\b/i, dt: 'CODE CIVIL' },
  { pattern: /\bCode\s+civil\b|\bBurgerlijk\s+Wetboek\b/i, dt: 'CODE CIVIL' },
  { pattern: /\bCode\s+p[ée]nal\s+social\b|\bSociaal\s+Strafwetboek\b/i, dt: 'CODE PENAL SOCIAL' },
  { pattern: /\bCode\s+p[ée]nal\b|\bStrafwetboek\b/i, dt: 'CODE PENAL' },
  { pattern: /\bCode\s+de\s+droit\s+[ée]conomique\b|\bWetboek\s+van\s+economisch\s+recht\b/i, dt: 'CODE DE DROIT ECONOMIQUE' },
  { pattern: /\bCode\s+de\s+commerce\b|\bWetboek\s+van\s+Koophandel\b/i, dt: 'CODE DE COMMERCE' },
  { pattern: /\bCode\s+d'instruction\s+criminelle\b|\bWetboek\s+van\s+Strafvordering\b/i, dt: "CODE D'INSTRUCTION CRIMINELLE" },
  { pattern: /\bCode\s+des\s+soci[ée]t[ée]s\s+et\s+des\s+associations\b|\bWetboek\s+van\s+vennootschappen\s+en\s+verenigingen\b/i, dt: 'CODE DES SOCIETES ET DES ASSOCIATIONS' },
  { pattern: /\bCode\s+des\s+soci[ée]t[ée]s\b|\bWetboek\s+van\s+[Vv]ennootschappen\b/i, dt: 'CODE DES SOCIETES' },
  { pattern: /\bC[ôo]de\s+des\s+imp[ôo]ts\s+sur\s+les\s+revenus\b|\bWetboek\s+(?:van\s+de\s+)?[Ii]nkomstenbelastingen\b/i, dt: 'CODE DES IMPOTS SUR LES REVENUS' },
  { pattern: /\bCode\s+de\s+la\s+taxe\s+sur\s+la\s+valeur\s+ajout[ée]e\b|\bWetboek\s+(?:van\s+de\s+)?[Bb]elastin.*toegevoegde\s+waarde\b|\bB\.?T\.?W\.?\s*-?\s*Wetboek\b/i, dt: 'CODE DE LA TAXE SUR LA VALEUR AJOUTEE' },
  { pattern: /\bCode\s+des\s+droits\s+d'enregistrement\b|\bWetboek\s+der?\s+[Rr]egistratie/i, dt: "CODE DES DROITS D'ENREGISTREMENT, D'HYPOTHEQUE ET DE GREFFE" },
  { pattern: /\bCode\s+des\s+droits\s+de\s+succession\b|\bWetboek\s+der?\s+[Ss]uccessierechten\b/i, dt: 'CODE DES DROITS DE SUCCESSION' },
  { pattern: /\bCode\s+des\s+droits\s+de\s+timbre\b|\bWetboek\s+der?\s+[Zz]egelrechten\b/i, dt: 'CODE DES DROITS DE TIMBRE' },
  { pattern: /\bCode\s+des\s+droits\s+et\s+taxes\s+divers\b|\bWetboek\s+diverse\s+rechten\b/i, dt: 'CODE DES DROITS ET TAXES DIVERS' },
  { pattern: /\bCode\s+des\s+taxes\s+assimil[ée]es\s+au\s+timbre\b|\bWetboek\s+der?\s+met\s+.*zegel\b/i, dt: 'CODE DES TAXES ASSIMILEES AU TIMBRE' },
  { pattern: /\bCode\s+des\s+taxes\s+assimil[ée]es\s+aux\s+imp[ôo]ts\b|\bWetboek\s+der?\s+met\s+de\s+inkomstenbelastingen\b/i, dt: 'CODE DES TAXES ASSIMILEES AUX IMPOTS SUR LES REVENUS' },
  { pattern: /\bCode\s+[ée]lectoral\b|\bKieswetboek\b/i, dt: 'CODE ELECTORAL' },
  { pattern: /\bCode\s+forestier\b|\bBoswetboek\b/i, dt: 'CODE FORESTIER' },
  { pattern: /\bCode\s+rural\b|\bVeldwetboek\b/i, dt: 'CODE RURAL' },
  { pattern: /\bCode\s+de\s+la\s+nationalit[ée]\s+belge\b|\bWetboek\s+van\s+de\s+Belgische\s+nationaliteit\b/i, dt: 'CODE DE LA NATIONALITE BELGE' },
  { pattern: /\bCode\s+de\s+droit\s+international\s+priv[ée]\b|\bWetboek\s+van\s+internationaal\s+privaatrecht\b/i, dt: 'CODE DE DROIT INTERNATIONAL PRIVE' },
  { pattern: /\bCode\s+de\s+la\s+d[ée]mocratie\s+locale\b/i, dt: 'CODE DE LA DEMOCRATIE LOCALE ET DE LA DECENTRALISATION' },
  { pattern: /\bCode\s+belge\s+de\s+la\s+navigation\b|\bBelgisch\s+Scheepvaartwetboek\b/i, dt: 'CODE BELGE DE LA NAVIGATION' },
  { pattern: /\bCode\s+du\s+bien[- ]?[êe]tre\s+au\s+travail\b|\bCodex\s+(?:over\s+het\s+)?[Ww]elzijn\b/i, dt: 'CODE DU BIEN ETRE AU TRAVAIL' },
  { pattern: /\bCode\s+consulaire\b|\bConsul(?:air)\s+[Ww]etboek\b/i, dt: 'CODE CONSULAIRE' },
  { pattern: /\bCode\s+ferroviaire\b|\bSpoorcodex\b/i, dt: 'CODE FERROVIAIRE' },
  { pattern: /\bCode\s+de\s+la\s+fonction\s+publique\s+wallonne\b|\bWaalse\s+Ambtenarencode\b/i, dt: 'CODE DE LA FONCTION PUBLIQUE WALLONNE' },

  // Constitutions
  { pattern: /\bConstitution\s*1994\b|\bGrondwet\s*1994\b/i, dt: 'CONSTITUTION 1994' },
  { pattern: /\bConstitution\b|\bGrondwet\b/i, dt: 'CONSTITUTION 1994' },

  // Decrees
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?Communaut[ée]\s+fran[çc]aise\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },
  { pattern: /\bDecreet\s+(?:van\s+de\s+)?Franse\s+Gemeenschap\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?Communaut[ée]\s+germanophone\b|\bDekr(?:eet|\.)\s+(?:van\s+de\s+)?Duitstalige\b/i, dt: 'DECRET COMMUNAUTE GERMANOPHONE' },
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?R[ée]gion\s+wallonne\b|\bDecreet\s+(?:van\s+het\s+)?Waals\s+Gewest\b/i, dt: 'DECRET REGION WALLONNE' },
  { pattern: /\bDecreet\s+(?:van\s+de\s+)?Vlaamse\s+Raad\b|\bD[ée]cret\s+(?:du\s+)?Conseil\s+flamand\b/i, dt: 'DECRET CONSEIL FLAMAND' },
  { pattern: /\bD[ée]cret\b|\bDecreet\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },

  // Arrêtés
  { pattern: /\bArr[êe]t[ée]\s+royal\b|\bKoninklijk\s+[Bb]esluit\b|\bK\.B\.\b|\bA\.R\.\b/i, dt: 'ARRETE ROYAL' },
  { pattern: /\bArr[êe]t[ée]\s+minist[ée]riel\b|\bMinisterieel\s+[Bb]esluit\b/i, dt: 'ARRETE MINISTERIEL' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*(?:R[ée]gion\s+wallonne|Waalse?\s+Gewest|Waalse?\s+Regering)\b|\bBesluit\s+.*Waals\b/i, dt: 'ARRETE REGION WALLONNE' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?\s+flamand\b|\bBesluit\s+(?:van\s+de\s+)?Vlaamse\s+Regering\b/i, dt: 'ARRETE GOUVERNEMENT FLAMAND' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*Communaut[ée]\s+fran[çc]aise\b/i, dt: 'ARRETE COMMUNAUTE FRANCAISE' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*Communaut[ée]\s+germanophone\b/i, dt: 'ARRETE COMMUNAUTE GERMANOPHONE' },
  { pattern: /\bArr[êe]t[ée][- ]?loi\b|\bBesluitwet\b/i, dt: 'ARRETE-LOI' },
  { pattern: /\bArr[êe]t[ée]\s+du\s+R[ée]gent\b|\bRegentsbesluit\b/i, dt: 'ARRETE DU REGENT' },

  // Ordonnances
  { pattern: /\bOrdonnance\b|\bOrdonnantie\b/i, dt: 'ORDONNANCE (BRUXELLES)' },

  // Treaties (national form, not EU)
  { pattern: /\bTrait[ée]\b(?!.*(?:CEE|CECA|Euratom|CE\b))|\bVerdrag\b(?!.*(?:EEG|EGKS))/i, dt: 'TRAITE' },

  // Conventions collectives
  { pattern: /\bConvention\s+collective\s+de\s+travail\b|\bCollectieve\s+arbeidsovereenkomst\b|\bCAO\b/i, dt: 'CONVENTION COLLECTIVE DE TRAVAIL' },

  // Loi communale / provinciale
  { pattern: /\bloi\s+communale\b|\bgemeentewet\b/i, dt: 'LOI COMMUNALE' },
  { pattern: /\bloi\s+provinciale\b|\bprovinciewet\b/i, dt: 'LOI PROVINCIALE' },

  // Loi (generic catch-all)
  { pattern: /\b(?:Loi|L\.\s|Wet)\b/i, dt: 'LOI' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Texts that cannot be found on ejustice.
 */
function isUnfindableOnEjustice(key) {
  if (!key) return true;
  // EU directives, regulations, decisions
  if (/\b(?:directive|richtlijn)\s+\d/i.test(key)) return true;
  if (/\b(?:règlement|verordening)\s+\(/i.test(key)) return true;
  if (/\b(?:décision[- ]cadre|kaderbesluit)\b/i.test(key)) return true;
  // EU charters
  if (/\b(?:charte\s+des\s+droits|handvest\s+van\s+de\s+grondrechten)\b/i.test(key)) return true;
  // General legal principles
  if (/\b(?:principe\s+g[ée]n[ée]ral|rechtsbeginsel|beginsel)\b/i.test(key)) return true;
  // International instruments
  if (isInternationalInstrument(key)) return true;
  // "Divers" / unspecified
  if (/^divers\b/i.test(key)) return true;
  return false;
}

function detectNatureJuridique(key) {
  for (const { pattern, dt } of NATURE_JURIDIQUE_PATTERNS) {
    if (pattern.test(key)) return dt;
  }
  return null;
}

function extractPromulgationDate(key) {
  const m = key.match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function extractTitleKeywords(key) {
  let text = key.replace(/\s*-\s*\d{2}-\d{2}-\d{4}.*$/, '');
  text = text.replace(/^(?:L\.\s*(?:du|van)?\s*|Loi\s*(?:du|sur\s+la|relative\s+[àa]\s+la|portant)?\s*|Wet\s*(?:van|betreffende|tot|houdende|op\s+de)?\s*|Arr[êe]t[ée]\s+royal\s*(?:du|van|relatif|portant)?\s*|Koninklijk\s+Besluit\s*(?:van|betreffende|tot|houdende)?\s*|D[ée]cret\s*(?:du|van|relatif|portant)?\s*|Decreet\s*(?:van|betreffende|tot|houdende)?\s*|Ordonnance\s*(?:du|de\s+la|portant)?\s*|Ordonnantie\s*(?:van|betreffende|tot|houdende)?\s*)/i, '');
  text = text.replace(/^\d{1,2}\s+\w+\s+\d{4}\s*(?:qui|relative?\s+[àa]|betreffende|tot|portant|sur|inzake|houdende)?\s*/i, '');
  text = text.trim();
  const words = text.split(/\s+/).filter(w => w.length > 3);
  return words.length > 0 ? words.slice(0, 4).join(' ') : null;
}

/**
 * Parse a base article identifier to a numeric value for range comparison.
 */
function parseArticleToNumber(article) {
  if (!article) return null;
  const m = article.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * For log keys: strip the trailing " - DD-MM-YYYY" date suffix to get the
 * bare law-name prefix (e.g. "ancien Code Civil - 21-03-1804" → "ancien Code Civil").
 */
function extractLogKeyPrefix(key) {
  return key.replace(/ - \d{2}-\d{2}-\d{4}$/, '').trim();
}

/**
 * For missing_eli keys that contain an article ref instead of a date
 * (e.g. "ancien Code Civil - Art. 1354"), strip the article part to get the
 * bare law-name prefix.  Returns null when the key already ends with a date
 * (exact key lookup should be tried first).
 */
function extractMissingKeyPrefix(key) {
  const stripped = key.replace(/ - [Aa]rtt?[.:\s].*$/i, '').trim();
  return stripped !== key ? stripped : null;
}

function promptUserFn(question) {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    process.stdin.ref();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      process.stdin.unref();
      if (wasRaw) process.stdin.setRawMode(true);
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ─── Log-based resolution ────────────────────────────────────────────────────

/**
 * Build two maps from log.json:
 *   map       → legalBasisKey (exact)     → Map<eli, Set<article>>
 *   prefixMap → law-name prefix (no date) → Map<eli, Set<article>>
 *
 * The prefix map is used as a fallback for missing_eli keys that were stored
 * without a promulgation date (e.g. "ancien Code Civil - Art. 1354").
 */
function buildLogEliMap(logData) {
  const map = new Map();
  const prefixMap = new Map();

  function addToEliMap(target, key, eli, article) {
    if (!target.has(key)) target.set(key, new Map());
    const eliMap = target.get(key);
    if (!eliMap.has(eli)) eliMap.set(eli, new Set());
    if (article) eliMap.get(eli).add(article);
  }

  for (const logKey of Object.keys(logData)) {
    const entry = logData[logKey];
    if (!entry.legalBases?.length) continue;
    for (const lb of entry.legalBases) {
      if (!lb.eli) continue;
      const eli = normalizeEliToFrench(lb.eli);
      const basisKeyFR = lb.legalBasisFR ? extractLegalBasisKey(lb.legalBasisFR) : null;
      const basisKeyNL = lb.legalBasisNL ? extractLegalBasisKey(lb.legalBasisNL) : null;
      for (const bk of [basisKeyFR, basisKeyNL]) {
        if (!bk) continue;
        addToEliMap(map, bk, eli, lb.article);
        const prefix = extractLogKeyPrefix(bk);
        if (prefix && prefix !== bk) {
          addToEliMap(prefixMap, prefix, eli, lb.article);
        }
      }
    }
  }
  return { map, prefixMap };
}

/**
 * Attempt to resolve the ELI for a missing entry using log.json data.
 *
 * Tries exact key lookup first.  If that fails and the key looks like an
 * article-based key without a date (e.g. "ancien Code Civil - Art. 1354"),
 * falls back to a prefix match ("ancien Code Civil") in prefixMap.
 *
 * For single-ELI entries: straightforward.
 * For multi-ELI entries (codes): trusts the match when one ELI dominates
 * by article count ("substantial" heuristic), or via range containment.
 */
function resolveFromLog(basisKey, article, logEliMap, prefixMap) {
  let eliArticles = logEliMap.get(basisKey);

  // Fallback: prefix-based lookup for keys without a date
  if (!eliArticles && prefixMap) {
    const prefix = extractMissingKeyPrefix(basisKey);
    if (prefix) eliArticles = prefixMap.get(prefix);
  }

  if (!eliArticles) return null;

  // Normalize HTTP → HTTPS and deduplicate
  const normalized = new Map();
  for (const [eli, arts] of eliArticles) {
    const key = eli.replace(/^http:\/\//, 'https://');
    if (!normalized.has(key)) normalized.set(key, new Set());
    for (const a of arts) normalized.get(key).add(a);
  }

  const uniqueElis = [...normalized.keys()];

  if (uniqueElis.length === 1) {
    return { eli: uniqueElis[0], confidence: 'high' };
  }

  // Multiple ELIs → code with multiple parts, or one primary + minor ancillary.
  // Heuristic: if one ELI has many more articles than all others, use it.
  const artCounts = uniqueElis.map(e => normalized.get(e).size);
  const maxCount = Math.max(...artCounts);
  const otherTotal = artCounts.reduce((s, c) => s + c, 0) - maxCount;
  const dominant = uniqueElis[artCounts.indexOf(maxCount)];
  if (maxCount >= 5 && maxCount >= 5 * (otherTotal || 1)) {
    return { eli: dominant, confidence: 'medium' };
  }

  // Multiple ELIs → code with multiple parts
  if (!article || article === 'general') return null;

  const targetNum = parseArticleToNumber(article);
  if (targetNum === null) {
    // Non-numeric article — try exact match
    for (const [eli, arts] of normalized) {
      if (arts.has(article)) return { eli, confidence: 'high' };
    }
    return null;
  }

  // For each ELI, find the numeric article range and check containment
  let bestEli = null;
  let bestMin = -Infinity;
  let bestMax = Infinity;

  for (const [eli, arts] of normalized) {
    const nums = [];
    for (const a of arts) {
      const n = parseArticleToNumber(a);
      if (n !== null) nums.push(n);
    }
    if (nums.length < 2) continue; // need at least 2 articles to infer a range

    const min = Math.min(...nums);
    const max = Math.max(...nums);

    if (targetNum >= min && targetNum <= max) {
      // Prefer the tightest-fitting range
      if ((max - min) < (bestMax - bestMin)) {
        bestEli = eli;
        bestMin = min;
        bestMax = max;
      }
    }
  }

  if (bestEli) {
    return { eli: bestEli, confidence: 'medium' };
  }

  return null;
}

// ─── Ejustice resolution ─────────────────────────────────────────────────────

async function searchEjustice(dt, date, titleKeywords) {
  const params = new URLSearchParams({
    language: 'fr',
    dt,
    fr: 'f',
    choix1: 'et',
    choix2: 'et',
    trier: 'promulgation',
  });
  if (date) {
    params.set('ddd', date);
    params.set('ddf', date);
  }
  if (titleKeywords) {
    params.set('text1', titleKeywords);
    params.set('chercher', 'c');
  }

  const response = await fetch(EJUSTICE_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  await sleep(REQUEST_DELAY_MS);
  return parseSearchResults(html);
}

/** Cached wrapper – no extra sleep on a cache hit. */
async function cachedSearchEjustice(dt, date, titleKeywords) {
  const k = `${dt}|${date || ''}|${titleKeywords || ''}`;
  if (!_ejusticeSearchCache.has(k)) {
    _ejusticeSearchCache.set(k, await searchEjustice(dt, date, titleKeywords));
  }
  return _ejusticeSearchCache.get(k);
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('a.list-item--title').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const numacMatch = href.match(/numac_search=(\d+)/);
    if (!numacMatch) return;

    // The full title (including article ranges like "(art. 664 à 1385octiesdecies)")
    // is the text content of the link element itself.
    // $(el).next() is <p class="list-item--date"> which only contains a date string.
    const title = $(el).text().trim();

    const dateEl = $(el).closest('.list-item--content').find('.list-item--date');
    const pubDate = dateEl.text().trim();

    results.push({ numac: numacMatch[1], title, pubDate });
  });

  // Deduplicate by numac
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.numac)) return false;
    seen.add(r.numac);
    return true;
  });
}

function parseArticleRange(title) {
  const m = title.match(/\(art(?:icle)?\.?\s+(\S+)\s+[àa]\s+(\S+?)\)?$/i);
  if (!m) return null;
  return { start: m[1], end: m[2].replace(/\)$/, '') };
}

async function fetchEliFromArticlePage(numac) {
  const url = `${EJUSTICE_ARTICLE_URL}?language=fr&numac_search=${encodeURIComponent(numac)}&page=1&lg_txt=F&caller=list`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const html = await response.text();
  const $ = cheerio.load(html);
  const eli = $('a#link-text').attr('href') || null;
  await sleep(REQUEST_DELAY_MS);
  return eli;
}

/** Cached wrapper – no extra sleep on a cache hit. */
async function cachedFetchEli(numac) {
  if (!_numacEliCache.has(numac)) {
    _numacEliCache.set(numac, await fetchEliFromArticlePage(numac));
  }
  return _numacEliCache.get(numac);
}

function findCodePartForArticle(results, article) {
  const targetNum = parseArticleToNumber(article);

  // Filter out German translations and standalone annexes
  const mainParts = results.filter(r => {
    const tl = r.title.toLowerCase();
    if (tl.includes('traduction allemande') || tl.includes('coordination officieuse en langue allemande')) return false;
    if (tl.includes('annexe') && !tl.includes('(art.')) return false;
    return true;
  });

  for (const result of mainParts) {
    const range = parseArticleRange(result.title);
    if (!range) continue;

    const startNum = parseArticleToNumber(range.start);
    const endNum = parseArticleToNumber(range.end);

    if (targetNum !== null && startNum !== null && endNum !== null) {
      if (targetNum >= startNum && targetNum <= endNum) return result;
    }

    if (article === range.start || article === range.end) return result;
  }

  // Single main part with no range
  const partsWithContent = mainParts.filter(r => !r.title.toLowerCase().includes('annexe'));
  if (partsWithContent.length === 1) return partsWithContent[0];

  return null;
}

async function resolveFromEjustice(key, article) {
  if (isUnfindableOnEjustice(key)) {
    return { eli: null, reason: 'unfindable' };
  }

  const dt = detectNatureJuridique(key);
  if (!dt) return { eli: null, reason: 'unknown_nature_juridique' };

  const date = extractPromulgationDate(key);
  const isNamedCode = dt.startsWith('CODE ') || dt.startsWith('CONSTITUTION');

  let results;
  try {
    results = isNamedCode
      ? await cachedSearchEjustice(dt, null, null)
      : date ? await cachedSearchEjustice(dt, date, null) : null;
    if (!results) return { eli: null, reason: 'no_date' };
  } catch (err) {
    return { eli: null, reason: `search_error: ${err.message}` };
  }

  if (results.length === 0) return { eli: null, reason: 'no_results' };

  // Single result → use it directly
  if (results.length === 1) {
    try {
      const eli = await cachedFetchEli(results[0].numac);
      return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
    } catch {
      return { eli: null, reason: 'eli_fetch_error' };
    }
  }

  // Multiple results for a named code → find article range
  if (isNamedCode) {
    if (!article || article === 'general') {
      return { eli: null, reason: 'code_no_article' };
    }
    const match = findCodePartForArticle(results, article);
    if (match) {
      try {
        const eli = await cachedFetchEli(match.numac);
        return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
      } catch {
        return { eli: null, reason: 'eli_fetch_error' };
      }
    }
    return { eli: null, reason: 'code_article_not_in_range' };
  }

  // Multiple results for generic type → try narrowing by title
  const titleKeywords = extractTitleKeywords(key);
  if (titleKeywords) {
    try {
      const narrowed = await cachedSearchEjustice(dt, date, titleKeywords);
      if (narrowed.length === 1) {
        const eli = await cachedFetchEli(narrowed[0].numac);
        return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
      }
    } catch { /* fall through */ }
  }

  return { eli: null, reason: 'ambiguous_multiple_results' };
}

// ─── Data integration ────────────────────────────────────────────────────────

/**
 * Store an element from missing_eli.json into the appropriate data file.
 */
function storeElementToDataFile(element, eli) {
  const filename = eliToFilename(eli);
  const data = loadDataFile(filename);
  const article = normalizeArticleNumber(element.article || '') || 'general';

  if (!data[article]) data[article] = {};

  function mergeArr(existing, incoming) {
    const arr = Array.isArray(existing) ? [...existing] : (existing ? [existing] : []);
    if (Array.isArray(incoming)) {
      for (const v of incoming) { if (v && !arr.includes(v)) arr.push(v); }
    } else if (incoming && !arr.includes(incoming)) {
      arr.push(incoming);
    }
    return arr.length > 0 ? arr : null;
  }

  const existing = data[article][element.ecli] || {};
  data[article][element.ecli] = {
    court: element.court,
    date: element.date,
    roleNumber: element.roleNumber,
    sitemap: mergeArr(existing.sitemap, element.sitemap),
    abstractFR: mergeArr(existing.abstractFR, element.abstractFR),
    abstractNL: mergeArr(existing.abstractNL, element.abstractNL),
  };

  saveDataFile(filename, data);
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function findMissingEli() {
  logInfo(`${timestamp()} Loading missing_eli.json...`);
  const missingEli = loadMissingEliFile();
  const allKeys = Object.keys(missingEli);

  const toProcess = allKeys.filter(k =>
    !missingEli[k].eli && missingEli[k].elements?.length > 0
  );

  if (toProcess.length === 0) {
    logInfo(`${timestamp()} No missing ELI entries to process.`);
    return;
  }

  logInfo(`${timestamp()} Found ${toProcess.length} missing ELI entries to process (${allKeys.length} total keys).`);

  // Phase 1: Build log ELI map (and prefix map for date-less keys)
  logInfo(`${timestamp()} Loading log.json for cross-reference...`);
  let logEliMap = new Map();
  let logPrefixMap = new Map();
  // Clear per-run request caches
  _ejusticeSearchCache.clear();
  _numacEliCache.clear();
  try {
    const logData = loadLogFile();
    ({ map: logEliMap, prefixMap: logPrefixMap } = buildLogEliMap(logData));
    logInfo(`${timestamp()} Built ELI map with ${logEliMap.size} exact keys + ${logPrefixMap.size} prefix keys from log.json.`);
  } catch (err) {
    logWarn(`⚠ Could not load log.json: ${err.message}. Proceeding without log data.`);
  }

  // Phase 2: Process each entry
  const total = toProcess.length;
  progress.configure(total, total);
  progress.doneIndexes = 0;

  let resolvedCount = 0;
  let skippedCount = 0;
  let unfindableCount = 0;
  let ambiguousCount = 0;
  let applyAll = false;

  const pendingChanges = [];

  for (let i = 0; i < toProcess.length; i++) {
    const key = toProcess[i];
    const entry = missingEli[key];
    const articles = [...new Set(entry.elements.map(e => e.article).filter(Boolean))];
    const sampleArticle = articles[0] || 'general';

    // 1) Try log-based resolution (with prefix-map fallback for date-less keys)
    let resolution = resolveFromLog(key, sampleArticle, logEliMap, logPrefixMap);
    let source = 'log.json';

    // 2) Try ejustice website
    if (!resolution) {
      if (isUnfindableOnEjustice(key)) {
        unfindableCount++;
        progress.doneIndexes = i + 1;
        progress.render();
        continue;
      }

      resolution = await resolveFromEjustice(key, sampleArticle);
      source = 'ejustice';

      if (!resolution?.eli) {
        const reason = resolution?.reason || 'unknown';
        if (reason === 'unfindable' || reason === 'unknown_nature_juridique') {
          unfindableCount++;
        } else if (reason.includes('ambiguous') || reason.includes('multiple') || reason === 'code_no_article') {
          ambiguousCount++;
          progress.clear();
          logWarn(`  ⚠ [${i + 1}/${total}] Ambiguous: ${chalk.cyan(key.substring(0, 80))} — ${reason}`);
        } else {
          skippedCount++;
          if (reason !== 'no_results' && reason !== 'no_date') {
            progress.clear();
            logWarn(`  ⚠ [${i + 1}/${total}] Skipped: ${chalk.cyan(key.substring(0, 80))} — ${reason}`);
          }
        }
        progress.doneIndexes = i + 1;
        progress.render();
        continue;
      }
    }

    const dt = detectNatureJuridique(key);
    const isNamedCode = dt && (dt.startsWith('CODE ') || dt.startsWith('CONSTITUTION'));

    // For named codes with multiple articles (which may span different parts),
    // resolve each article independently so the right ELI is used per element.
    let perArticleElis = null;
    if (isNamedCode && articles.length > 1) {
      perArticleElis = new Map();
      for (const art of articles) {
        const artRes = resolveFromLog(key, art, logEliMap, logPrefixMap);
        if (artRes?.eli) {
          perArticleElis.set(art, normalizeEliToFrench(artRes.eli));
        }
      }
      // Fall back to ejustice for articles not resolved from log
      for (const art of articles) {
        if (!perArticleElis.has(art)) {
          const ejRes = await resolveFromEjustice(key, art);
          if (ejRes?.eli) perArticleElis.set(art, normalizeEliToFrench(ejRes.eli));
        }
      }
      // If nothing resolved, clear so we fall through to the skip path
      if (perArticleElis.size === 0) {
        perArticleElis = null;
      }
      // If all resolved to the same single ELI, collapse to simple path
      const uniquePerArt = perArticleElis ? [...new Set(perArticleElis.values())] : [];
      if (uniquePerArt.length === 1) {
        resolution = { eli: uniquePerArt[0], confidence: 'high' };
        source = 'log+ejustice';
        perArticleElis = null;
      }
    }

    // Display proposed change
    const eli = normalizeEliToFrench(resolution.eli);
    progress.clear();
    console.log('');
    logInfo(chalk.bold(`[${i + 1}/${total}]`) + ` ${key}`);
    if (perArticleElis) {
      const uniqueElis = [...new Set(perArticleElis.values())];
      logInfo(`  ELIs: ${uniqueElis.map(e => chalk.green(e)).join(', ')} (from ${chalk.cyan(source)})`);
      logInfo(`  Per-article mapping: ${[...perArticleElis.entries()].map(([a, e]) => `${a}→${eliToFilename(e)}`).join(', ')}`);
    } else {
      logInfo(`  ELI: ${chalk.green(eli)} (from ${chalk.cyan(source)}, confidence: ${resolution.confidence || 'high'})`);
    }
    logInfo(`  Elements: ${entry.elements.length} (articles: ${articles.join(', ') || 'general'})`);

    let answer;
    if (applyAll) {
      answer = 'yes';
    } else {
      progress.clear();
      const resp = await promptUserFn(
        chalk.yellow('  Apply? ') + chalk.gray('(yes/no/all/quit) ') + chalk.bold('> ')
      );
      answer = resp;
    }

    if (answer === 'quit' || answer === 'q') {
      logInfo(`${timestamp()} Quitting. Changes will be saved.`);
      break;
    }
    if (answer === 'all' || answer === 'a') {
      applyAll = true;
      answer = 'yes';
    }

    if (answer === 'yes' || answer === 'y') {
      if (perArticleElis) {
        // Per-article resolution: group elements by article → ELI
        pendingChanges.push({
          key,
          perArticleElis,
          elements: [...entry.elements],
        });
      } else {
        pendingChanges.push({
          key,
          eli,
          elements: [...entry.elements],
        });
      }
      resolvedCount++;
    } else {
      skippedCount++;
    }

    progress.doneIndexes = i + 1;
    progress.render();
  }

  progress.finish();

  // Apply pending changes
  if (pendingChanges.length > 0) {
    logInfo(`${timestamp()} Applying ${pendingChanges.length} change(s)...`);
    for (const change of pendingChanges) {
      const entry = missingEli[change.key];

      if (change.perArticleElis) {
        // Per-article resolution
        const remainingElements = [];
        for (const elem of change.elements) {
          const artEli = change.perArticleElis.get(elem.article);
          if (artEli) {
            storeElementToDataFile(elem, artEli);
          } else {
            remainingElements.push(elem);
          }
        }
        // Keep the primary ELI (most frequent) for the key
        const eliCounts = new Map();
        for (const [, e] of change.perArticleElis) {
          eliCounts.set(e, (eliCounts.get(e) || 0) + 1);
        }
        const primaryEli = [...eliCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (primaryEli) entry.eli = primaryEli;
        entry.elements = remainingElements;
      } else {
        // Single ELI for all elements
        for (const elem of change.elements) {
          storeElementToDataFile(elem, change.eli);
        }
        entry.eli = change.eli;
        entry.elements = [];
      }
    }
    saveMissingEliFile(missingEli);
    logSuccess(`✔ Applied ${pendingChanges.length} change(s).`);
  }

  // Summary
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║       FIND-MISSING-ELI COMPLETE          ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝'));
  logSuccess(`  Resolved:    ${resolvedCount}`);
  logInfo(`  Skipped:     ${skippedCount}`);
  logInfo(`  Unfindable:  ${unfindableCount}`);
  if (ambiguousCount > 0) {
    logWarn(`  Ambiguous:   ${ambiguousCount} (needs manual review / LLM)`);
  }
  logInfo(`  Total:       ${total}`);
  logInfo('');
}
