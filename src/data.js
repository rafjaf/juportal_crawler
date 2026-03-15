import chalk from 'chalk';
import { logInfo, logWarn, logSuccess, timestamp } from './logger.js';
import { loadDataFile, saveDataFile, loadMissingEliFile, saveMissingEliFile, appendMissingEli } from './storage.js';
import { eliToFilename, normalizeEliToFrench, normalizeCgiUrl, normalizeArticleNumber } from './utils.js';
import { getAllSplitTextElis, articleBelongsToPart, findEliForArticle, findSplitText } from './split_texts.js';

// ─── Data Assembly & Export ───────────────────────────────────────────────────

/**
 * Store judgement data into the appropriate JSON files organized by ELI.
 * 
 * File structure:
 * data/<eli_filename>.json = {
 *   "<article>": {
 *     "<ECLI>": {
 *       court, date, roleNumber, sitemap,
 *       abstractFR, abstractNL
 *     }
 *   }
 * }
 */

/**
 * Merge an incoming value (string or array) into an existing array.
 * - Existing value is normalised to an array (tolerates legacy scalar strings).
 * - The incoming value(s) are appended only if not already present.
 * - Returns null when the result would be an empty array.
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

export function storeJudgementData(judgement, abstractToBasesMap, sitemapUrl) {
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
        sitemap: mergeArrays(existing.sitemap, sitemapUrl),
        abstractFR: mergeArrays(existing.abstractFR, entry.abstractFR),
        abstractNL: mergeArrays(existing.abstractNL, entry.abstractNL),
      };

      logInfo(chalk.gray(`${timestamp()}       Saved | article="${base.article}" | ${filename} | ecli=${judgement.ecli}`));
      saveDataFile(filename, data);
    }
  }
}

export function recordMissingEliData(judgement, abstractToBasesMap, sitemapUrl) {
  let recorded = 0;
  let resolved = 0;

  for (const entry of abstractToBasesMap) {
    if (!entry.missingEliBases || entry.missingEliBases.length === 0) continue;

    for (const missing of entry.missingEliBases) {
      // If missing_eli.json already has a resolved ELI for this key, use it
      // directly instead of re-recording the element as missing.
      const knownEntry = loadMissingEliFile()[missing.rawLegalBasisText];
      if (knownEntry && knownEntry.eli) {
        const normalizedEli = normalizeLegalBasisEli(knownEntry.eli);
        if (normalizedEli) {
          const article = normalizeArticleNumber(
            (knownEntry.article != null ? String(knownEntry.article) : null) ?? missing.article ?? ''
          );
          storeJudgementData(judgement, [{
            abstractFR: entry.abstractFR || null,
            abstractNL: entry.abstractNL || null,
            legalBases: [{ article, eli: normalizedEli }],
          }], sitemapUrl);
          resolved++;
          continue;
        }
      }

      appendMissingEli(missing.rawLegalBasisText, {
        ecli: judgement.ecli,
        court: judgement.court,
        date: judgement.judgementDate,
        roleNumber: judgement.roleNumber,
        sitemap: sitemapUrl,
        article: missing.article,
        abstractFR: entry.abstractFR || null,
        abstractNL: entry.abstractNL || null,
        legalBasisFR: missing.legalBasisFR || null,
        legalBasisNL: missing.legalBasisNL || null,
      });
      recorded++;
    }
  }

  if (resolved > 0) {
    logSuccess(`✔ Resolved ${resolved} previously-missing ELI(s) from missing_eli.json`);
  }
  if (recorded > 0) {
    logWarn(`⚠ Recorded ${recorded} legal basis element(s) without ELI into missing_eli.json`);
  }
}

function normalizeLegalBasisEli(eli) {
  if (!eli) return null;
  if (eli.includes('/eli/')) return normalizeEliToFrench(eli);
  if (eli.startsWith('http://') || eli.startsWith('https://')) return normalizeCgiUrl(eli);
  return null;
}

export function processMissingEliFile() {
  const missing = loadMissingEliFile();
  const keys = Object.keys(missing);

  if (keys.length === 0) {
    logInfo(`${timestamp()} No missing ELI entries found in missing_eli.json`);
    return;
  }

  let processedKeys = 0;
  let reintegratedElements = 0;

  for (const key of keys) {
    const item = missing[key];
    if (!item || !Array.isArray(item.elements) || item.elements.length === 0) continue;
    if (!item.eli) continue;

    const normalizedEli = normalizeLegalBasisEli(item.eli);
    if (!normalizedEli) {
      logWarn(`⚠ Invalid ELI/URL for missing key "${key}": ${item.eli}`);
      continue;
    }

    const overrideArticle = (item.article != null) ? String(item.article) : null;

    // Check if this entry is a split text — route each element to the correct ELI part
    const splitText = findSplitText(key);

    for (const element of item.elements) {
      const judgement = {
        ecli: element.ecli,
        court: element.court,
        judgementDate: element.date,
        roleNumber: element.roleNumber,
      };

      const article = normalizeArticleNumber(overrideArticle ?? element.article ?? '');

      // For split texts, resolve to the correct part's ELI based on article
      let eli = normalizedEli;
      if (splitText) {
        const correctEli = findEliForArticle(splitText, article);
        if (correctEli) eli = correctEli;
      }

      storeJudgementData(judgement, [{
        abstractFR: element.abstractFR || null,
        abstractNL: element.abstractNL || null,
        legalBases: [{ article, eli }],
      }], element.sitemap);

      reintegratedElements++;
    }

    item.elements = [];
    processedKeys++;
  }

  saveMissingEliFile(missing);
  logSuccess(`✔ Processed missing_eli.json: ${processedKeys} key(s), ${reintegratedElements} element(s) reintegrated`);

  // ── Reassign misplaced abstracts in split-text data files ──
  reassignSplitTextAbstracts();
}

/**
 * Scan all data files belonging to split texts (codes with multiple ELIs)
 * and move any abstracts whose article falls outside the file's declared
 * range to the correct file.
 */
