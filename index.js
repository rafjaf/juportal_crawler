#!/usr/bin/env node

/**
 * Juportal Crawler
 * 
 * Crawls the Juportal website (juportal.be) to extract structured legal data
 * from Belgian Court of Cassation (CASS) judgements.
 * 
 * Data is extracted from sitemaps listed in robots.txt, processed from most 
 * recent to oldest. Results are exported as JSON files organized by ELI.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import xml2js from 'xml2js';
import * as cheerio from 'cheerio';

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROBOTS_TXT_URL = 'https://juportal.be/robots.txt';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DATA_DIR = path.join(__dirname, 'data');
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;
const PROGRESS_INTERVAL_MS = 5000;
const FETCH_TIMEOUT_MS = 30000;

// ─── ELI Language Normalization ──────────────────────────────────────────────

/**
 * Map Dutch document type names in Belgian ELI paths to their French equivalents.
 * Used to canonicalize all ELI references to the French form.
 */
const ELI_TYPE_NL_TO_FR = {
  'wet': 'loi',
  'grondwet': 'constitution',
  'decreet': 'decret',
  'ordonnantie': 'ordonnance',
  'bijzondere-wet': 'loi-speciale',
  'wetboek': 'code',
  'besluit': 'arrete',
};

// ─── Logging Helpers ─────────────────────────────────────────────────────────

function logInfo(...args) {
  console.log(...args);
}

function logSuccess(...args) {
  console.log(chalk.green(...args));
}

function logWarn(...args) {
  console.log(chalk.yellow(...args));
}

function logError(...args) {
  console.log(chalk.red(...args));
}

function logFatal(...args) {
  console.error(chalk.bgRed.white.bold(' FATAL '), chalk.red(...args));
}

function timestamp() {
  return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
}

// ─── Settings Management ─────────────────────────────────────────────────────

