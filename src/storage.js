import fs from 'fs';
import path from 'path';
import { DATA_DIR, SETTINGS_FILE, MISSING_ELI_FILE, ERRORS_FILE, LOG_FILE } from './constants.js';
import { logInfo, logWarn, timestamp } from './logger.js';

// ─── In-memory caches (deferred writes) ──────────────────────────────────────
// errors.json, log.json, missing_eli.json and settings.json are held in memory
// and flushed to disk only on exit (via flushAll).  ELI data files are still
// written immediately as before.

let _settingsCache = null;
let _errorsCache = null;
let _missingEliCache = null;
let _logCache = null;

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

/**
 * Write missing_eli.json to disk immediately (synchronous).
 * Unlike flushAll(), the in-memory cache is kept alive so future mutations
 * on the same object reference remain valid.
 */
export function flushMissingEli() {
  if (_missingEliCache !== null) {
    fs.writeFileSync(MISSING_ELI_FILE, JSON.stringify(_missingEliCache, null, 2), 'utf-8');
  }
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
    // Merge sitemap array
    if (!Array.isArray(existing.sitemap)) existing.sitemap = existing.sitemap ? [existing.sitemap] : [];
    if (element.sitemap && !existing.sitemap.includes(element.sitemap)) {
      existing.sitemap.push(element.sitemap);
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
