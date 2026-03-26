/**
 * --fix-tpcpp: retroactive fix for case law entries in the CIC first-part
 * data file (1808111701) that actually belong to the TPCPP (1878041750).
 *
 * For every entry under articles 8–32, the original sitemap is re-fetched
 * and the raw legal-basis text is inspected.  When the date in the text is
 * "17-04-1878" (the TPCPP date), the entry is moved to the TPCPP data file.
 */

import chalk from 'chalk';
import { logInfo, logSuccess, logWarn, timestamp } from './logger.js';
import { loadDataFile, saveDataFile } from './storage.js';
import { eliToFilename, extractDateFromBasisText } from './utils.js';
import { parseSitemapXml } from './sitemap.js';

const CIC_ELI   = 'https://www.ejustice.just.fgov.be/eli/loi/1808/11/17/1808111701/justel';
const TPCPP_ELI  = 'https://www.ejustice.just.fgov.be/eli/loi/1878/04/17/1878041750/justel';

/** Normalise http:// → https:// for comparison purposes. */
function normalizeProtocol(url) {
  return (url || '').replace(/^http:\/\//, 'https://');
}
const CIC_FILE   = eliToFilename(CIC_ELI);
const TPCPP_FILE = eliToFilename(TPCPP_ELI);

/**
 * Merge an incoming value (string or array) into an existing array.
 */
function mergeArrays(existing, incoming) {
  const arr = Array.isArray(existing) ? [...existing]
    : (existing ? [existing] : []);
  if (Array.isArray(incoming)) {
    for (const v of incoming) {
      if (v && !arr.includes(v)) arr.push(v);
    }
  } else if (incoming && !arr.includes(incoming)) {
    arr.push(incoming);
  }
  return arr.length > 0 ? arr : null;
}

/**
 * Check if an article number is in the 8–32 range (TPCPP overlap zone).
 */
function isInOverlapRange(article) {
  if (!article || article === 'general') return false;
  const m = String(article).match(/^(\d+)/);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return n >= 8 && n <= 32;
}

/**
 * Main entry point for --fix-tpcpp.
 */
export async function fixTpcpp() {
  logInfo(`${timestamp()} Loading CIC data file: ${CIC_FILE}`);
  const cicData = loadDataFile(CIC_FILE);

  // Collect articles in the overlap range (8–32)
  const overlapArticles = Object.keys(cicData).filter(isInOverlapRange);
  if (overlapArticles.length === 0) {
    logInfo('No articles 8–32 found in the CIC data file. Nothing to do.');
    return;
  }

  // Build a map of sitemapUrl → [{ article, ecli }] for entries to check
  const sitemapEntries = new Map(); // sitemapUrl → [{ article, ecli }]
  let totalEntries = 0;

  for (const article of overlapArticles) {
    for (const [ecli, entry] of Object.entries(cicData[article])) {
      const sitemaps = Array.isArray(entry.sitemap) ? entry.sitemap : (entry.sitemap ? [entry.sitemap] : []);
      if (sitemaps.length === 0) continue;
      // Use the first sitemap (the one from which the entry was originally stored)
      const sitemap = sitemaps[0];
      if (!sitemapEntries.has(sitemap)) sitemapEntries.set(sitemap, []);
      sitemapEntries.get(sitemap).push({ article, ecli });
      totalEntries++;
    }
  }

  logInfo(`${timestamp()} Found ${totalEntries} entries across ${overlapArticles.length} articles in range 8–32`);
  logInfo(`${timestamp()} Need to re-fetch ${sitemapEntries.size} unique sitemap(s)\n`);

  // Process each sitemap and determine which entries need to move
  const toMove = []; // { article, ecli }
  let processed = 0;
  let fetchErrors = 0;

  for (const [sitemapUrl, entries] of sitemapEntries) {
    processed++;
    if (processed % 50 === 0 || processed === sitemapEntries.size) {
      logInfo(`${timestamp()} Progress: ${processed}/${sitemapEntries.size} sitemaps processed`);
    }

    // Try to determine the date by re-parsing the sitemap XML
    let judgement;
    try {
      judgement = await parseSitemapXml(sitemapUrl);
    } catch (err) {
      logWarn(`⚠ Failed to fetch ${sitemapUrl}: ${err.message}`);
      fetchErrors++;
      continue;
    }

    if (!judgement || judgement.skipped) continue;

    // A legal basis belongs to TPCPP when:
    //   (a) parseSitemapXml resolved its ELI to TPCPP (covers both the case
    //       where the XML already had the TPCPP ELI and the case where
    //       correctEliByDate redirected a wrong CIC ELI), OR
    //   (b) the entry has no ELI but the raw text date is 17-04-1878.
    //
    // Note: ELIs from the XML use http://, normalizeEliToFrench does not
    // upgrade the protocol, so we compare after normalising.
    const correctedArticles = new Set();
    for (const lb of judgement.legalBases) {
      if (normalizeProtocol(lb.eli) === TPCPP_ELI && isInOverlapRange(lb.article)) {
        correctedArticles.add(lb.article);
      }
    }

    // Also check legalBasesWithoutEli: the raw text date can tell us the law
    for (const lb of (judgement.legalBasesWithoutEli || [])) {
      if (!isInOverlapRange(lb.article)) continue;
      const rawDate = extractDateFromBasisText(lb.rawLegalBasisText || lb.legalBasisFR || lb.legalBasisNL || '');
      if (rawDate === '17-04-1878') {
        correctedArticles.add(lb.article);
      }
    }

    // Match corrected articles against the entries we're checking
    for (const { article, ecli } of entries) {
      if (correctedArticles.has(article)) {
        toMove.push({ article, ecli });
      }
    }
  }

  if (fetchErrors > 0) {
    logWarn(`⚠ ${fetchErrors} sitemap(s) could not be fetched`);
  }

  if (toMove.length === 0) {
    logInfo(`\n${timestamp()} No entries need to be moved from CIC to TPCPP.`);
    return;
  }

  logInfo(`\n${timestamp()} ${chalk.bold(`Moving ${toMove.length} entries from CIC → TPCPP`)}`);

  // Load TPCPP data file and perform the move
  const tpcppData = loadDataFile(TPCPP_FILE);
  let movedCount = 0;

  for (const { article, ecli } of toMove) {
    const entry = cicData[article]?.[ecli];
    if (!entry) continue;

    // Add to TPCPP
    if (!tpcppData[article]) tpcppData[article] = {};
    const existing = tpcppData[article][ecli] || {};
    tpcppData[article][ecli] = {
      court: entry.court ?? existing.court,
      date: entry.date ?? existing.date,
      roleNumber: entry.roleNumber ?? existing.roleNumber,
      sitemap: mergeArrays(existing.sitemap, entry.sitemap),
      abstractFR: mergeArrays(existing.abstractFR, entry.abstractFR),
      abstractNL: mergeArrays(existing.abstractNL, entry.abstractNL),
    };

    // Remove from CIC
    delete cicData[article][ecli];
    if (Object.keys(cicData[article]).length === 0) {
      delete cicData[article];
    }

    movedCount++;
  }

  // Save both files
  saveDataFile(CIC_FILE, cicData);
  saveDataFile(TPCPP_FILE, tpcppData);

  logSuccess(`\n✔ Moved ${movedCount} entries from CIC (${CIC_FILE}) to TPCPP (${TPCPP_FILE})`);

  // Summary
  const remainingArts = Object.keys(cicData).filter(isInOverlapRange);
  let remainingEntries = 0;
  for (const art of remainingArts) {
    remainingEntries += Object.keys(cicData[art]).length;
  }
  logInfo(`  Remaining articles 8–32 in CIC: ${remainingEntries} entries (correctly attributed to CIC)`);
  logInfo(`  TPCPP now has ${Object.keys(tpcppData).length} articles`);
}
