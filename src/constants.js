import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const ROBOTS_TXT_URL = 'https://juportal.be/robots.txt';
export const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');
export const MISSING_ELI_FILE = path.join(ROOT_DIR, 'missing_eli.json');
export const ERRORS_FILE = path.join(ROOT_DIR, 'errors.json');
export const LOG_FILE = path.join(ROOT_DIR, 'log.json');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const MAX_RETRIES = 10;
export const RETRY_DELAY_MS = 5000;
export const PROGRESS_INTERVAL_MS = 5000;
export const FETCH_TIMEOUT_MS = 30000;

/**
 * Maximum number of sitemap URLs whose judgement pages can be fetched
 * concurrently within a single sitemap index. File writes (commits) are
 * always serialised so there is no risk of data-file corruption.
 */
export const SITEMAP_CONCURRENCY = 5;

// ─── Shared Regexes ──────────────────────────────────────────────────────────

/**
 * Matches a legal-basis article reference that has a trailing counter:
 *   "... - DD-MM-YYYY - [optional prefix] Art. <articles> - NN [suffix]"
 * Capture group 1: the article(s) portion (e.g. "17, 27 en 37").
 *
 * Improvements over the original:
 *  - Prefix before Art. is now `(?:.*?\s+)?(?:[ld]')?` to handle qualifiers
 *    containing non-word chars (e.g. "Protocole n° 1,") and French elision
 *    forms such as "l'art." or "d'art.".
 *  - Art. keyword broadened to `A(?:r?t+|r)\.` to also match abbreviated
 *    forms `Ar.`, `At.` found in practice.
 *  - Trailing counter broadened to `\d{2,}\b.*$` so variants like
 *    "30 Lien ELI No pub 1980121550" and "30 Lien DB Justel …" are accepted,
 *    and single-digit article suffixes like "577-7" are not mistaken for
 *    the trailing publication counter (all known counters are 2+ digits).
 */
export const RE_ART_REF_WITH_COUNTER =
  /\d{2}-\d{2}-\d{4}\s*-\s*(?:.*?\s+)?(?:[ld]')?A(?:r?t+|r)\.\s*(.+?)\s*-\s*\d{2,}\b.*$/i;

/**
 * Fallback for legal-basis references without a trailing counter.
 * Capture group 1: the article(s) portion.
 * Same prefix/Art. improvements as RE_ART_REF_WITH_COUNTER.
 */
export const RE_ART_REF_NO_COUNTER =
  /\d{2}-\d{2}-\d{4}\s*-\s*(?:.*?\s+)?(?:[ld]')?A(?:r?t+|r)\.\s*(.+?)\s*$/i;

/**
 * Matches a legal-basis reference that contains "Art." but no date.
 * e.g. "Règlement d'organisation ... - Art. 41, 1°, 4°"
 *      "Besluit van de Raad ... - Art. 5.4.3.4. Bijlage A"
 * Capture group 1: the article(s) portion.
 */
export const RE_ART_REF_NO_DATE =
  /\s*-\s*(?:.*?\s+)?(?:[ld]')?A(?:r?t+|r)\.\s*(.+?)\s*$/i;

/**
 * Matches a legal-basis reference that has a date but NO article reference.
 * Used to detect law references without a specific article → article = "general".
 * e.g. "L. du 15 décembre 1980 ... - 15-12-1980 - 30 Lien ELI No pub 1980121550"
 *      "Directive 2014/41/UE ... - 03-04-2014"
 * The optional trailing group handles the " - NN [text]" counter.
 */
export const RE_REF_NO_ART =
  /\d{2}-\d{2}-\d{4}\s*(?:-\s*\d+\b.*)?$/i;

/**
 * Detects a general legal principle (no date, no article number, no ELI).
 * e.g. "Principe général du droit ...", "Algemeen rechtsbeginsel ...",
 *      "Legaliteitsbeginsel" (and any other Dutch word ending in -beginsel,
 *      optionally preceded by a single qualifier word such as "Algemeen").
 */
export const RE_LEGAL_PRINCIPLE =
  /^(Principe général du droit|(?:\w+\s+)?\w*beginsel)\b/i;

/**
 * Map Dutch document type names in Belgian ELI paths to their French equivalents.
 * Used to canonicalize all ELI references to the French form.
 */
export const ELI_TYPE_NL_TO_FR = {
  'wet': 'loi',
  'grondwet': 'constitution',
  'decreet': 'decret',
  'ordonnantie': 'ordonnance',
  'bijzondere-wet': 'loi-speciale',
  'wetboek': 'code',
  'besluit': 'arrete',
};
