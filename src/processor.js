import chalk from 'chalk';
import { logInfo, logWarn, logError, logSuccess, timestamp } from './logger.js';
import { saveSettings } from './storage.js';
import { textSimilarity } from './utils.js';
import { parseSitemapXml } from './sitemap.js';
import { fetchJudgementHtml, parseJudgementHtml } from './judgement.js';
import { storeJudgementData, recordMissingEliData } from './data.js';

// ─── Phase 1 – Network fetch ─────────────────────────────────────────────────

/**
 * Fetch and parse everything needed for one sitemap URL.
 * Performs all network I/O but writes nothing to disk.
 *
 * Returns a discriminated result object:
 *   { type: 'error',    message }
 *   { type: 'empty'  }
 *   { type: 'skip',    judgement }
 *   { type: 'no-bases', judgement }
 *   { type: 'save',    judgement, abstractToBasesMap }
 *
 * Multiple calls can run concurrently — there is no shared mutable state here.
 */
export async function fetchSitemapResult(sitemapUrl) {
  // ── 1. Parse the sitemap XML (one network round-trip) ─────────────────────
  let judgement;
  try {
    judgement = await parseSitemapXml(sitemapUrl);
  } catch (err) {
    logError(`✖ Failed to parse sitemap ${sitemapUrl}: ${err.message}`);
    return { type: 'error', message: err.message };
  }

  if (!judgement) {
    logWarn(`⚠ Empty sitemap: ${sitemapUrl}`);
    return { type: 'empty' };
  }

  if (judgement.skipped) {
    const reason = judgement.court !== 'CASS'
      ? `court: ${judgement.court}, not CASS`
      : `ECLI: ${judgement.ecli}, not ARR`;
    logInfo(chalk.gray(`${timestamp()}     Skipped (${reason})`));
    return { type: 'skip', judgement };
  }

  // ── 2. CASS judgement ─────────────────────────────────────────────────────
  logInfo(`${timestamp()}     ${chalk.bold('CASS')} | ${judgement.ecli} | ${judgement.judgementDate} | ${judgement.roleNumber || 'N/A'}`);
  logInfo(`${timestamp()}     Abstracts: FR=${judgement.abstractsFR.length}, NL=${judgement.abstractsNL.length} | Legal bases: ${judgement.legalBases.length}`);

  const xmlMissingEli = judgement.legalBasesWithoutEli || [];
  if (judgement.legalBases.length === 0 && xmlMissingEli.length === 0) {
    logWarn(`⚠ No legal bases found for ${judgement.ecli} — skipping data export`);
    return { type: 'no-bases', judgement };
  }
  if (judgement.legalBases.length === 0) {
    logWarn(`⚠ No legal bases with ELI for ${judgement.ecli} — will record ${xmlMissingEli.length} missing ELI entry(s)`);
  }

  // ── 3. Build abstract-to-legal-basis mapping (may need a second HTTP fetch) ─
  let abstractToBasesMap;
  const totalAbstracts = Math.max(judgement.abstractsFR.length, judgement.abstractsNL.length);

  if (totalAbstracts <= 1) {
    let resolvedBases = [...judgement.legalBases];
    let stillMissingEliBases = [...xmlMissingEli];

    // Download the HTML page when the XML is missing ELI links — the HTML
    // often carries them as proper hyperlinks.
    if (xmlMissingEli.length > 0) {
      logInfo(`${timestamp()}     ${chalk.yellow('Missing ELI(s) in XML')} → downloading judgement page to resolve...`);
      try {
        const html = await fetchJudgementHtml(judgement.judgementUrl);
        const fiches = parseJudgementHtml(html);
        const htmlBases = fiches.flatMap(f => f.legalBases);
        const resolvedFromHtml = [];
        const stillMissing = [];

        for (const missing of xmlMissingEli) {
          const htmlMatch = htmlBases.find(hb =>
            hb.eli && hb.article === missing.article
          );
          if (htmlMatch) {
            resolvedFromHtml.push({ article: missing.article, eli: htmlMatch.eli });
            logInfo(chalk.gray(`${timestamp()}       Resolved ELI from HTML | article="${missing.article}" | eli=${htmlMatch.eli}`));
          } else {
            stillMissing.push(missing);
          }
        }

        resolvedBases = [...resolvedBases, ...resolvedFromHtml];
        stillMissingEliBases = stillMissing;

        if (resolvedFromHtml.length > 0) {
          logInfo(`${timestamp()}     Resolved ${resolvedFromHtml.length} missing ELI(s) from judgement page`);
        }
      } catch (err) {
        logWarn(`⚠ Failed to download judgement page for ELI resolution (${judgement.ecli}): ${err.message}`);
      }
    }

    abstractToBasesMap = [{
      abstractFR: judgement.abstractsFR[0] || null,
      abstractNL: judgement.abstractsNL[0] || null,
      legalBases: resolvedBases,
      missingEliBases: stillMissingEliBases,
    }];
    logInfo(chalk.gray(`${timestamp()}     Single abstract → all legal bases share it`));
  } else {
    logInfo(`${timestamp()}     ${chalk.yellow('Multiple abstracts detected')} → downloading judgement page for precise mapping...`);
    try {
      const html = await fetchJudgementHtml(judgement.judgementUrl);
      const fiches = parseJudgementHtml(html);
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

  return { type: 'save', judgement, abstractToBasesMap };
}

// ─── Phase 2 – Serialised commit (disk writes) ───────────────────────────────

/**
 * Write the result from fetchSitemapResult to disk and update counters.
 * MUST be called from a SerialQueue to prevent concurrent read-modify-write
 * races on the same ELI data files.
 *
 * Updates counters in-place. Returns true on success, false on error.
 * When markProcessed is true the URL is pushed to settings.processedSitemaps.
 */
export function commitSitemapResult(result, sitemapUrl, settings, counters, { markProcessed = true } = {}) {
  const markDone = () => {
    if (markProcessed) {
      settings.processedSitemaps.push(sitemapUrl);
      saveSettings(settings);
    }
  };

  if (result.type === 'error') {
    counters.errorCount++;
    return false;
  }

  if (result.type === 'empty' || result.type === 'no-bases') {
    markDone();
    return true;
  }

  if (result.type === 'skip') {
    counters.skippedCourt++;
    markDone();
    return true;
  }

  // type === 'save'
  const { judgement, abstractToBasesMap } = result;
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

  markDone();
  return true;
}

// ─── Convenience wrapper (used by targeted single-URL runs) ─────────────────

/**
 * Sequential fetch + commit in one call.
 * Used for targeted runs (node index.js <url>) where concurrency is not needed.
 * Updates counters in-place. Returns true on success, false on error.
 * When markProcessed is true the URL is added to settings.processedSitemaps.
 */
export async function processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed = true } = {}) {
  const result = await fetchSitemapResult(sitemapUrl);
  return commitSitemapResult(result, sitemapUrl, settings, counters, { markProcessed });
}

