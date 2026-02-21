import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const ROBOTS_TXT_URL = 'https://juportal.be/robots.txt';
export const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');
export const MISSING_ELI_FILE = path.join(ROOT_DIR, 'missing_eli.json');
export const ERRORS_FILE = path.join(ROOT_DIR, 'errors.json');
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
 *   "... - DD-MM-YYYY - [optional prefix] Artt?. <articles> - NN[suffix]"
 * Capture group 1: the article(s) portion (e.g. "17, 27 en 37").
 */
export const RE_ART_REF_WITH_COUNTER =
  /\d{2}-\d{2}-\d{4}\s*-\s*(?:\w+\s+)*Aa*rtt?\.\s*(.+?)\s*-\s*\d+\w*\s*$/i;

/**
 * Fallback for legal-basis references without a trailing counter.
 * Capture group 1: the article(s) portion.
 */
export const RE_ART_REF_NO_COUNTER =
  /\d{2}-\d{2}-\d{4}\s*-\s*(?:\w+\s+)*Aa*rtt?\.\s*(.+?)\s*$/i;

/**
 * Detects a general legal principle (no date, no article number, no ELI).
 * e.g. "Principe général du droit ...", "Algemeen rechtsbeginsel ..."
 */
export const RE_LEGAL_PRINCIPLE =
  /^(Principe général du droit|Algemeen rechtsbeginsel)\b/i;

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
