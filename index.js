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
import { ensureDataDir, loadSettings, saveSettings } from './src/storage.js';
import { fetchSitemapIndexUrls, extractDateFromUrl, fetchSitemapUrls } from './src/sitemap.js';
import { processSingleSitemapUrl } from './src/processor.js';
import { processMissingEliFile } from './src/data.js';

// ─── Main Crawling Logic ─────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║         JUPORTAL CRAWLER v1.0.0          ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝\n'));

  ensureDataDir();

  if (process.argv.includes('--process-missing-eli')) {
    processMissingEliFile();
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

      const counters = { skippedCourt, savedJudgements, errorCount };
      const ok = await processSingleSitemapUrl(sitemapUrl, settings, counters);
      skippedCourt = counters.skippedCourt;
      savedJudgements = counters.savedJudgements;
      errorCount = counters.errorCount;
      if (!ok) indexFullyProcessed = false;
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

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(err => {
  logFatal(`Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