function reassignSplitTextAbstracts() {
  const allParts = getAllSplitTextElis();
  let movedCount = 0;

  for (const { splitText, part } of allParts) {
    const filename = eliToFilename(part.eli);
    const data = loadDataFile(filename);
    if (!data || Object.keys(data).length === 0) continue;

    const toRemove = []; // [article] keys to delete from this file

    for (const article of Object.keys(data)) {
      if (articleBelongsToPart(article, part)) continue;

      // This article doesn't belong here — find the correct ELI
      const correctEli = findEliForArticle(splitText, article);
      if (!correctEli || correctEli === part.eli) continue;

      // Move all ECLIs under this article to the correct file
      const correctFilename = eliToFilename(correctEli);
      const correctData = loadDataFile(correctFilename);
      if (!correctData[article]) correctData[article] = {};

      for (const [ecli, entry] of Object.entries(data[article])) {
        const existing = correctData[article][ecli] || {};
        correctData[article][ecli] = {
          court: entry.court ?? existing.court,
          date: entry.date ?? existing.date,
          roleNumber: entry.roleNumber ?? existing.roleNumber,
          sitemap: mergeArrays(existing.sitemap, entry.sitemap),
          abstractFR: mergeArrays(existing.abstractFR, entry.abstractFR),
          abstractNL: mergeArrays(existing.abstractNL, entry.abstractNL),
        };
        movedCount++;
      }

      saveDataFile(correctFilename, correctData);
      toRemove.push(article);
    }

    if (toRemove.length > 0) {
      for (const article of toRemove) {
        delete data[article];
      }
      saveDataFile(filename, data);
      logInfo(`  Moved ${toRemove.length} article(s) from ${filename} to correct split-text file(s)`);
    }
  }

  if (movedCount > 0) {
    logSuccess(`✔ Reassigned ${movedCount} ECLI(s) across split-text data files`);
  }
}
