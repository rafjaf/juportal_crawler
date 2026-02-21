import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const ROBOTS_TXT_URL = 'https://juportal.be/robots.txt';
export const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');
export const MISSING_ELI_FILE = path.join(ROOT_DIR, 'missing_eli.json');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const MAX_RETRIES = 10;
export const RETRY_DELAY_MS = 5000;
export const PROGRESS_INTERVAL_MS = 5000;
export const FETCH_TIMEOUT_MS = 30000;

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
