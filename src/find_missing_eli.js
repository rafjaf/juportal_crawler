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
  loadMissingEliFile, saveMissingEliFile, flushMissingEli, loadLogFile,
  loadDataFile, saveDataFile, loadSettings, saveSettings,
} from './storage.js';
import {
  extractLegalBasisKey, normalizeArticleNumber, eliToFilename,
  normalizeEliToFrench, sleep, isInternationalInstrument,
} from './utils.js';
import { progress } from './progress.js';
import { findSplitText, findEliForArticle } from './split_texts.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const EJUSTICE_SEARCH_URL = 'https://www.ejustice.just.fgov.be/cgi_loi/rech_res.pl';
const EJUSTICE_ARTICLE_URL = 'https://www.ejustice.just.fgov.be/cgi_loi/article.pl';
const REQUEST_DELAY_MS = 1500;

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
// Default model — can be overridden in settings.json under "openai_model"
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';

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

  // Brussels codes
  { pattern: /\bCode\s+bruxellois\s+(?:(?:de\s+l|d)[\u2019\u2018']?)?am[\u00e9e]nagement\s+du\s+territoire\b|\bBrussels\s+Wetboek\s+van\s+Ruimtelijke\s+Ordening\b|\bCoBAT\b/i, dt: "CODE BRUXELLOIS DE L'AMENAGEMENT DU TERRITOIRE" },
  { pattern: /\bCode\s+bruxellois\s+du\s+logement\b|\bBrusselse?\s+Huisvestingscode\b/i, dt: 'CODE BRUXELLOIS DU LOGEMENT' },
  { pattern: /\bCode\s+bruxellois\s+de\s+l[\u2019\u2018'']air\b/i, dt: "CODE BRUXELLOIS DE L'AIR, DU CLIMAT ET DE LA MAITRISE DE L'ENERGIE" },

  // Constitutions
  { pattern: /\bConstitution\s*1994\b|\bGrondwet\s*1994\b/i, dt: 'CONSTITUTION 1994' },
  { pattern: /\bConstitution\b|\bGrondwet\b/i, dt: 'CONSTITUTION 1994' },

  // Decrees
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?Communaut[ée]\s+fran[çc]aise\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },
  { pattern: /\bDecreet\s+(?:van\s+de\s+)?Franse\s+Gemeenschap\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?Communaut[ée]\s+germanophone\b|\bDekr(?:eet|\.)\s+(?:van\s+de\s+)?Duitstalige\b/i, dt: 'DECRET COMMUNAUTE GERMANOPHONE' },
  { pattern: /\bd[ée]cret\s+(?:de\s+la\s+)?R[ée]gion\s+wallonne\b|\bDecreet\s+(?:van\s+het\s+)?Waals\s+Gewest\b/i, dt: 'DECRET REGION WALLONNE' },
  { pattern: /\bDecreet\s+(?:van\s+de\s+)?Vlaamse\s+(?:Raad|Overheid|Gemeenschap)\b|\bD[ée]cret\s+(?:du\s+)?(?:Conseil\s+flamand|(?:de\s+la\s+)?Communaut[ée]\s+flamande|(?:(?:de\s+l|d)[\u2019\u2018']?)Autorit[ée]\s+flamande)\b|\bDecreet\s+(?:van\s+het\s+)?Vlaams\s+Parlement\b/i, dt: 'DECRET CONSEIL FLAMAND' },
  { pattern: /\bD[ée]cret\s+\(Bruxelles\)|\bD[ée]cret\s+(?:de\s+la\s+)?(?:Commission|Assembl[ée]e)\s+communautaire\s+fran[çc]aise\b|\bDecreet\s+(?:van\s+de\s+)?Franse\s+Gemeenschapscommissie\b/i, dt: 'DECRET (BRUXELLES)' },
  { pattern: /\bD[ée]cret\b|\bDecreet\b/i, dt: 'DECRET COMMUNAUTE FRANCAISE' },

  // Arrêtés
  { pattern: /\bArr[êe]t[ée]\s+royal\b|\bKoninklijk\s+[Bb]esluit\b|\bK\.B\.(?=\s|$)|\bA\.R\.(?=\s|$)/i, dt: 'ARRETE ROYAL' },
  { pattern: /\bArr[êe]t[ée]\s+minist[ée]riel\b|\bMinisterieel\s+[Bb]esluit\b/i, dt: 'ARRETE MINISTERIEL' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*(?:R[ée]gion\s+wallonne|Waalse?\s+Gewest|Waalse?\s+Regering)\b|\bBesluit\s+.*Waals\b/i, dt: 'ARRETE REGION WALLONNE' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?\s+flamand\b|\bBesluit\s+(?:van\s+de\s+)?Vlaamse\s+Regering\b/i, dt: 'ARRETE GOUVERNEMENT FLAMAND' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*Communaut[ée]\s+fran[çc]aise\b/i, dt: 'ARRETE COMMUNAUTE FRANCAISE' },
  { pattern: /\bArr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?.*Communaut[ée]\s+germanophone\b/i, dt: 'ARRETE COMMUNAUTE GERMANOPHONE' },
  { pattern: /\bArr[êe]t[ée][- ]?loi\b|\bBesluitwet\b/i, dt: 'ARRETE-LOI' },
  { pattern: /\bArr[êe]t[ée]\s+du\s+R[ée]gent\b|\bRegentsbesluit\b/i, dt: 'ARRETE DU REGENT' },

  // Ordonnances
  { pattern: /\bOrdonnance\b|\bOrdonnantie\b/i, dt: 'ORDONNANCE (BRUXELLES)' },

  // Treaties, international conventions, and protocols (non-EU)
  { pattern: /\bTrait[ée]\b(?!.*(?:CEE|CECA|Euratom|CE\b))|\bVerdrag\b(?!.*(?:EEG|EGKS))/i, dt: 'TRAITE' },
  { pattern: /\bProtocole\b|\bProtocol\b/i, dt: 'TRAITE' },
  { pattern: /\bOvereenkomst\b(?!.*\b(?:arbeids|collectieve))/i, dt: 'TRAITE' },
  { pattern: /\bAkkoord\b(?!.*\b(?:arbeids|sectorieel|interprofessioneel))/i, dt: 'TRAITE' },

  // Conventions collectives
  { pattern: /\bConvention\s+collective\s+de\s+travail\b|\bCollectieve\s+arbeidsovereenkomst\b|\bCAO\b/i, dt: 'CONVENTION COLLECTIVE DE TRAVAIL' },
  // International conventions (matched after collective-agreement, so no ambiguity)
  { pattern: /\bConvention\b/i, dt: 'TRAITE' },

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

/**
 * Strip diacritical marks from a string so that keyword searches work
 * against the ISO-8859-1 ejustice server (which cannot parse UTF-8
 * percent-encoded accented characters sent by URLSearchParams).
 */
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function extractTitleKeywords(key) {
  let text = key.replace(/\s*-\s*\d{2}-\d{2}-\d{4}.*$/, '');
  // Strip legal-type prefixes ── long forms first, then abbreviations
  text = text.replace(/^(?:Arr[êe]t[ée]\s+(?:du\s+)?Gouv(?:ernement)?\s+(?:flamand|(?:de\s+la\s+)?(?:R[ée]gion\s+wallonne|Communaut[ée]\s+(?:fran[çc]aise|germanophone)))\s*(?:du|relatif|portant)?\s*|Besluit\s+(?:van\s+de\s+)?(?:Vlaamse\s+Regering|Waalse\s+Regering)\s*(?:van|betreffende|tot|houdende)?\s*|L\s+interpr[ée]tativ[e]?\s*(?:du)?\s*|L\.\s*(?:du|van)?\s*|Loi\s*(?:du|sur\s+la|relative\s+[àa]\s+la|portant)?\s*|Wet\s*(?:van|betreffende|tot|houdende|op\s+de)?\s*|Arr[êe]t[ée]\s+royal\s*(?:du|van|relatif|portant)?\s*|Koninklijk\s+Besluit\s*(?:van|betreffende|tot|houdende)?\s*|D[ée]cret\s*(?:du|van|de\s+la\s+Vlaamse\s+Overheid\s+van|relatif|portant)?\s*|Decreet\s*(?:van\s+de\s+Vlaamse\s+Overheid\s+van|van|betreffende|tot|houdende)?\s*|Ordonnance\s*(?:du|de\s+la|portant)?\s*|Ordonnantie\s*(?:van|betreffende|tot|houdende)?\s*|A\.R\.\s*(?:du)?\s*|K\.B\.?\s*(?:van)?\s*|M\.B\.?\s*(?:du)?\s*|A\.M\.?\s*(?:du)?\s*)/i, '');
  // Strip leading date expression: "6 février 2009", "18 januari 2008"
  text = text.replace(/^\d{1,2}\s+\w+\s+\d{4}\s*(?:qui|relative?\s+[àa]|betreffende|tot|portant|sur|inzake|houdende)?\s*/i, '');
  text = text.trim();
  const words = text.split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return null;
  return stripAccents(words.slice(0, 4).join(' '));
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
      // rl.close() pauses stdin — always resume so the process doesn't exit
      process.stdin.resume();
      if (wasRaw) {
        process.stdin.setRawMode(true);
        process.stdin.unref();
      }
      resolve(answer.trim());
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

/**
 * Remove German-language translations and unofficial coordinations from a result
 * list so that scoring is done only against primary French/Dutch texts.
 * Falls back to the full list if everything would be filtered out.
 */
function filterSecondaryTexts(results) {
  const isSecondary = r => {
    const tl = r.title.toLowerCase();
    return tl.includes('traduction allemande')
        || tl.includes('coordination officieuse en langue allemande')
        || tl.includes('deutsche koordination')
        // superseded texts: "<Annulé et remplacé...>" or "(Annulée...)"
        || /[(<]\s*annul/i.test(tl);
  };
  const filtered = results.filter(r => !isSecondary(r));
  return filtered.length > 0 ? filtered : results;
}

/**
 * Fallback dt types to try (in order) when a primary-dt search returns 0 results.
 * Handles cases like a French-language title of a Flemish decree.
 */
const DT_FALLBACKS = new Map([
  ['DECRET COMMUNAUTE FRANCAISE',  ['DECRET CONSEIL FLAMAND', 'DECRET REGION WALLONNE', 'DECRET (BRUXELLES)']],
  ['DECRET CONSEIL FLAMAND',       ['DECRET COMMUNAUTE FRANCAISE', 'DECRET REGION WALLONNE']],
  ['DECRET REGION WALLONNE',       ['DECRET COMMUNAUTE FRANCAISE', 'DECRET CONSEIL FLAMAND']],
  ['DECRET (BRUXELLES)',           ['ORDONNANCE (BRUXELLES)', 'DECRET COMMUNAUTE FRANCAISE']],
  ['ARRETE COMMUNAUTE FRANCAISE',  ['ARRETE GOUVERNEMENT FLAMAND', 'ARRETE REGION WALLONNE']],
  ['ARRETE GOUVERNEMENT FLAMAND',  ['ARRETE COMMUNAUTE FRANCAISE', 'ARRETE REGION WALLONNE']],
  ['ARRETE REGION WALLONNE',       ['ARRETE GOUVERNEMENT FLAMAND', 'ARRETE COMMUNAUTE FRANCAISE']],
  ['LOI',                          ['DECRET COMMUNAUTE FRANCAISE', 'DECRET CONSEIL FLAMAND']],
]);

/**
 * Score each result against the original key text by counting overlapping
 * significant words.  Secondary texts (German translations, superseded) are
 * removed first.
 *
 * Returns { best, scored } where:
 *   best   – single best result when it clearly outscores rivals (score ≥ 1
 *            AND strictly higher than second place), otherwise null.
 *   scored – array of { result, score } sorted descending, for user display.
 */
function scoreResultsByTitle(results, key) {
  const primary = filterSecondaryTexts(results);

  const keyNorm = stripAccents(key.toLowerCase());
  const keyWords = keyNorm.split(/\s+/).filter(w => w.length > 3);

  if (keyWords.length === 0) {
    return { best: null, scored: primary.map(r => ({ result: r, score: 0 })) };
  }

  const scored = primary.map(r => {
    const titleNorm = stripAccents(r.title.toLowerCase());
    const score = keyWords.filter(w => titleNorm.includes(w)).length;
    return { result: r, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Clear winner: any positive score AND strictly better than runner-up
  const best = (scored[0].score >= 1 && (scored.length === 1 || scored[0].score > scored[1].score))
    ? scored[0].result
    : null;

  return { best, scored };
}

function pickBestResultByTitle(results, key) {
  return scoreResultsByTitle(results, key).best;
}

// ─── Ejustice resolution ─────────────────────────────────────────────────────

async function searchEjustice(dt, date, titleKeywords, language = 'fr') {
  const params = new URLSearchParams({
    language,
    dt,
    choix1: 'et',
    choix2: 'et',
    trier: 'promulgation',
  });
  // fr=f / nl=n control which language texts are searched
  if (language === 'fr') params.set('fr', 'f');
  if (language === 'nl') params.set('nl', 'n');
  if (date) {
    params.set('ddd', date);
    params.set('ddf', date);
  }
  if (titleKeywords) {
    params.set('text1', titleKeywords);
    params.set('chercher', 'c');
  }

  const body = params.toString();
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(EJUSTICE_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      await sleep(REQUEST_DELAY_MS);
      return parseSearchResults(html);
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = REQUEST_DELAY_MS * attempt;
        logInfo(chalk.gray(`    ↻ ejustice fetch attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`));
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

/** Cached wrapper – no extra sleep on a cache hit. */
async function cachedSearchEjustice(dt, date, titleKeywords, language = 'fr') {
  const k = `${dt}|${date || ''}|${titleKeywords || ''}|${language}`;
  if (!_ejusticeSearchCache.has(k)) {
    _ejusticeSearchCache.set(k, await searchEjustice(dt, date, titleKeywords, language));
  }
  return _ejusticeSearchCache.get(k);
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('a.list-item--title').each((_i, el) => {
    const href = $(el).attr('href') || '';
    // numac codes can contain letters (e.g. 2004A31182 for CoBAT)
    const numacMatch = href.match(/numac_search=([A-Za-z0-9]+)/);
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
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const html = await response.text();
      const $ = cheerio.load(html);
      const eli = $('a#link-text').attr('href') || null;
      await sleep(REQUEST_DELAY_MS);
      return eli;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = REQUEST_DELAY_MS * attempt;
        logInfo(chalk.gray(`    ↻ ELI fetch attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`));
        await sleep(delay);
      } else {
        return null;
      }
    }
  }
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

/**
 * Get the OpenAI API key from settings, or prompt the user to enter it.
 * Persists the key to settings.json for future runs.
 */
async function getOrPromptApiKey() {
  const settings = loadSettings();
  if (settings.openai_api_key) return settings.openai_api_key;

  progress.clear();
  console.log('');
  logWarn('  OpenAI API key not found in settings.json.');
  const key = await promptUserFn(chalk.yellow('  Enter your OpenAI API key: ') + chalk.bold('> '));
  const trimmed = key.trim();
  if (!trimmed) return null;

  settings.openai_api_key = trimmed;
  saveSettings(settings);
  return trimmed;
}

/**
 * Ask the configured ChatGPT model to choose among ambiguous eJustice results.
 *
 * @param {Array<{result:{numac:string,title:string},score:number}>} candidates
 * @param {string} key  Full legal-basis key (date + type + title).
 * @param {Array}  elements  Elements from missing_eli.json (each has abstractFR/abstractNL).
 * @returns {Promise<{numac:string, confidence:'high'|'medium'|'low', reasoning:string}|null>}
 */
async function askChatGptToChoose(candidates, key, elements) {
  const apiKey = await getOrPromptApiKey();
  if (!apiKey) return null;

  const settings = loadSettings();
  const model = settings.openai_model || OPENAI_DEFAULT_MODEL;

  // Collect unique abstracts (skip duplicates from the same case cited multiple times)
  const usedAbstracts = new Set();
  const abstractLines = [];
  for (const el of (elements || [])) {
    for (const lang of ['FR', 'NL']) {
      const text = el[`abstract${lang}`];
      if (text && !usedAbstracts.has(text)) {
        usedAbstracts.add(text);
        abstractLines.push(`[${lang}] ${text}`);
      }
    }
  }
  // Cap at 5 abstracts to stay within token limits while giving sufficient context
  const abstractsBlock = abstractLines.slice(0, 5).join('\n\n') || '(no abstracts available)';

  // Full titles — no truncation
  const candidateList = candidates
    .map((c, i) => `${i + 1}. [numac: ${c.result.numac}] ${c.result.title}`)
    .join('\n');

  const systemPrompt =
    'You are a Belgian legal expert. You identify official texts published ' +
    'in the Belgian Official Gazette (Moniteur belge / Belgisch Staatsblad). ' +
    'You reply exclusively with a JSON object — no markdown, no prose outside the JSON.';

  const userPrompt =
    `A Belgian court decision cites the following legal basis:\n` +
    `"${key}"\n\n` +
    `The Belgian Law website (ejustice.just.fgov.be) returned ${candidates.length} candidate text(s). ` +
    `Identify which candidate is the correct text being cited.\n\n` +
    `## Candidates (numac code + full official title):\n${candidateList}\n\n` +
    `## Abstract(s) of the citing court decision(s):\n${abstractsBlock}\n\n` +
    `## Rules:\n` +
    `- Match the legal basis reference (type, date, subject, jurisdiction) to the candidates.\n` +
    `- Jurisdiction clues: Flemish decrees use \u201cConseille flamand\u201d/\u201cVlaamse\u201d, ` +
      `Walloon decrees use \u201cR\u00e9gion wallonne\u201d, Brussels texts use \u201cOrdonnance\u201d etc.\n` +
    `- If two candidates represent the same text (e.g. original vs. coordination copy with a ` +
      `later numac), prefer the original (earliest numac).\n` +
    `- Reply with this exact JSON and nothing else:\n` +
    `{\"choice\": <1-based index>, \"confidence\": \"high\" | \"medium\" | \"low\", \"reasoning\": \"<one concise sentence>\"}`;

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logWarn(`  ⚠ ChatGPT API error ${response.status}: ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logWarn(`  ⚠ ChatGPT returned empty content (finish_reason: ${data.choices?.[0]?.finish_reason || 'unknown'})`);
      return null;
    }

    logInfo(chalk.gray(`    ChatGPT raw response: ${content.substring(0, 300)}`));

    const parsed = JSON.parse(content);
    const idx = parseInt(parsed.choice, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) {
      logWarn(`  ⚠ ChatGPT returned invalid choice=${JSON.stringify(parsed.choice)} (expected 1–${candidates.length}). Full response: ${content.substring(0, 200)}`);
      return null;
    }

    return {
      numac:      candidates[idx - 1].result.numac,
      index:      idx,
      confidence: parsed.confidence || 'low',
      reasoning:  parsed.reasoning || '',
    };
  } catch (err) {
    logWarn(`  ⚠ ChatGPT call failed: ${err.message}`);
    return null;
  }
}

/**
 * Prompt the user to pick one result from a numbered list, skip, or enter a
 * custom ELI/numac.  Returns { eli } on success or null to skip.
 * @param {Array}       candidates
 * @param {string}      key
 * @param {{numac:string, index:number, confidence:string, reasoning:string}|null} aiSuggestion
 */
async function promptUserChoice(candidates, key, aiSuggestion = null) {
  progress.clear();
  console.log('');
  logWarn(`  ⚠ Ambiguous – ${candidates.length} candidates for: ${chalk.cyan(key.substring(0, 100))}`);
  candidates.forEach((c, i) => {
    const score  = typeof c.score === 'number' ? chalk.gray(` [score:${c.score}]`) : '';
    const aiMark = aiSuggestion?.numac === c.result.numac
      ? chalk.blue(` ⭐ ChatGPT [${aiSuggestion.confidence}]`) : '';
    console.log(`    ${chalk.bold(i + 1)}. [${c.result.numac}] ${c.result.title}${score}${aiMark}`);
  });
  if (aiSuggestion) {
    console.log(chalk.blue(`  🤖 ChatGPT reasoning: ${aiSuggestion.reasoning}`));
  }
  console.log(`    ${chalk.bold('s')}. Skip this entry`);
  console.log(`    ${chalk.bold('e')}. Enter ELI or numac manually`);

  const defaultHint = aiSuggestion ? chalk.gray(`Enter=${aiSuggestion.index}/`) : '';
  const resp = await promptUserFn(
    chalk.yellow('  Choose: ') + defaultHint + chalk.gray('(1-' + candidates.length + '/s/e) ') + chalk.bold('> ')
  );
  const respLc = resp.toLowerCase();

  // Empty input → accept AI suggestion as default
  if (resp === '' && aiSuggestion) {
    try {
      const eli = await cachedFetchEli(aiSuggestion.numac);
      return eli ? { eli } : null;
    } catch {
      return null;
    }
  }

  if (respLc === 's' || respLc === 'skip') return null;

  if (respLc === 'e') {
    const custom = await promptUserFn(chalk.yellow('  Enter ELI or numac: ') + chalk.bold('> '));
    const trimmed = custom.trim();
    if (!trimmed) return null;
    // If it looks like a numac, fetch the ELI for it
    if (/^[A-Za-z0-9]+$/.test(trimmed) && !trimmed.startsWith('http')) {
      const eli = await cachedFetchEli(trimmed);
      return eli ? { eli } : null;
    }
    return { eli: trimmed };
  }

  const idx = parseInt(resp, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
    try {
      const eli = await cachedFetchEli(candidates[idx - 1].result.numac);
      return eli ? { eli } : null;
    } catch {
      return null;
    }
  }
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

  // ── Step 1: initial search ──────────────────────────────────────────────────
  let results;
  let effectiveDt = dt;
  try {
    results = isNamedCode
      ? await cachedSearchEjustice(dt, null, null)
      : date ? await cachedSearchEjustice(dt, date, null) : null;
    if (!results) return { eli: null, reason: 'no_date' };
  } catch (err) {
    return { eli: null, reason: `search_error: ${err.message}` };
  }

  // ── Step 2: dt fallback when 0 results ─────────────────────────────────────
  if (results.length === 0 && !isNamedCode && date) {
    const fallbacks = DT_FALLBACKS.get(dt) || [];
    for (const alt of fallbacks) {
      try {
        const alt_results = await cachedSearchEjustice(alt, date, null);
        if (alt_results.length > 0) {
          logInfo(chalk.gray(`    ↳ Retried with dt=${alt} → ${alt_results.length} result(s)`));
          results = alt_results;
          effectiveDt = alt;
          break;
        }
      } catch { /* continue */ }
    }
  }

  if (results.length === 0) return { eli: null, reason: 'no_results' };

  logInfo(chalk.gray(`    [${effectiveDt}] date:${date || 'any'} → ${results.length} result(s)` +
    (results.length <= 5 ? ': ' + results.map(r => r.title.substring(0, 60)).join(' | ') : '')));

  // ── Step 3: single result ───────────────────────────────────────────────────
  if (results.length === 1) {
    try {
      const eli = await cachedFetchEli(results[0].numac);
      return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
    } catch {
      return { eli: null, reason: 'eli_fetch_error' };
    }
  }

  // ── Step 4: named code → find article range ─────────────────────────────────
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

  // ── Step 5: generic type → narrow by FR title keywords ─────────────────────
  const titleKeywords = extractTitleKeywords(key);
  // Most focused candidate set found so far (prefer narrowed over full for user choice)
  let bestCandidates = null;

  if (titleKeywords) {
    let narrowed = [];
    try {
      narrowed = await cachedSearchEjustice(effectiveDt, date, titleKeywords);
      logInfo(chalk.gray(`    FR keyword "${titleKeywords}" → ${narrowed.length} result(s)` +
        (narrowed.length <= 5 ? ': ' + narrowed.map(r => r.title.substring(0, 60)).join(' | ') : '')));
    } catch { /* fall through */ }

    if (narrowed.length === 1) {
      const eli = await cachedFetchEli(narrowed[0].numac);
      return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
    }
    if (narrowed.length > 1) {
      const { best, scored } = scoreResultsByTitle(narrowed, key);
      logInfo(chalk.gray(`    Scores (FR narrowed): ` +
        scored.slice(0, 5).map(s => `${s.score}×"${s.result.title.substring(0, 50)}"`).join(' | ')));
      if (best) {
        const eli = await cachedFetchEli(best.numac);
        return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
      }
      bestCandidates = scored;
    }

    // ── Step 6: NL-language keyword search ────────────────────────────────
    // Useful when the key text is in Dutch but eJustice FR titles don't match.
    let narrowedNl = [];
    try {
      narrowedNl = await cachedSearchEjustice(effectiveDt, date, titleKeywords, 'nl');
      if (narrowedNl.length > 0 && narrowedNl.length !== results.length) {
        logInfo(chalk.gray(`    NL keyword "${titleKeywords}" → ${narrowedNl.length} result(s)` +
          (narrowedNl.length <= 5 ? ': ' + narrowedNl.map(r => r.title.substring(0, 60)).join(' | ') : '')));
      }
    } catch { /* fall through */ }

    if (narrowedNl.length === 1) {
      const eli = await cachedFetchEli(narrowedNl[0].numac);
      return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
    }
    if (narrowedNl.length > 1 && narrowedNl.length < results.length) {
      const { best, scored } = scoreResultsByTitle(narrowedNl, key);
      logInfo(chalk.gray(`    Scores (NL narrowed): ` +
        scored.slice(0, 5).map(s => `${s.score}×"${s.result.title.substring(0, 50)}"`).join(' | ')));
      if (best) {
        const eli = await cachedFetchEli(best.numac);
        return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
      }
      if (!bestCandidates) bestCandidates = scored;
    }

    // ── Step 6b: NL full search (no-kw) scored — handles truncated Dutch keywords ──
    // eJustice requires whole-word matches; a truncated key word like "jeugddelinq"
    // won't match via keyword search. Fetch all NL results and score with includes().
    if (narrowedNl.length === 0 && date) {
      let nlAll = [];
      try {
        nlAll = await cachedSearchEjustice(effectiveDt, date, null, 'nl');
      } catch { /* fall through */ }
      if (nlAll.length > 0) {
        logInfo(chalk.gray(`    NL full (no-kw) → ${nlAll.length} result(s)`));
        const { best: bestNlAll, scored: scoredNlAll } = scoreResultsByTitle(nlAll, key);
        logInfo(chalk.gray(`    Scores (NL full): ` +
          scoredNlAll.slice(0, 5).map(s => `${s.score}×"${s.result.title.substring(0, 50)}"`).join(' | ')));
        if (bestNlAll) {
          const eli = await cachedFetchEli(bestNlAll.numac);
          return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
        }
        if (!bestCandidates) bestCandidates = scoredNlAll;
      }
    }
  }

  // ── Step 7: last-resort scoring on all unnarrowed results ──────────────────
  const { best: bestAll, scored: scoredAll } = scoreResultsByTitle(results, key);
  logInfo(chalk.gray(`    Scores (all ${results.length}): ` +
    scoredAll.slice(0, 5).map(s => `${s.score}×"${s.result.title.substring(0, 50)}"`).join(' | ')));
  if (bestAll) {
    try {
      const eli = await cachedFetchEli(bestAll.numac);
      return eli ? { eli, reason: null } : { eli: null, reason: 'eli_fetch_error' };
    } catch { /* fall through */ }
  }

  // Return the most focused candidate list available for interactive disambiguation
  const candidates = (bestCandidates ?? scoredAll).slice(0, 10);
  return { eli: null, reason: 'ambiguous_multiple_results', candidates };
}

// ─── Data integration ────────────────────────────────────────────────────────

/**
 * Merge an array of elements (all destined for the same ELI) into the
 * appropriate data file.  Loads the file once, applies all changes, writes once.
 */
function storeElementsToDataFile(elements, eli) {
  const filename = eliToFilename(eli);
  let data;
  try {
    data = loadDataFile(filename);
  } catch (err) {
    logError(`  ✗ Could not load data file ${filename}: ${err.message}`);
    data = {};
  }

  function mergeArr(existing, incoming) {
    const arr = Array.isArray(existing) ? [...existing] : (existing ? [existing] : []);
    if (Array.isArray(incoming)) {
      for (const v of incoming) { if (v && !arr.includes(v)) arr.push(v); }
    } else if (incoming && !arr.includes(incoming)) {
      arr.push(incoming);
    }
    return arr.length > 0 ? arr : null;
  }

  for (const element of elements) {
    const article = normalizeArticleNumber(element.article || '') || 'general';
    if (!data[article]) data[article] = {};
    const existing = data[article][element.ecli] || {};
    data[article][element.ecli] = {
      court: element.court,
      date: element.date,
      roleNumber: element.roleNumber,
      sitemap: mergeArr(existing.sitemap, element.sitemap),
      abstractFR: mergeArr(existing.abstractFR, element.abstractFR),
      abstractNL: mergeArr(existing.abstractNL, element.abstractNL),
    };
  }

  try {
    saveDataFile(filename, data);
    logSuccess(`  ✔ Wrote ${elements.length} element(s) to ${filename}`);
  } catch (err) {
    logError(`  ✗ Could not write data file ${filename}: ${err.message}`);
    throw err;
  }
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

  for (let i = 0; i < toProcess.length; i++) {
    const key = toProcess[i];
    const entry = missingEli[key];
    const articles = [...new Set(entry.elements.map(e => e.article).filter(Boolean))];
    const sampleArticle = articles[0] || 'general';

    // 0) Check if this is a split text (codes with multiple ELIs per article range)
    const splitText = findSplitText(key);
    if (splitText) {
      // Build per-article ELI mapping directly from split_texts.json
      const splitPerArticle = new Map();
      for (const elem of entry.elements) {
        const art = elem.article || 'general';
        if (!splitPerArticle.has(art)) {
          const artEli = findEliForArticle(splitText, art);
          if (artEli) splitPerArticle.set(art, artEli);
        }
      }

      if (splitPerArticle.size > 0) {
        // Group elements by their resolved ELI, then write each file once
        const byEli = new Map();
        const remainingElements = [];
        for (const elem of entry.elements) {
          const artEli = splitPerArticle.get(elem.article || 'general');
          if (artEli) {
            if (!byEli.has(artEli)) byEli.set(artEli, []);
            byEli.get(artEli).push(elem);
          } else {
            remainingElements.push(elem);
          }
        }

        progress.clear();
        console.log('');
        logInfo(chalk.bold(`[${i + 1}/${total}]`) + ` ${key}`);
        const uniqueElis = [...new Set(splitPerArticle.values())];
        logInfo(`  Split text: ${uniqueElis.length} part(s) — ${uniqueElis.map(e => chalk.green(e)).join(', ')}`);
        logInfo(`  Elements: ${entry.elements.length} (${remainingElements.length} without article match)`);

        let answer;
        if (applyAll) {
          answer = 'yes';
        } else {
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
          try {
            for (const [artEli, elems] of byEli) {
              storeElementsToDataFile(elems, artEli);
            }
            // Use the most common ELI as the primary for the entry
            const eliCounts = new Map();
            for (const e of splitPerArticle.values()) eliCounts.set(e, (eliCounts.get(e) || 0) + 1);
            const primaryEli = [...eliCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (primaryEli) entry.eli = primaryEli;
            entry.elements = remainingElements;
            saveMissingEliFile(missingEli);
            flushMissingEli();
            resolvedCount++;
          } catch (err) {
            logError(`  ✗ Failed to apply change for "${key}": ${err.message}`);
          }
        } else {
          skippedCount++;
        }

        progress.doneIndexes = i + 1;
        progress.render();
        continue;
      }
      // If no articles resolved (all 'general'), fall through to normal resolution
    }

    // 1) Try log-based resolution (with prefix-map fallback for date-less keys)
    let resolution = resolveFromLog(key, sampleArticle, logEliMap, logPrefixMap);
    let source = 'log.json';

    if (resolution) {
      progress.clear();
      logInfo(`  ✓ [${i + 1}/${total}] Found in log.json: ${chalk.cyan(key.substring(0, 100))}`);
    }

    // 2) Try ejustice website
    if (!resolution) {
      if (isUnfindableOnEjustice(key)) {
        unfindableCount++;
        progress.clear();
        logInfo(`  — [${i + 1}/${total}] Skipped (EU/intl instrument): ${chalk.cyan(key.substring(0, 100))}`);
        progress.doneIndexes = i + 1;
        progress.render();
        continue;
      }

      const dt = detectNatureJuridique(key);
      progress.clear();
      logInfo(`  ⟳ [${i + 1}/${total}] Searching ejustice${dt ? ` [${dt}]` : ''}: ${chalk.cyan(key.substring(0, 80))}${sampleArticle !== 'general' ? chalk.gray(` art.${sampleArticle}`) : ''}`);
      progress.render();

      resolution = await resolveFromEjustice(key, sampleArticle);
      source = 'ejustice';

      if (!resolution?.eli) {
        const reason = resolution?.reason || 'unknown';
        const candidates = resolution?.candidates;

        if (reason === 'unfindable' || reason === 'unknown_nature_juridique') {
          unfindableCount++;
          progress.clear();
          logWarn(`  ✗ [${i + 1}/${total}] Not findable (${reason}): ${chalk.cyan(key.substring(0, 100))}`);
          progress.doneIndexes = i + 1;
          progress.render();
          continue;

        } else if ((reason.includes('ambiguous') || reason === 'code_no_article') && candidates?.length > 0) {
          // ── ChatGPT disambiguation ──────────────────────────────────────────
          logInfo(chalk.gray(`    Asking ChatGPT (model: ${loadSettings().openai_model || OPENAI_DEFAULT_MODEL}) to disambiguate ${candidates.length} candidates...`));
          const aiSuggestion = await askChatGptToChoose(candidates, key, entry.elements);
          if (aiSuggestion) {
            logInfo(chalk.blue(`    🤖 ChatGPT → #${aiSuggestion.index} [${aiSuggestion.numac}] confidence:${aiSuggestion.confidence} — ${aiSuggestion.reasoning}`));
          } else {
            logWarn(chalk.gray(`    ChatGPT did not return a usable suggestion`));
          }

          if (!applyAll && aiSuggestion?.confidence === 'high') {
            // Interactive + high-confidence AI: auto-accept with notice
            const eli = await cachedFetchEli(aiSuggestion.numac);
            if (eli) {
              progress.clear();
              logSuccess(`  ✓ ChatGPT auto-selected [${aiSuggestion.confidence}] #${aiSuggestion.index} [${aiSuggestion.numac}]: ${aiSuggestion.reasoning}`);
              resolution = { eli, confidence: 'ai-high' };
              source = 'chatgpt';
              // fall through to apply logic below
            } else {
              logWarn(`  ⚠ ChatGPT chose numac ${aiSuggestion.numac} but ELI fetch failed — falling back to manual`);
              const chosen = await promptUserChoice(candidates, key, aiSuggestion);
              if (chosen?.eli) {
                resolution = { eli: chosen.eli, confidence: 'user' };
                source = 'user';
              } else {
                ambiguousCount++;
                logInfo(`  ↷ [${i + 1}/${total}] Skipped by user: ${chalk.cyan(key.substring(0, 80))}`);
                progress.doneIndexes = i + 1;
                progress.render();
                continue;
              }
            }
          } else if (!applyAll) {
            // Interactive: no AI or low/medium confidence — show AI suggestion, let user confirm or override
            const chosen = await promptUserChoice(candidates, key, aiSuggestion);
            if (chosen?.eli) {
              resolution = { eli: chosen.eli, confidence: 'user' };
              source = 'user';
              // fall through to apply logic below
            } else {
              ambiguousCount++;
              logInfo(`  ↷ [${i + 1}/${total}] Skipped by user: ${chalk.cyan(key.substring(0, 80))}`);
              progress.doneIndexes = i + 1;
              progress.render();
              continue;
            }
          } else if (aiSuggestion?.confidence === 'high') {
            // Non-interactive (applyAll): apply AI choice only when confidence is high
            const eli = await cachedFetchEli(aiSuggestion.numac);
            if (eli) {
              resolution = { eli, confidence: 'ai-high' };
              source = 'chatgpt';
              // fall through to apply logic below
            } else {
              ambiguousCount++;
              progress.clear();
              logWarn(`  ⚠ [${i + 1}/${total}] ChatGPT chose numac ${aiSuggestion.numac} but ELI fetch failed: ${chalk.cyan(key.substring(0, 80))}`);
              progress.doneIndexes = i + 1;
              progress.render();
              continue;
            }
          } else {
            // Non-interactive, confidence not high enough → keep as ambiguous
            ambiguousCount++;
            progress.clear();
            const confNote = aiSuggestion
              ? chalk.gray(` (ChatGPT: #${aiSuggestion.index} with ${aiSuggestion.confidence} confidence — run interactively to confirm)`)
              : chalk.gray(` (${candidates.length} candidate(s); run interactively to choose)`);
            logWarn(`  ⚠ [${i + 1}/${total}] Ambiguous: ${chalk.cyan(key.substring(0, 80))}${confNote}`);
            progress.doneIndexes = i + 1;
            progress.render();
            continue;
          }

        } else if (reason.includes('ambiguous') || reason.includes('multiple') || reason === 'code_no_article') {
          // Ambiguous but no candidate list returned (can't ask ChatGPT without options)
          ambiguousCount++;
          progress.clear();
          logWarn(`  ⚠ [${i + 1}/${total}] Ambiguous (no candidates): ${chalk.cyan(key.substring(0, 80))} — ${reason}`);
          progress.doneIndexes = i + 1;
          progress.render();
          continue;

        } else {
          skippedCount++;
          progress.clear();
          logWarn(`  ✗ [${i + 1}/${total}] Not found (${reason}): ${chalk.cyan(key.substring(0, 100))}`);
          progress.doneIndexes = i + 1;
          progress.render();
          continue;
        }

        if (!resolution?.eli) {
          progress.doneIndexes = i + 1;
          progress.render();
          continue;
        }
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
    // When the resolution came from an explicit user or AI choice, the
    // disambiguation itself was the confirmation — skip the Apply? prompt so
    // the change is committed immediately and a Ctrl+C doesn't discard it.
    if (applyAll || source === 'user' || source === 'chatgpt') {
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
      // Apply immediately so the change is persisted even if interrupted later
      try {
        if (perArticleElis) {
          // Group elements by their resolved ELI, then write each file once
          const byEli = new Map();
          const remainingElements = [];
          for (const elem of entry.elements) {
            const artEli = perArticleElis.get(elem.article);
            if (artEli) {
              if (!byEli.has(artEli)) byEli.set(artEli, []);
              byEli.get(artEli).push(elem);
            } else {
              remainingElements.push(elem);
            }
          }
          for (const [artEli, elems] of byEli) {
            storeElementsToDataFile(elems, artEli);
          }
          const eliCounts = new Map();
          for (const [, e] of perArticleElis) {
            eliCounts.set(e, (eliCounts.get(e) || 0) + 1);
          }
          const primaryEli = [...eliCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          if (primaryEli) entry.eli = primaryEli;
          entry.elements = remainingElements;
        } else {
          storeElementsToDataFile(entry.elements, eli);
          entry.eli = eli;
          entry.elements = [];
        }
        saveMissingEliFile(missingEli);
        flushMissingEli();
        resolvedCount++;
      } catch (err) {
        logError(`  ✗ Failed to apply change for "${key}": ${err.message}`);
      }
    } else {
      skippedCount++;
    }

    progress.doneIndexes = i + 1;
    progress.render();
  }

  progress.finish();

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
