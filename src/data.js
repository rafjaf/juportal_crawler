import chalk from 'chalk';
import { logInfo, logWarn, logSuccess, timestamp } from './logger.js';
import { loadDataFile, saveDataFile, loadMissingEliFile, saveMissingEliFile, appendMissingEli } from './storage.js';
import { eliToFilename, normalizeEliToFrench, normalizeCgiUrl, normalizeArticleNumber } from './utils.js';

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

export function storeJudgementData(judgement, abstractToBasesMap) {
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

      logInfo(chalk.gray(`${timestamp()}       Saved | article="${base.article}" | ${filename} | ecli=${judgement.ecli}`));
      saveDataFile(filename, data);
    }
  }
}

export function recordMissingEliData(judgement, abstractToBasesMap) {
  let recorded = 0;

  for (const entry of abstractToBasesMap) {
    if (!entry.missingEliBases || entry.missingEliBases.length === 0) continue;

    for (const missing of entry.missingEliBases) {
      appendMissingEli(missing.rawLegalBasisText, {
        ecli: judgement.ecli,
        court: judgement.court,
        date: judgement.judgementDate,
        roleNumber: judgement.roleNumber,
        url: judgement.judgementUrl,
        article: missing.article,
        abstractFR: entry.abstractFR || null,
        abstractNL: entry.abstractNL || null,
      });
      recorded++;
    }
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

    for (const element of item.elements) {
      const judgement = {
        ecli: element.ecli,
        court: element.court,
        judgementDate: element.date,
        roleNumber: element.roleNumber,
        judgementUrl: element.url,
      };

      storeJudgementData(judgement, [{
        abstractFR: element.abstractFR || null,
        abstractNL: element.abstractNL || null,
        legalBases: [{ article: normalizeArticleNumber(element.article || ''), eli: normalizedEli }],
      }]);

      reintegratedElements++;
    }

    item.elements = [];
    processedKeys++;
  }

  saveMissingEliFile(missing);
  logSuccess(`✔ Processed missing_eli.json: ${processedKeys} key(s), ${reintegratedElements} element(s) reintegrated`);
}
