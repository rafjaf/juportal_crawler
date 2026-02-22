import fs from 'fs';
import path from 'path';
import { DATA_DIR, SETTINGS_FILE, MISSING_ELI_FILE, ERRORS_FILE } from './constants.js';
import { logInfo, logWarn, timestamp } from './logger.js';

// ─── Settings Management ─────────────────────────────────────────────────────

export function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logWarn(`⚠ Could not read settings.json, starting fresh: ${err.message}`);
  }
  return { processedSitemapIndexes: [], processedSitemaps: [] };
}

export function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
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
  try {
    if (fs.existsSync(MISSING_ELI_FILE)) {
      return JSON.parse(fs.readFileSync(MISSING_ELI_FILE, 'utf-8'));
    }
  } catch (err) {
    logWarn(`⚠ Could not read missing_eli.json, starting fresh: ${err.message}`);
  }
  return {};
}

export function saveMissingEliFile(data) {
  fs.writeFileSync(MISSING_ELI_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Parse Error File Management ────────────────────────────────────────────

export function loadErrorsFile() {
  try {
    if (fs.existsSync(ERRORS_FILE)) {
      return JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf-8'));
    }
  } catch { /* start fresh */ }
  return {};
}

export function saveErrorsFile(data) {
  fs.writeFileSync(ERRORS_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

  const duplicate = data[key].elements.some(existing => (
    existing.ecli === element.ecli
    && existing.article === element.article
    && existing.url === element.url
    && existing.abstractFR === element.abstractFR
    && existing.abstractNL === element.abstractNL
  ));

  if (!duplicate) {
    data[key].elements.push(element);
  }
  saveMissingEliFile(data);
}
