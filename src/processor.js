import chalk from 'chalk';
import { logInfo, logWarn, logError, logSuccess, timestamp } from './logger.js';
import { saveSettings } from './storage.js';
import { textSimilarity } from './utils.js';
import { parseSitemapXml } from './sitemap.js';
import { parseJudgementPage } from './judgement.js';
import { storeJudgementData, recordMissingEliData } from './data.js';

// ─── Single Sitemap Processing ───────────────────────────────────────────────

/**
 * Process one individual sitemap URL.
 * Updates counters in-place. Returns true if the sitemap was fully processed
 * without errors, false if an error occurred (so callers can track partial runs).
 * When markProcessed is true the URL is added to settings.processedSitemaps.
 */
export async function processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed = true } = {}) {
  let judgement;
  try {
    judgement = await parseSitemapXml(sitemapUrl);
  } catch (err) {
    logError(`✖ Failed to parse sitemap ${sitemapUrl}: ${err.message}`);
    counters.errorCount++;
    return false;
  }

  if (!judgement) {
    logWarn(`⚠ Empty sitemap: ${sitemapUrl}`);
    if (markProcessed) { settings.processedSitemaps.push(sitemapUrl); saveSettings(settings); }
    return true;
  }

  if (judgement.skipped) {
    const reason = judgement.court !== 'CASS'
      ? `court: ${judgement.court}, not CASS`
      : `ECLI: ${judgement.ecli}, not ARR`;
    logInfo(chalk.gray(`${timestamp()}     Skipped (${reason})`));
    counters.skippedCourt++;
    if (markProcessed) { settings.processedSitemaps.push(sitemapUrl); saveSettings(settings); }
    return true;
  }

  // We have a CASS judgement
  logInfo(`${timestamp()}     ${chalk.bold('CASS')} | ${judgement.ecli} | ${judgement.judgementDate} | ${judgement.roleNumber || 'N/A'}`);
  logInfo(`${timestamp()}     Abstracts: FR=${judgement.abstractsFR.length}, NL=${judgement.abstractsNL.length} | Legal bases: ${judgement.legalBases.length}`);

  const xmlMissingEli = judgement.legalBasesWithoutEli || [];
  if (judgement.legalBases.length === 0 && xmlMissingEli.length === 0) {
    logWarn(`⚠ No legal bases found for ${judgement.ecli} — skipping data export`);
    if (markProcessed) { settings.processedSitemaps.push(sitemapUrl); saveSettings(settings); }
    return true;
  }
  if (judgement.legalBases.length === 0) {
    logWarn(`⚠ No legal bases with ELI for ${judgement.ecli} — will record ${xmlMissingEli.length} missing ELI entry(s)`);
  }

  // Determine abstract-to-legal-basis mapping
  let abstractToBasesMap;
  const totalAbstracts = Math.max(judgement.abstractsFR.length, judgement.abstractsNL.length);

  if (totalAbstracts <= 1) {
    abstractToBasesMap = [{
      abstractFR: judgement.abstractsFR[0] || null,
      abstractNL: judgement.abstractsNL[0] || null,
      legalBases: judgement.legalBases,
      missingEliBases: xmlMissingEli,
    }];
    logInfo(chalk.gray(`${timestamp()}     Single abstract → all legal bases share it`));
  } else {
    logInfo(`${timestamp()}     ${chalk.yellow('Multiple abstracts detected')} → downloading judgement page for precise mapping...`);
    try {
      const fiches = await parseJudgementPage(judgement.judgementUrl);
      const fichesWithData = fiches.filter(f => (f.legalBases.length > 0) || (f.missingEliBases && f.missingEliBases.length > 0));

      if (fichesWithData.length === 0) {
        logWarn(`⚠ No fiches with legal bases found on judgement page for ${judgement.ecli}`);
        logWarn(`  Falling back: assigning all abstracts to all legal bases`);
        abstractToBasesMap = [{
          abstractFR: judgement.abstractsFR.join(' | '),
          abstractNL: judgement.abstractsNL.join(' | '),
          legalBases: judgement.legalBases,
          missingEliBases: [],
        }];
      } else {
        abstractToBasesMap = [];
        const usedFR = new Set();
        const usedNL = new Set();

        for (const fiche of fichesWithData) {
          const ficheAbstract = fiche.abstract;
          let bestIdx = null;
          let bestScore = 0;

          for (let fi = 0; fi < judgement.abstractsFR.length; fi++) {
            if (usedFR.has(fi)) continue;
            const score = textSimilarity(ficheAbstract, judgement.abstractsFR[fi]);
            if (score > bestScore) { bestScore = score; bestIdx = fi; }
          }
          for (let ni = 0; ni < judgement.abstractsNL.length; ni++) {
            if (usedNL.has(ni)) continue;
            const score = textSimilarity(ficheAbstract, judgement.abstractsNL[ni]);
            if (score > bestScore) { bestScore = score; bestIdx = ni; }
          }

          let abstractFR = null;
          let abstractNL = null;
          if (bestIdx !== null && bestScore > 0.2) {
            if (bestIdx < judgement.abstractsFR.length) { abstractFR = judgement.abstractsFR[bestIdx]; usedFR.add(bestIdx); }
            if (bestIdx < judgement.abstractsNL.length) { abstractNL = judgement.abstractsNL[bestIdx]; usedNL.add(bestIdx); }
          } else {
            logWarn(`⚠ Low confidence abstract match (score=${bestScore.toFixed(2)}) for fiche in ${judgement.ecli}`);
          }

          abstractToBasesMap.push({
            abstractFR,
            abstractNL,
            legalBases: fiche.legalBases,
            missingEliBases: fiche.missingEliBases || [],
          });
        }
        logSuccess(`✔ Parsed ${fiches.length} fiches (${fichesWithData.length} with legal bases data) from judgement page`);
      }
    } catch (err) {
      logError(`✖ Failed to download judgement page for ${judgement.ecli}: ${err.message}`);
      logWarn(`  Falling back: assigning all abstracts to all legal bases`);
      abstractToBasesMap = [{
        abstractFR: judgement.abstractsFR.join(' | '),
        abstractNL: judgement.abstractsNL.join(' | '),
        legalBases: judgement.legalBases,
        missingEliBases: [],
      }];
    }
  }

  recordMissingEliData(judgement, abstractToBasesMap);

  try {
    storeJudgementData(judgement, abstractToBasesMap);
    counters.savedJudgements++;
    logSuccess(`✔ Saved data for ${judgement.ecli}`);
  } catch (err) {
    logError(`✖ Failed to save data for ${judgement.ecli}: ${err.message}`);
    counters.errorCount++;
    return false;
  }

  if (markProcessed) { settings.processedSitemaps.push(sitemapUrl); saveSettings(settings); }
  return true;
}
