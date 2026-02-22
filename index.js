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

import chalk from 'chalk';
import { logInfo, logSuccess, logWarn, logError, logFatal, timestamp } from './src/logger.js';
import { ensureDataDir, loadSettings, saveSettings, loadErrorsFile, saveErrorsFile } from './src/storage.js';
import { fetchSitemapIndexUrls, extractDateFromUrl, fetchSitemapUrls } from './src/sitemap.js';
import { processSingleSitemapUrl, fetchSitemapResult, commitSitemapResult } from './src/processor.js';
import { processMissingEliFile } from './src/data.js';
import { progress } from './src/progress.js';
import { SITEMAP_CONCURRENCY } from './src/constants.js';
import { Semaphore, SerialQueue } from './src/concurrency.js';

// ─── Main Crawling Logic ─────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║         JUPORTAL CRAWLER v1.0.0          ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝\n'));

  ensureDataDir();

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(chalk.bold('Usage:') + '  node index.js [option]\n');
    console.log(chalk.bold('Options:'));
    console.log(`  ${chalk.cyan('<url>')}                    Process a single sitemap or sitemap index URL,`);
    console.log(`                            bypassing the already-processed check.`);
    console.log(`                            Accepts individual sitemap XML URLs or`);
    console.log(`                            sitemap_index XML URLs (all children are processed).`);
    console.log(`  ${chalk.cyan('--process-missing-eli')}    Re-process entries in missing_eli.json that now`);
    console.log(`                            have an ELI assigned, integrating them into the data files.`);
    console.log(`  ${chalk.cyan('--fix-errors')}             Re-process every sitemap listed in errors.json using`);
    console.log(`                            the latest algorithm. Entries that are now successfully`);
    console.log(`                            parsed are removed from errors.json.`);
    console.log(`  ${chalk.cyan('--help')}, ${chalk.cyan('-h')}             Show this help message.\n`);
    console.log(chalk.bold('Default (no arguments):'));
    console.log(`  Fetches all sitemap indexes from robots.txt and crawls them from`);
    console.log(`  most recent to oldest, skipping already-processed entries.\n`);
    return;
  }

  if (process.argv.includes('--process-missing-eli')) {
    processMissingEliFile();
    return;
  }

  if (process.argv.includes('--fix-errors')) {
    const originalErrors = loadErrorsFile();
    const errorSitemapUrls = Object.keys(originalErrors);

    if (errorSitemapUrls.length === 0) {
      logInfo('No entries in errors.json — nothing to fix.');
      return;
    }

    logInfo(`Found ${errorSitemapUrls.length} sitemap(s) with parse errors to reprocess.`);

    // Clear errors.json so appendParseError re-records only what still fails
    saveErrorsFile({});

    const settings = loadSettings();
    let fixedCount = 0;
    let partialCount = 0;
    let unchangedCount = 0;
    let networkErrorCount = 0;

    for (let i = 0; i < errorSitemapUrls.length; i++) {
      const sitemapUrl = errorSitemapUrls[i];
      const originalTexts = originalErrors[sitemapUrl];
      logInfo(`\n${timestamp()} ${chalk.bold(`[${i + 1}/${errorSitemapUrls.length}]`)} Reprocessing: ${chalk.cyan(sitemapUrl)}`);
      logInfo(chalk.gray(`  Had ${originalTexts.length} error(s): ${originalTexts.slice(0, 2).join(' | ')}${originalTexts.length > 2 ? ` (+${originalTexts.length - 2} more)` : ''}`));

      const counters = { skippedCourt: 0, savedJudgements: 0, errorCount: 0 };
      const success = await processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed: false });

      if (!success && counters.errorCount > 0) {
        // Network or fatal error — restore original errors for this URL so they
        // are not silently lost.
        logError(`✖ Network/processing error — restoring original errors for ${sitemapUrl}`);
        const currentErrors = loadErrorsFile();
        currentErrors[sitemapUrl] = originalTexts;
        saveErrorsFile(currentErrors);
        networkErrorCount++;
        continue;
      }

      const newErrors = loadErrorsFile();
      const remainingTexts = newErrors[sitemapUrl] || [];
      const fixedTexts = originalTexts.filter(t => !remainingTexts.includes(t));

      if (remainingTexts.length === 0) {
        logSuccess(`✔ All ${originalTexts.length} error(s) resolved.`);
        fixedCount++;
      } else if (fixedTexts.length > 0) {
        logWarn(`⚠ Partially fixed: ${fixedTexts.length}/${originalTexts.length} error(s) resolved, ${remainingTexts.length} remain.`);
        partialCount++;
      } else {
        logInfo(chalk.gray(`  No improvement — ${remainingTexts.length} error(s) remain.`));
        unchangedCount++;
      }
    }

    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║       FIX-ERRORS COMPLETE            ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝'));
    logSuccess(`  Fully fixed:      ${fixedCount}`);
    if (partialCount > 0) logWarn(`  Partially fixed:  ${partialCount}`);
    logInfo(`  Unchanged:        ${unchangedCount}`);
    if (networkErrorCount > 0) logError(`  Network errors:   ${networkErrorCount}`);
    logInfo('');
    return;
  }

  // If a URL is passed as an argument, process only that sitemap or sitemap index.
  // The already-processed check is bypassed; settings are NOT updated.
  const targetUrl = process.argv.slice(2).find(a => a.startsWith('http'));
  if (targetUrl) {
    logInfo(`${timestamp()} ${chalk.bold('Targeted run:')} ${chalk.cyan(targetUrl)}`);
    const counters = { skippedCourt: 0, savedJudgements: 0, errorCount: 0 };
    const settings = loadSettings(); // read-only for targeted runs

    let sitemapUrls;
    if (targetUrl.includes('sitemap_index')) {
      logInfo(`${timestamp()} Detected sitemap index — fetching child sitemaps...`);
      try {
        sitemapUrls = await fetchSitemapUrls(targetUrl);
        logInfo(`${timestamp()} Found ${sitemapUrls.length} sitemaps`);
      } catch (err) {
        logFatal(`Cannot fetch sitemap index: ${err.message}`);
        process.exit(1);
      }
    } else {
      sitemapUrls = [targetUrl];
    }

    for (let i = 0; i < sitemapUrls.length; i++) {
      const sitemapUrl = sitemapUrls[i];
      logInfo(chalk.gray(`${timestamp()} [${i + 1}/${sitemapUrls.length}] ${sitemapUrl}`));
      await processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed: false });
    }

    logSuccess(`✔ Done — saved: ${counters.savedJudgements}, skipped: ${counters.skippedCourt}, errors: ${counters.errorCount}`);
    return;
  }

  const settings = loadSettings();

  // Step 1: Fetch all sitemap index URLs from robots.txt
  let sitemapIndexUrls;
  try {
    sitemapIndexUrls = await fetchSitemapIndexUrls();
  } catch (err) {
    logFatal(`Cannot fetch robots.txt: ${err.message}`);
    process.exit(1);
  }

  const totalSitemapIndexes = sitemapIndexUrls.length;
  const pendingIndexCount = sitemapIndexUrls.filter(
    url => !settings.processedSitemapIndexes.includes(url)
  ).length;
  progress.configure(totalSitemapIndexes, pendingIndexCount, SITEMAP_CONCURRENCY);

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
      progress.endIndex();
      continue;
    }

    logInfo(`${timestamp()}   Found ${sitemapUrls.length} sitemaps for ${dateStr}`);
    progress.beginIndex(sitemapUrls.length);

    let indexFullyProcessed = true;

    // Step 4: Fetch up to SITEMAP_CONCURRENCY sitemaps in parallel while
    // serialising all disk writes through a queue to prevent file races.
    const sem = new Semaphore(SITEMAP_CONCURRENCY);
    const serialQ = new SerialQueue();
    const sitemapPromises = [];

    for (let i = 0; i < sitemapUrls.length; i++) {
      const sitemapUrl = sitemapUrls[i];
      const sitemapIdx = i;

      // Check if already processed
      if (settings.processedSitemaps.includes(sitemapUrl)) {
        progress.currentIndexDone++;
        continue;
      }

      const p = (async () => {
        // Acquire a slot — blocks until fewer than SITEMAP_CONCURRENCY fetches
        // are in-flight.
        await sem.acquire();
        logInfo(`${timestamp()}   [${sitemapIdx + 1}/${sitemapUrls.length}] Fetching: ${sitemapUrl}`);
        let result;
        const fetchStart = Date.now();
        try {
          result = await fetchSitemapResult(sitemapUrl);
        } finally {
          sem.release();
        }
        const fetchMs = Date.now() - fetchStart;

        // Commits are serialised so concurrent fetches never race on disk.
        await serialQ.enqueue(() => {
          const count = { skippedCourt, savedJudgements, errorCount };
          const ok = commitSitemapResult(result, sitemapUrl, settings, count);
          skippedCourt = count.skippedCourt;
          savedJudgements = count.savedJudgements;
          errorCount = count.errorCount;
          if (!ok) indexFullyProcessed = false;
          progress.currentIndexDone++;
          progress.recordSitemapTime(fetchMs);
        });
      })();

      sitemapPromises.push(p);
    }

    // Wait for all sitemaps in this index to complete.
    await Promise.all(sitemapPromises);

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
    progress.endIndex();
  }
  progress.clear();

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

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(err => {
  logFatal(`Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
