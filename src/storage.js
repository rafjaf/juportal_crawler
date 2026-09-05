import fs from 'fs';
import path from 'path';
import { DATA_DIR, SETTINGS_FILE, MISSING_ELI_FILE, ERRORS_FILE, LOG_FILE, NO_LEGAL_BASIS_FILE } from './constants.js';
import { logInfo, logWarn, timestamp } from './logger.js';

// ─── In-memory caches (deferred writes) ──────────────────────────────────────
// errors.json, log.json, missing_eli.json and settings.json are held in memory
// and flushed to disk only on exit (via flushAll).  ELI data files are still
// written immediately as before.

let _settingsCache = null;
let _errorsCache = null;
let _missingEliCache = null;
let _logCache = null;
let _noLegalBasisCache = null;

function mergeUniqueValues(existing, incoming) {
  const values = Array.isArray(existing) ? [...existing] : (existing ? [existing] : []);
  const additions = Array.isArray(incoming) ? incoming : (incoming ? [incoming] : []);
  for (const value of additions) {
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * Write all deferred in-memory stores to disk.
 * Safe to call from a process 'exit' handler (synchronous).
 */
export function flushAll() {
  const written = [];
  if (_settingsCache !== null) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(_settingsCache, null, 2), 'utf-8');
    written.push('settings.json');
    _settingsCache = null;
  }
  if (_errorsCache !== null) {
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(_errorsCache, null, 2), 'utf-8');
    written.push('errors.json');
    _errorsCache = null;
  }
  if (_missingEliCache !== null) {
    fs.writeFileSync(MISSING_ELI_FILE, JSON.stringify(_missingEliCache, null, 2), 'utf-8');
    written.push('missing_eli.json');
    _missingEliCache = null;
  }
  if (_logCache !== null) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(_logCache, null, 2), 'utf-8');
    written.push('log.json');
    _logCache = null;
  }
  if (_noLegalBasisCache !== null) {
    fs.writeFileSync(NO_LEGAL_BASIS_FILE, JSON.stringify(_noLegalBasisCache, null, 2), 'utf-8');
    written.push('no_legal_basis.json');
    _noLegalBasisCache = null;
  }
  if (written.length > 0) {
    console.log(`\u2714 Saved to disk: ${written.join(', ')}`);
  }
}

// ─── Settings Management ─────────────────────────────────────────────────────

export function loadSettings() {
  if (_settingsCache !== null) return _settingsCache;
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      _settingsCache = JSON.parse(raw);
      return _settingsCache;
    }
  } catch (err) {
    logWarn(`⚠ Could not read settings.json, starting fresh: ${err.message}`);
  }
  _settingsCache = { processedSitemapIndexes: [], processedSitemaps: [] };
  return _settingsCache;
}

/** Updates in-memory cache only — written to disk on exit via flushAll(). */
export function saveSettings(settings) {
  _settingsCache = settings;
}