function loadSettings() {
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

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// ─── Data File Management ────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logInfo(`${timestamp()} Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Converts an ELI or cgi_loi URL to a safe filename.
 * e.g. https://www.ejustice.just.fgov.be/eli/loi/1984/06/28/1984900065/justel
 *   → eli_loi_1984_06_28_1984900065_justel.json
 * e.g. https://www.ejustice.just.fgov.be/cgi_loi/change_lg.pl?table_name=loi&cn=1966121931
 *   → cgi_loi_loi_1966121931.json
 */
function eliToFilename(eli) {
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

function loadDataFile(filename) {
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

function saveDataFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── HTTP Fetch with Retry ───────────────────────────────────────────────────

/**
 * Fetch a URL with retry logic and progress reporting.
 * Shows a message every PROGRESS_INTERVAL_MS to indicate the app is alive.
 */
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    // Progress timer: print a dot every 5s to show we're alive
    let elapsed = 0;
    const progressTimer = setInterval(() => {
      elapsed += PROGRESS_INTERVAL_MS / 1000;
      logInfo(chalk.gray(`  ... still waiting for response (${elapsed}s) - ${url}`));
    }, PROGRESS_INTERVAL_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearInterval(progressTimer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (err) {
      clearTimeout(timeoutId);
      clearInterval(progressTimer);

      if (attempt < retries) {
        logWarn(`⚠ Attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
        logInfo(chalk.gray(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`));
        await sleep(RETRY_DELAY_MS);
      } else {
        logError(`✖ All ${retries} attempts failed for ${url}: ${err.message}`);
        throw err;
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── robots.txt Parsing ──────────────────────────────────────────────────────

/**
 * Parse robots.txt and extract sitemap index URLs, sorted most recent first.
 */
async function fetchSitemapIndexUrls() {
  logInfo(`${timestamp()} Fetching robots.txt from ${ROBOTS_TXT_URL}...`);
  const text = await fetchWithRetry(ROBOTS_TXT_URL);
  
  const lines = text.split('\n');
  const sitemapUrls = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Sitemap:')) {
      const url = trimmed.replace('Sitemap:', '').trim();
      sitemapUrls.push(url);
    }
  }

  logSuccess(`✔ Found ${sitemapUrls.length} sitemap index URLs in robots.txt`);
  
  // Sort by date descending (most recent first)
  // URL format: .../YYYY/MM/DD/sitemap_index_N.xml
  sitemapUrls.sort((a, b) => {
    const dateA = extractDateFromUrl(a);
    const dateB = extractDateFromUrl(b);
    return dateB.localeCompare(dateA);
  });

  return sitemapUrls;
}

/**
 * Extract a date string (YYYY/MM/DD) from a sitemap URL for sorting.
 */
function extractDateFromUrl(url) {
  const match = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return '0000-00-00';
}

// ─── Sitemap Index Parsing ───────────────────────────────────────────────────

/**
 * Fetch a sitemap index and return the list of sitemap URLs it contains.
 */
async function fetchSitemapUrls(sitemapIndexUrl) {
  const xml = await fetchWithRetry(sitemapIndexUrl);
  const result = await xml2js.parseStringPromise(xml, { explicitArray: false });
  
  const sitemapIndex = result.sitemapindex;
  if (!sitemapIndex || !sitemapIndex.sitemap) {
    logWarn(`⚠ No sitemaps found in ${sitemapIndexUrl}`);
    return [];
  }

  // Ensure it's an array
  const sitemaps = Array.isArray(sitemapIndex.sitemap) 
    ? sitemapIndex.sitemap 
    : [sitemapIndex.sitemap];

  return sitemaps.map(s => s.loc).filter(Boolean);
}

// ─── Sitemap XML Parsing ─────────────────────────────────────────────────────

/**
 * Parse a sitemap XML and extract judgement data.
 * Returns null if the judgement is not from CASS court.
 */
async function parseSitemapXml(sitemapUrl) {
  const xml = await fetchWithRetry(sitemapUrl);
  const result = await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    tagNameProcessors: [name => name.replace(/^ecli:/, '')],
    attrNameProcessors: [],
  });

  const urlset = result.urlset;
  if (!urlset || !urlset.url) {
    logWarn(`⚠ No URL entry found in ${sitemapUrl}`);
    return null;
  }

  const urlEntry = urlset.url;
  const doc = urlEntry.document;
  if (!doc || !doc.metadata) {
    logWarn(`⚠ No ecli:document/metadata found in ${sitemapUrl}`);
    return null;
  }

  const meta = doc.metadata;

  // ─── Court check ───
  const isVersionOf = meta.isVersionOf;
  const court = isVersionOf?.court;
  if (court !== 'CASS') {
    return { skipped: true, court };
  }

  // ─── ECLI ───
  const ecli = isVersionOf?.$?.value || isVersionOf?.value;

  // ─── Date ───
  const judgementDate = meta.date;

  // ─── Identifiers (URLs) ───
  // We want the one with type="summarised"
  const identifiers = Array.isArray(meta.identifier) ? meta.identifier : [meta.identifier];
  let judgementUrl = null;
  for (const id of identifiers) {
    if (id?.$?.type === 'summarised') {
      judgementUrl = id._ || id;
      break;
    }
  }
  // Fallback: use first identifier if no summarised found
  if (!judgementUrl && identifiers.length > 0) {
    const first = identifiers[0];
    judgementUrl = first?._ || first;
    logWarn(`⚠ No 'summarised' identifier found, using first identifier for ${ecli}`);
  }

  // ─── Abstracts ───
  const abstractsFR = [];
  const abstractsNL = [];
  const rawAbstracts = meta.abstract;
  if (rawAbstracts) {
    const abstracts = Array.isArray(rawAbstracts) ? rawAbstracts : [rawAbstracts];
    for (const abs of abstracts) {
      const lang = abs?.$?.lang;
      const text = normalizeWhitespace(abs?._ || abs || '');
      if (!text) continue;
      if (lang === 'fr') {
        abstractsFR.push(text);
      } else if (lang === 'nl') {
        abstractsNL.push(text);
      }
    }
  }

  // ─── References: role number, legal bases with ELI ───
  let roleNumber = null;
  const legalBases = []; // { article, eli }
  
  const rawRefs = meta.reference;
  if (rawRefs) {
    const refs = Array.isArray(rawRefs) ? rawRefs : [rawRefs];
    
    // Parse references - ELI follows the article(s) it applies to
    // We need to track the current "law" group to associate articles with their ELI
    let currentArticles = []; // articles pending an ELI assignment
    let currentLawKey = null; // the law descriptor to group articles
    
    for (const ref of refs) {
      const type = ref?.$?.type;
      const lang = ref?.$?.lang;
      // Collapse internal whitespace so multiline XML text values match cleanly
      const text = normalizeWhitespace((ref?._ || ref || '').toString());

      if (type === 'OTHER') {
        // Check for role number
        if (text.startsWith('Numéro de rôle') || text.startsWith('Rolnummer')) {
          roleNumber = text.replace(/^(Numéro de rôle|Rolnummer)\s*/, '').trim();
          continue;
        }

        // Check if it's a URL (not an article reference)
        if (text.startsWith('http://') || text.startsWith('https://')) {
          // This is a non-ELI law URL (e.g. ejustice.just.fgov.be/cgi_loi/...)
          // Treat it similarly to an ELI for the pending articles
          if (currentArticles.length > 0) {
            for (const art of currentArticles) {
              art.eli = text;
            }
            legalBases.push(...currentArticles);
            currentArticles = [];
            currentLawKey = null;
          }
          continue;
        }

        // Parse article reference: "Law name - DD-MM-YYYY - Art. X - NN"
        const artMatch = text.match(/^(.+?)\s*-\s*\d{2}-\d{2}-\d{4}\s*-\s*Art\.\s*(.+?)\s*-\s*\d+\s*$/);
        if (artMatch) {
          const lawName = artMatch[1].trim();
          const rawArticles = artMatch[2].trim();
          
          const articles = parseArticleNumbers(rawArticles);
          
          // Build a law identifier key
          const newLawKey = lawName;
          
          if (newLawKey !== currentLawKey) {
            // New law group - if we had pending articles without ELI, save them
            if (currentArticles.length > 0) {
              legalBases.push(...currentArticles);
            }
            currentArticles = [];
            currentLawKey = newLawKey;
          }
          
          for (const art of articles) {
            currentArticles.push({ article: art, eli: null, lang: lang || 'fr' });
          }
          continue;
        }
      }

      if (type === 'ELI') {
        // This ELI applies to all currentArticles
        if (currentArticles.length > 0) {
          for (const art of currentArticles) {
            art.eli = text;
          }
          legalBases.push(...currentArticles);
          currentArticles = [];
          currentLawKey = null;
        }
        continue;
      }
    }

    // Flush remaining articles (those without an ELI)
    if (currentArticles.length > 0) {
      legalBases.push(...currentArticles);
    }
  }

  // Deduplicate legal bases (same article + same ELI), keep only those with a resolvable ELI
  const seenBases = new Set();
  const uniqueBases = [];
  for (const lb of legalBases) {
    if (!lb.eli) continue;

    let eli = lb.eli;
    if (eli.includes('/eli/')) {
      // Normalize to French document type
      eli = normalizeEliToFrench(eli);
    } else if (eli.startsWith('http://') || eli.startsWith('https://')) {
      // Normalize cgi_wet → cgi_loi; keep cgi_loi as-is
      const normalized = normalizeCgiUrl(eli);
      if (!normalized) continue; // not a recognized cgi URL, skip
      eli = normalized;
    } else {
      continue;
    }

    const key = `${lb.article}|${eli}`;
    if (!seenBases.has(key)) {
      seenBases.add(key);
      uniqueBases.push({ ...lb, eli });
    }
  }

  return {
    skipped: false,
    court,
    ecli,
    judgementDate,
    judgementUrl,
    roleNumber,
    abstractsFR,
    abstractsNL,
    legalBases: uniqueBases,
  };
}

/**
 * Parse article numbers from a string like "23/1" or "2, § 1er".
 * Returns an array of article strings.
 */
function parseArticleNumbers(raw) {
  // The raw string is everything between "Art." and the trailing "- NN" number
  // Examples: "23", "23/1", "2, § 1er", "149, alinéa 1er", "1382"
  // We treat it as a single article reference (commas are part of the article ref)
  // unless there are clear separators like " et " or " en "
  return [normalizeArticleNumber(raw.trim())];
}

/**
 * Normalize an article reference to its base number only.
 * Strips sub-paragraph qualifiers (§ N, alinéa, lid, .digit, etc.).
 * Examples: "14, § 7" → "14", "14.7" → "14", "235bis" → "235bis", "23/1" → "23/1"
 */
function normalizeArticleNumber(art) {
  return art
    .replace(/,.*$/, '')       // "14, § 7" → "14"
    .replace(/\.([0-9]).*$/, '') // "14.7" → "14"
    .trim();
}

/**
 * Normalize whitespace in text: collapse multiple spaces/newlines into single space.
 */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a Belgian ELI URL to always use French document type terminology.
 * e.g. https://.../eli/wet/... → https://.../eli/loi/...
 */
function normalizeEliToFrench(eli) {
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
function normalizeCgiUrl(url) {
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
 * Migrate any NL-language ELI data files into their French equivalents.
 * Called once at startup to consolidate data from previous runs.
 */
function migrateNlEliFiles() {
  if (!fs.existsSync(DATA_DIR)) return;

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  let migrated = 0;

  for (const filename of files) {
    // Filenames: eli_<doctype>_YYYY_MM_DD_<id>_justel.json
    const withoutExt = filename.slice(0, -5);
    const parts = withoutExt.split('_');

    if (parts[0] !== 'eli' || parts.length < 3) continue;

    const docType = parts[1];
    const normalizedType = ELI_TYPE_NL_TO_FR[docType];
    if (!normalizedType) continue; // already French or unknown type

    const normalizedFilename = `eli_${normalizedType}_${parts.slice(2).join('_')}.json`;
    if (normalizedFilename === filename) continue; // no change needed

    // Merge NL file into FR file, combining abstract arrays from both
    const nlData = loadDataFile(filename);
    const frData = loadDataFile(normalizedFilename);

    for (const [article, ecliMap] of Object.entries(nlData)) {
      if (!frData[article]) frData[article] = {};
      for (const [ecli, nlJudgement] of Object.entries(ecliMap)) {
        if (!frData[article][ecli]) {
          frData[article][ecli] = nlJudgement;
        } else {
          // Both sides may have abstracts — keep all unique values
          const fr = frData[article][ecli];
          const nlFR = Array.isArray(nlJudgement.abstractFR) ? nlJudgement.abstractFR : (nlJudgement.abstractFR ? [nlJudgement.abstractFR] : []);
          const nlNL = Array.isArray(nlJudgement.abstractNL) ? nlJudgement.abstractNL : (nlJudgement.abstractNL ? [nlJudgement.abstractNL] : []);
          for (const abs of nlFR) fr.abstractFR = mergeAbstractArrays(fr.abstractFR, abs);
          for (const abs of nlNL) fr.abstractNL = mergeAbstractArrays(fr.abstractNL, abs);
        }
      }
    }

    saveDataFile(normalizedFilename, frData);
    fs.unlinkSync(path.join(DATA_DIR, filename));
    migrated++;
    logSuccess(`✔ Migrated ${filename} → ${normalizedFilename}`);
  }

  if (migrated > 0) {
    logSuccess(`✔ Migrated ${migrated} NL ELI data file(s) to FR equivalents`);
  }
}

/**
 * Convert legacy scalar abstract values (string | null) to arrays in all data files.
 * Safe to run repeatedly — already-array values are left untouched.
 */
function migrateAbstractsToArrays() {
  if (!fs.existsSync(DATA_DIR)) return;

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  let migrated = 0;

  for (const filename of files) {
    const data = loadDataFile(filename);
    let changed = false;

    for (const ecliMap of Object.values(data)) {
      for (const judgement of Object.values(ecliMap)) {
        if (typeof judgement.abstractFR === 'string') {
          judgement.abstractFR = [judgement.abstractFR];
          changed = true;
        }
        if (typeof judgement.abstractNL === 'string') {
          judgement.abstractNL = [judgement.abstractNL];
          changed = true;
        }
      }
    }

    if (changed) {
      saveDataFile(filename, data);
      migrated++;
    }
  }

  if (migrated > 0) {
    logSuccess(`✔ Migrated ${migrated} data file(s): converted scalar abstracts to arrays`);
  }
}

/**
 * Normalize article keys in existing data files (apply normalizeArticleNumber).
 * Merges entries with equivalent article keys (e.g. "14, § 7" and "14.7" → "14").
 * Safe to run repeatedly.
 */
function migrateArticleKeys() {
  if (!fs.existsSync(DATA_DIR)) return;

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  let migrated = 0;

  for (const filename of files) {
    const data = loadDataFile(filename);
    const normalized = {};
    let changed = false;

    for (const [article, ecliMap] of Object.entries(data)) {
      const normArticle = normalizeArticleNumber(article);
      if (normArticle !== article) changed = true;

      if (!normalized[normArticle]) {
        normalized[normArticle] = {};
      }
      // Merge ecliMap into normalized[normArticle], combining abstract arrays
      for (const [ecli, judgement] of Object.entries(ecliMap)) {
        if (!normalized[normArticle][ecli]) {
          normalized[normArticle][ecli] = judgement;
        } else {
          const existing = normalized[normArticle][ecli];
          const nlFR = Array.isArray(judgement.abstractFR) ? judgement.abstractFR : (judgement.abstractFR ? [judgement.abstractFR] : []);
          const nlNL = Array.isArray(judgement.abstractNL) ? judgement.abstractNL : (judgement.abstractNL ? [judgement.abstractNL] : []);
          for (const abs of nlFR) existing.abstractFR = mergeAbstractArrays(existing.abstractFR, abs);
          for (const abs of nlNL) existing.abstractNL = mergeAbstractArrays(existing.abstractNL, abs);
        }
      }
    }

    if (changed) {
      saveDataFile(filename, normalized);
      migrated++;
    }
  }

  if (migrated > 0) {
    logSuccess(`✔ Migrated ${migrated} data file(s): normalized article keys`);
  }
}

// ─── Judgement Page Parsing ──────────────────────────────────────────────────

/**
 * Labels used for legal bases in different languages.
 */
const LEGAL_BASES_LABELS = ['Bases légales:', 'Wettelijke bepalingen:'];

/**
 * Fetch and parse a judgement page to determine which abstract goes with which legal basis.
 * Returns an array of { abstract, legalBases: [{article, eli}] }
 */
async function parseJudgementPage(judgementUrl) {
  logInfo(`${timestamp()} Downloading judgement page: ${judgementUrl}`);
  const html = await fetchWithRetry(judgementUrl);
  const $ = cheerio.load(html);

  const fiches = [];

  // Each fieldset with "Fiche(s) N" legend groups an abstract with its legal bases
  $('fieldset').each((_, fieldset) => {
    const $fieldset = $(fieldset);
    const legend = $fieldset.find('legend').first().text().trim();
    
    // Check if this is a "Fiche" or "Fiches" fieldset
    if (!legend.startsWith('Fiche')) return;

    // Extract abstract text from the div inside the fieldset  
    const abstractDiv = $fieldset.children('div').first();
    const abstractText = normalizeWhitespace(abstractDiv.text());
    if (!abstractText) return;

    // Extract legal bases from "Bases légales:" / "Wettelijke bepalingen:" rows
    const basesLegales = [];
    $fieldset.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const $labelTd = $tr.find('td').first();
      const label = $labelTd.find('p').text().trim();
      
      // Check if this row contains legal bases (FR or NL label)
      if (!LEGAL_BASES_LABELS.includes(label)) return;

      const $descTd = $labelTd.next('td');
      if (!$descTd.length) return;

      // Find all ELI links and their associated text
      const descHtml = $descTd.find('p.description-notice-table').html();
      if (!descHtml) return;

      // Split by <br> to get individual legal basis entries
      const entries = descHtml.split(/<br\s*\/?>/i);
      for (const entry of entries) {
        const $entry = cheerio.load(entry);
        const text = normalizeWhitespace($entry.root().text());

        // Prefer a proper ELI link; fall back to cgi_loi / cgi_wet link
        let eliLink = normalizeEliToFrench($entry('a[href*="/eli/"]').attr('href'));
        if (!eliLink) {
          const cgiHref = $entry('a[href*="cgi_loi"], a[href*="cgi_wet"]').attr('href');
          if (cgiHref) eliLink = normalizeCgiUrl(cgiHref);
        }

        if (!text || !eliLink) continue;

        // Extract article number from the text
        // Matches patterns like: "Art. 23/1 - 35" or "Art. 40, tweede en vierde lid - 01"
        const artMatch = text.match(/Art\.\s*(.+?)\s*-\s*\d+/);
        if (artMatch) {
          const articles = parseArticleNumbers(artMatch[1].trim());
          for (const art of articles) {
            basesLegales.push({ article: art, eli: eliLink });
          }
        }
      }
    });

    fiches.push({
      abstract: abstractText,
      legalBases: basesLegales,
    });
  });

  return fiches;
}

// ─── Data Assembly & Export ───────────────────────────────────────────────────

/**
 * Store judgement data into the appropriate JSON files organized by ELI.
 * 
 * File structure:
 * data/<eli_filename>.json = {
 *   "<article>": {
 *     "<ECLI>": {
 *       court, date, roleNumber, url,
 *       abstractFR, abstractNL
 *     }
 *   }
 * }
 */
/**
 * Merge an incoming abstract string into an existing abstract array.
 * - Existing value is normalised to an array (tolerates legacy scalar strings).
 * - The incoming value is appended only if it is not already present.
 * - Returns null when the result would be an empty array.
 */
function mergeAbstractArrays(existing, incoming) {
  const arr = Array.isArray(existing) ? [...existing]
    : (existing ? [existing] : []);
  if (incoming && !arr.includes(incoming)) arr.push(incoming);
  return arr.length > 0 ? arr : null;
}

function storeJudgementData(judgement, abstractToBasesMap) {
  // abstractToBasesMap: array of { abstractFR?, abstractNL?, legalBases: [{article, eli}] }

  for (const entry of abstractToBasesMap) {
    for (const base of entry.legalBases) {
      if (!base.eli) continue;

      const filename = eliToFilename(base.eli);
      const data = loadDataFile(filename);

      if (!data[base.article]) {
        data[base.article] = {};
      }

      // Merge with any existing entry so that abstracts accumulated across
      // successive sitemaps or multiple fiches sharing the same ELI+article
      // are never lost.  Abstracts are stored as deduplicated arrays.
      const existing = data[base.article][judgement.ecli] || {};
      data[base.article][judgement.ecli] = {
        court: judgement.court,
        date: judgement.judgementDate,
        roleNumber: judgement.roleNumber,
        url: judgement.judgementUrl,
        abstractFR: mergeAbstractArrays(existing.abstractFR, entry.abstractFR),
        abstractNL: mergeAbstractArrays(existing.abstractNL, entry.abstractNL),
      };

      saveDataFile(filename, data);
    }
  }
}

// ─── Main Crawling Logic ─────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║         JUPORTAL CRAWLER v1.0.0          ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝\n'));

  ensureDataDir();
  const settings = loadSettings();

  // Migrate any NL ELI data files created by previous runs to their FR equivalents
  migrateNlEliFiles();
  // Migrate any legacy scalar abstract values to arrays
  migrateAbstractsToArrays();
  // Normalize article keys (strip sub-paragraph qualifiers, deduplicate)
  migrateArticleKeys();

  // Step 1: Fetch all sitemap index URLs from robots.txt
  let sitemapIndexUrls;
  try {
    sitemapIndexUrls = await fetchSitemapIndexUrls();
  } catch (err) {
    logFatal(`Cannot fetch robots.txt: ${err.message}`);
    process.exit(1);
  }

  let totalSitemapIndexes = sitemapIndexUrls.length;
  let processedCount = 0;
  let skippedCourt = 0;
  let savedJudgements = 0;
  let errorCount = 0;

  // Step 2: Process each sitemap_index (most recent first)
  for (const sitemapIndexUrl of sitemapIndexUrls) {
    processedCount++;
    const dateStr = extractDateFromUrl(sitemapIndexUrl);

    // Check if already processed
    if (settings.processedSitemapIndexes.includes(sitemapIndexUrl)) {
      logInfo(chalk.gray(`${timestamp()} [${processedCount}/${totalSitemapIndexes}] Skipping (already processed): ${dateStr}`));
      continue;
    }

    logInfo(`\n${timestamp()} ${chalk.bold(`[${processedCount}/${totalSitemapIndexes}]`)} Processing sitemap index: ${chalk.cyan(dateStr)}`);
    logInfo(chalk.gray(`  URL: ${sitemapIndexUrl}`));

    // Step 3: Fetch the list of sitemaps within this index
    let sitemapUrls;
    try {
      sitemapUrls = await fetchSitemapUrls(sitemapIndexUrl);
    } catch (err) {
      logError(`✖ Failed to fetch sitemap index ${sitemapIndexUrl}: ${err.message}`);
      errorCount++;
      continue;
    }

    logInfo(`${timestamp()}   Found ${sitemapUrls.length} sitemaps for ${dateStr}`);

    let indexFullyProcessed = true;

    // Step 4: Process each individual sitemap
    for (let i = 0; i < sitemapUrls.length; i++) {
      const sitemapUrl = sitemapUrls[i];

      // Check if already processed
      if (settings.processedSitemaps.includes(sitemapUrl)) {
        continue;
      }

      logInfo(chalk.gray(`${timestamp()}   [${i + 1}/${sitemapUrls.length}] Processing sitemap: ${sitemapUrl}`));

      let judgement;
      try {
        judgement = await parseSitemapXml(sitemapUrl);
      } catch (err) {
        logError(`✖ Failed to parse sitemap ${sitemapUrl}: ${err.message}`);
        errorCount++;
        indexFullyProcessed = false;
        continue;
      }

      if (!judgement) {
        logWarn(`⚠ Empty sitemap: ${sitemapUrl}`);
        settings.processedSitemaps.push(sitemapUrl);
        saveSettings(settings);
        continue;
      }

      if (judgement.skipped) {
        logInfo(chalk.gray(`${timestamp()}     Skipped (court: ${judgement.court}, not CASS)`));
        skippedCourt++;
        settings.processedSitemaps.push(sitemapUrl);
        saveSettings(settings);
        continue;
      }

      // We have a CASS judgement
      logInfo(`${timestamp()}     ${chalk.bold('CASS')} | ${judgement.ecli} | ${judgement.judgementDate} | ${judgement.roleNumber || 'N/A'}`);
      logInfo(`${timestamp()}     Abstracts: FR=${judgement.abstractsFR.length}, NL=${judgement.abstractsNL.length} | Legal bases: ${judgement.legalBases.length}`);

      if (judgement.legalBases.length === 0) {
        logWarn(`⚠ No legal bases with ELI found for ${judgement.ecli} — skipping data export`);
        settings.processedSitemaps.push(sitemapUrl);
        saveSettings(settings);
        continue;
      }

      // Determine abstract-to-legal-basis mapping
      let abstractToBasesMap;
      const totalAbstractsFR = judgement.abstractsFR.length;
      const totalAbstractsNL = judgement.abstractsNL.length;
      const totalAbstracts = Math.max(totalAbstractsFR, totalAbstractsNL);

      if (totalAbstracts <= 1) {
        // Simple case: one abstract (or none) — all legal bases share it
        abstractToBasesMap = [{
          abstractFR: judgement.abstractsFR[0] || null,
          abstractNL: judgement.abstractsNL[0] || null,
          legalBases: judgement.legalBases,
        }];
        logInfo(chalk.gray(`${timestamp()}     Single abstract → all legal bases share it`));
      } else {
        // Multiple abstracts: need to download judgement page to determine mapping
        logInfo(`${timestamp()}     ${chalk.yellow('Multiple abstracts detected')} → downloading judgement page for precise mapping...`);
        
        try {
          const fiches = await parseJudgementPage(judgement.judgementUrl);
          const fichesWithBases = fiches.filter(f => f.legalBases.length > 0);
          
          if (fichesWithBases.length === 0) {
            logWarn(`⚠ No fiches with legal bases found on judgement page for ${judgement.ecli}`);
            logWarn(`  Falling back: assigning all abstracts to all legal bases`);
            abstractToBasesMap = [{
              abstractFR: judgement.abstractsFR.join(' | '),
              abstractNL: judgement.abstractsNL.join(' | '),
              legalBases: judgement.legalBases,
            }];
          } else {
            // Build mapping from fiches
            // The judgement page gives us abstract text + legal bases for each fiche.
            // We match the page abstract back to sitemap FR/NL abstracts using text similarity.
            // FR and NL abstracts in the sitemap appear in the same positional order.
            abstractToBasesMap = [];
            
            const usedFR = new Set();
            const usedNL = new Set();
            
            for (const fiche of fichesWithBases) {
              const ficheAbstract = fiche.abstract;
              
              // Try matching against FR abstracts
              let bestIdx = null;
              let bestScore = 0;
              let bestLang = null;

              for (let fi = 0; fi < judgement.abstractsFR.length; fi++) {
                if (usedFR.has(fi)) continue;
                const score = textSimilarity(ficheAbstract, judgement.abstractsFR[fi]);
                if (score > bestScore) {
                  bestScore = score;
                  bestIdx = fi;
                  bestLang = 'fr';
                }
              }

              // Try matching against NL abstracts
              for (let ni = 0; ni < judgement.abstractsNL.length; ni++) {
                if (usedNL.has(ni)) continue;
                const score = textSimilarity(ficheAbstract, judgement.abstractsNL[ni]);
                if (score > bestScore) {
                  bestScore = score;
                  bestIdx = ni;
                  bestLang = 'nl';
                }
              }

              let abstractFR = null;
              let abstractNL = null;

              if (bestIdx !== null && bestScore > 0.2) {
                // FR and NL abstracts are positionally paired
                if (bestIdx < judgement.abstractsFR.length) {
                  abstractFR = judgement.abstractsFR[bestIdx];
                  usedFR.add(bestIdx);
                }
                if (bestIdx < judgement.abstractsNL.length) {
                  abstractNL = judgement.abstractsNL[bestIdx];
                  usedNL.add(bestIdx);
                }
              } else {
                // Low confidence match — use the fiche abstract as-is
                logWarn(`⚠ Low confidence abstract match (score=${bestScore.toFixed(2)}) for fiche in ${judgement.ecli}`);
              }
              
              abstractToBasesMap.push({
                abstractFR,
                abstractNL,
                legalBases: fiche.legalBases,
              });
            }
            
            logSuccess(`✔ Parsed ${fiches.length} fiches (${fichesWithBases.length} with legal bases) from judgement page`);
          }
        } catch (err) {
          logError(`✖ Failed to download judgement page for ${judgement.ecli}: ${err.message}`);
          logWarn(`  Falling back: assigning all abstracts to all legal bases`);
          abstractToBasesMap = [{
            abstractFR: judgement.abstractsFR.join(' | '),
            abstractNL: judgement.abstractsNL.join(' | '),
            legalBases: judgement.legalBases,
          }];
        }
      }

      // Store the data
      try {
        storeJudgementData(judgement, abstractToBasesMap);
        savedJudgements++;
        logSuccess(`✔ Saved data for ${judgement.ecli}`);
      } catch (err) {
        logError(`✖ Failed to save data for ${judgement.ecli}: ${err.message}`);
        errorCount++;
        indexFullyProcessed = false;
        continue;
      }

      // Mark sitemap as processed
      settings.processedSitemaps.push(sitemapUrl);
      saveSettings(settings);
    }

    // Mark sitemap index as processed (only if all sitemaps succeeded)
    if (indexFullyProcessed) {
      settings.processedSitemapIndexes.push(sitemapIndexUrl);
      // Remove individual sitemap URLs for this index — they are now redundant
      // because the index-level entry already covers them on future runs.
      const sitemapSet = new Set(sitemapUrls);
      settings.processedSitemaps = settings.processedSitemaps.filter(
        url => !sitemapSet.has(url)
      );
      saveSettings(settings);
      logSuccess(`✔ Completed sitemap index: ${dateStr}`);
    } else {
      logWarn(`⚠ Sitemap index ${dateStr} partially processed (some errors occurred)`);
    }
  }

  // Final summary
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║              CRAWL COMPLETE              ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝'));
  logInfo(`  Total sitemap indexes:  ${totalSitemapIndexes}`);
  logSuccess(`  Judgements saved:       ${savedJudgements}`);
  logInfo(`  Non-CASS skipped:       ${skippedCourt}`);
  if (errorCount > 0) {
    logError(`  Errors:                 ${errorCount}`);
  }
  logInfo('');
}

// ─── Text Similarity ─────────────────────────────────────────────────────────

/**
 * Simple text similarity based on shared words ratio.
 * Returns a value between 0 (no match) and 1 (perfect match).
 */
function textSimilarity(a, b) {
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

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(err => {
  logFatal(`Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