// ─── Data File Management ────────────────────────────────────────────────────

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logInfo(`${timestamp()} Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Scan all data/*.json files and collect every ECLI key that appears in them.
 * Returns a Set<string> of known ECLI identifiers.
 * Used by --redo to skip judgements that already have data saved.
 */
export function buildProcessedEcliSet() {
  const ecliSet = new Set();
  if (!fs.existsSync(DATA_DIR)) return ecliSet;
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
      for (const article of Object.values(data)) {
        if (article && typeof article === 'object') {
          for (const ecli of Object.keys(article)) {
            ecliSet.add(ecli);
          }
        }
      }
    } catch {
      // Silently skip unreadable files
    }
  }
  return ecliSet;
}

export function loadDataFile(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    logWarn(`⚠ Could not read data file ${filename}: ${err.message}`);
  }
  return {};
}

export function saveDataFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Missing ELI File Management ────────────────────────────────────────────

export function loadMissingEliFile() {
  if (_missingEliCache !== null) return _missingEliCache;
  try {
    if (fs.existsSync(MISSING_ELI_FILE)) {
      _missingEliCache = JSON.parse(fs.readFileSync(MISSING_ELI_FILE, 'utf-8'));
      return _missingEliCache;
    }
  } catch (err) {
    logWarn(`⚠ Could not read missing_eli.json, starting fresh: ${err.message}`);
  }
  _missingEliCache = {};
  return _missingEliCache;
}

/** Updates in-memory cache only — written to disk on exit via flushAll(). */
export function saveMissingEliFile(data) {
  _missingEliCache = data;
}

// ─── Parse Error File Management ────────────────────────────────────────────

export function loadErrorsFile() {
  if (_errorsCache !== null) return _errorsCache;
  try {
    if (fs.existsSync(ERRORS_FILE)) {
      _errorsCache = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf-8'));
      return _errorsCache;
    }
  } catch { /* start fresh */ }
  _errorsCache = {};
  return _errorsCache;
}

/** Updates in-memory cache only — written to disk on exit via flushAll(). */
export function saveErrorsFile(data) {
  _errorsCache = data;
}

/**
 * Append an unextractable legal-basis text to errors.json.
 * Keyed by sitemapUrl so the source is always traceable.
 * Duplicate entries for the same URL+text are silently ignored.
 */
export function appendParseError(sitemapUrl, rawText) {
  const data = loadErrorsFile();
  if (!data[sitemapUrl]) data[sitemapUrl] = [];
  if (!data[sitemapUrl].includes(rawText)) {
    data[sitemapUrl].push(rawText);
    saveErrorsFile(data);
  }
}

export function appendMissingEli(rawLegalBasisText, element) {
  const data = loadMissingEliFile();
  const key = rawLegalBasisText;
  if (!data[key]) {
    data[key] = {
      eli: null,
      elements: [],
    };
  }

  // Look for an existing element with the same ecli + article to merge sitemaps
  const existing = data[key].elements.find(e =>
    e.ecli === element.ecli && e.article === element.article
  );

  if (existing) {
    existing.sitemap = mergeUniqueValues(existing.sitemap, element.sitemap);
    existing.abstractFR = mergeUniqueValues(existing.abstractFR, element.abstractFR);
    existing.abstractNL = mergeUniqueValues(existing.abstractNL, element.abstractNL);
    existing.judgementUrls = mergeUniqueValues(existing.judgementUrls, element.judgementUrls);
    existing.rollNumberSystem ??= element.rollNumberSystem ?? null;
    if (Object.prototype.hasOwnProperty.call(element, 'matterFromRollNumber')) {
      existing.matterFromRollNumber = element.matterFromRollNumber;
    }
  } else {
    data[key].elements.push({
      ...element,
      sitemap: element.sitemap ? [element.sitemap] : [],
    });
  }
  saveMissingEliFile(data);
}

// ─── Log File Management ─────────────────────────────────────────────────────

export function loadLogFile() {
  if (_logCache !== null) return _logCache;
  try {
    if (fs.existsSync(LOG_FILE)) {
      _logCache = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
      return _logCache;
    }
  } catch { /* start fresh */ }
  _logCache = {};
  return _logCache;
}

/** Updates in-memory cache only — written to disk on exit via flushAll(). */
export function saveLogFile(data) {
  _logCache = data;
}

/**
 * Append a timestamped entry to log.json.
 * @param {Object} entry - All judgement information to log.
 */
export function appendLogEntry(entry) {
  const data = loadLogFile();
  const key = new Date().toISOString();
  data[key] = entry;
  saveLogFile(data);
}

// ─── No Legal Basis File Management ─────────────────────────────────────────

export function loadNoLegalBasisFile() {
  if (_noLegalBasisCache !== null) return _noLegalBasisCache;
  try {
    if (fs.existsSync(NO_LEGAL_BASIS_FILE)) {
      _noLegalBasisCache = JSON.parse(fs.readFileSync(NO_LEGAL_BASIS_FILE, 'utf-8'));
      return _noLegalBasisCache;
    }
  } catch { /* start fresh */ }
  _noLegalBasisCache = [];
  return _noLegalBasisCache;
}

/**
 * Append a judgement with no legal bases found to no_legal_basis.json.
 * Duplicates (same ECLI) are silently ignored.
 */
export function appendNoLegalBasis(entry) {
  const data = loadNoLegalBasisFile();
  const existing = data.find(e => e.ecli === entry.ecli);
  if (!existing) {
    data.push({
      ...entry,
      urls: mergeUniqueValues(entry.urls, entry.url),
    });
    return;
  }

  existing.url ||= entry.url || null;
  existing.urls = mergeUniqueValues(existing.urls || existing.url, entry.urls || entry.url);
  existing.roleNumber ||= entry.roleNumber || null;
  existing.rollNumberSystem ??= entry.rollNumberSystem ?? null;
  if (Object.prototype.hasOwnProperty.call(entry, 'matterFromRollNumber')) {
    existing.matterFromRollNumber = entry.matterFromRollNumber;
  }
}
