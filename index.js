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
import readline from 'node:readline';
import { logInfo, logSuccess, logWarn, logError, logFatal, timestamp } from './src/logger.js';
import { ensureDataDir, loadSettings, saveSettings, loadErrorsFile, saveErrorsFile, loadMissingEliFile, saveMissingEliFile, flushAll } from './src/storage.js';
import { fetchSitemapIndexUrls, extractDateFromUrl, fetchSitemapUrls } from './src/sitemap.js';
import { processSingleSitemapUrl, fetchSitemapResult, commitSitemapResult } from './src/processor.js';
import { processMissingEliFile } from './src/data.js';
import { progress } from './src/progress.js';
import { SITEMAP_CONCURRENCY, LOG_FILE } from './src/constants.js';
import { Semaphore, SerialQueue } from './src/concurrency.js';
import { extractOldStyleArticle, extractLegalBasisKey } from './src/utils.js';
import fs from 'fs';

// ─── Graceful shutdown ───────────────────────────────────────────────────────

// Flush deferred in-memory stores on any exit path (normal return, Ctrl+C,
// process.exit(), or SIGTERM from the scheduler).
process.on('exit', flushAll);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => {
  progress.finish();
  flushAll();
  process.exit(0);
});

// ─── Listen for 'q' keypress to quit gracefully ──────────────────────────────

/**
 * Listen for the user to press 'q' / 'Q' / Ctrl+C to exit and flushall.
 * Tries to enter raw mode so individual keypresses are captured without
 * requiring the user to press Enter.
 */
function setupQuitListener() {
  const stdin = process.stdin;

  if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return;
  }

  try {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    // Prevent the stdin stream from keeping the program alive
    // when all other tasks are completed.
    stdin.unref();
  } catch {
    return;
  }

  const onKeypress = (str, key) => {
    if ((key && key.ctrl && key.name === 'c') || (key && key.name === 'q') || (str && str.toLowerCase() === 'q')) {
      progress.finish();
      flushAll();
      process.exit(0);
    }
  };

  stdin.on('keypress', onKeypress);
}

// ─── Fix Articles From Log ───────────────────────────────────────────────────

/**
 * Prompt the user with a question and return their answer.
 * Supports: yes / no / all / quit.
 * Temporarily exits raw mode so readline can capture a full line.
 */
function promptUser(question) {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    process.stdin.ref(); // keep event loop alive while waiting for input

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      process.stdin.unref(); // restore original behaviour
      if (wasRaw) process.stdin.setRawMode(true);
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Review log.json entries where article="general" was detected, re-analyse
 * using the improved old-style article detection, and apply corrections
 * to data files and missing_eli.json.
 */
async function fixArticlesFromLog() {
  logInfo(`${timestamp()} Loading log.json...`);
  let logData;
  try {
    logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  } catch (err) {
    logFatal(`Cannot read log.json: ${err.message}`);
    process.exit(1);
  }

  const logKeys = Object.keys(logData);
  logInfo(`${timestamp()} Found ${logKeys.length} total log entries.`);

  // Collect entries that have "general" articles needing review.
  // Only missingEliBases are considered: when an ELI is present the bare
  // number after the date is a publication counter, so "general" is correct.
  const toReview = [];
  for (const logKey of logKeys) {
    const entry = logData[logKey];
    // Check missingEliBases for "general" articles
    for (const missing of (entry.missingEliBases || [])) {
      if (missing.article === 'general') {
        const rawText = missing.legalBasisFR || missing.legalBasisNL || missing.rawLegalBasisText || '';
        const articles = extractOldStyleArticle(rawText);
        if (articles) {
          toReview.push({
            logKey,
            entry,
            base: missing,
            rawText,
            newArticles: articles,
          });
        }
      }
    }
  }

  if (toReview.length === 0) {
    logInfo(`${timestamp()} No "general" articles can be improved with the new detection.`);
    return;
  }

  logInfo(`${timestamp()} Found ${toReview.length} "general" article(s) that can be corrected.`);

  // Load settings for progress tracking
  const settings = loadSettings();
  const lastProcessedKey = settings.fixArticlesLastLogKey || null;

  // If resuming, skip already-processed entries
  let startIdx = 0;
  if (lastProcessedKey) {
    const resumeIdx = toReview.findIndex(r => r.logKey === lastProcessedKey);
    if (resumeIdx >= 0) {
      startIdx = resumeIdx + 1;
      logInfo(`${timestamp()} Resuming from entry ${startIdx + 1}/${toReview.length} (after ${lastProcessedKey})`);
    }
  }

  if (startIdx >= toReview.length) {
    logInfo(`${timestamp()} All entries already processed.`);
    return;
  }

  // Configure progress bar
  const total = toReview.length;
  const pending = total - startIdx;
  progress.configure(total, pending);
  progress.doneIndexes = startIdx;

  let applyAll = false;
  let correctedCount = 0;
  let skippedCount = 0;

  for (let i = startIdx; i < toReview.length; i++) {
    const item = toReview[i];
    const { logKey, entry, base, rawText, newArticles } = item;

    progress.clear();
    console.log('');
    logInfo(chalk.bold(`[${i + 1}/${total}]`) + ` ${entry.ecli} (${entry.date})`);
    logInfo(`  Raw: ${chalk.cyan(rawText)}`);
    logInfo(`  Current: article=${chalk.red('general')}  →  New: article=${chalk.green(newArticles.join(', '))}`);
    logInfo(`  Missing ELI | key: ${base.rawLegalBasisText}`);

    let answer;
    if (applyAll) {
      answer = 'yes';
    } else {
      progress.clear();
      const resp = await promptUser(
        chalk.yellow('  Apply correction? ') + chalk.gray('(yes/no/all/quit) ') + chalk.bold('> ')
      );
      answer = resp;
    }

    if (answer === 'quit' || answer === 'q') {
      logInfo(`${timestamp()} Quitting. Progress saved.`);
      settings.fixArticlesLastLogKey = logKey;
      saveSettings(settings);
      flushAll();
      progress.finish();
      return;
    }

    if (answer === 'all' || answer === 'a') {
      applyAll = true;
      answer = 'yes';
    }

    if (answer === 'yes' || answer === 'y') {
      // Fix in missing_eli.json: update article from "general" to specific
      const missingEli = loadMissingEliFile();
      const lawKey = extractLegalBasisKey(rawText) || base.rawLegalBasisText;
      const missingEntry = missingEli[lawKey] || missingEli[base.rawLegalBasisText];
      if (missingEntry && Array.isArray(missingEntry.elements)) {
        const elem = missingEntry.elements.find(
          e => e.ecli === entry.ecli && e.article === 'general'
        );
        if (elem) {
          if (newArticles.length === 1) {
            elem.article = newArticles[0];
          } else {
            // Multiple articles from a range: update the first, add copies for the rest
            elem.article = newArticles[0];
            for (let ai = 1; ai < newArticles.length; ai++) {
              missingEntry.elements.push({ ...elem, article: newArticles[ai] });
            }
          }
          saveMissingEliFile(missingEli);
          logSuccess(`  ✔ Updated missing_eli.json: general → [${newArticles.join(', ')}]`);
        } else {
          logWarn(`  ⚠ Element not found in missing_eli.json for ${entry.ecli} — skipping`);
        }
      } else {
        logWarn(`  ⚠ Key "${lawKey}" not found in missing_eli.json — skipping`);
      }
      correctedCount++;
    } else {
      skippedCount++;
    }

    // Record progress
    settings.fixArticlesLastLogKey = logKey;
    progress.doneIndexes = i + 1;
    progress.render();
  }

  progress.finish();

  // Save settings & missing_eli on completion
  saveSettings(settings);
  flushAll();

  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║      FIX-ARTICLES-FROM-LOG COMPLETE      ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝'));
  logSuccess(`  Corrected:   ${correctedCount}`);
  logInfo(`  Skipped:     ${skippedCount}`);
  logInfo(`  Total:       ${total}`);
  logInfo('');
}

// ─── Main Crawling Logic ─────────────────────────────────────────────────────

async function main() {
  const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  const version = packageJson.version;
  
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan(`║         JUPORTAL CRAWLER v${version.padEnd(14, ' ')} ║`));
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
    console.log(`  ${chalk.cyan('--fix-articles-from-log')} Review log.json entries where article="general" was`);
    console.log(`                            detected, and re-analyse them using the improved`);
    console.log(`                            old-style article detection. Corrections are applied`);
    console.log(`                            to data files and missing_eli.json interactively.`);
    console.log(`  ${chalk.cyan('--log')}                    Log each saved judgement to log.json with full detail`);
    console.log(`                            (for debugging / auditing the crawl logic).`);
    console.log(`  ${chalk.cyan('--help')}, ${chalk.cyan('-h')}             Show this help message.\n`);
    console.log(chalk.bold('Default (no arguments):'));
    console.log(`  Fetches all sitemap indexes from robots.txt and crawls them from`);
    console.log(`  most recent to oldest, skipping already-processed entries.\n`);
    return;
  }

  if (process.argv.includes('--process-missing-eli')) {
    processMissingEliFile();
    flushAll();
    return;
  }

  if (process.argv.includes('--fix-errors')) {
    const logEnabled = process.argv.includes('--log');
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
      const success = await processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed: false, log: logEnabled });

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
    flushAll();
    return;
  }

  if (process.argv.includes('--fix-articles-from-log')) {
    await fixArticlesFromLog();
    return;
  }

  // If a URL is passed as an argument, process only that sitemap or sitemap index.
  // The already-processed check is bypassed; settings are NOT updated.
  const targetUrl = process.argv.slice(2).find(a => a.startsWith('http'));
  if (targetUrl) {
    const logEnabled = process.argv.includes('--log');
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
      await processSingleSitemapUrl(sitemapUrl, settings, counters, { markProcessed: false, log: logEnabled });
    }

    logSuccess(`✔ Done — saved: ${counters.savedJudgements}, skipped: ${counters.skippedCourt}, errors: ${counters.errorCount}`);
    flushAll();
    return;
  }

  const settings = loadSettings();
  const logEnabled = process.argv.includes('--log');

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
  let newSitemapIndexCount = 0;
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
    newSitemapIndexCount++;

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
          const ok = commitSitemapResult(result, sitemapUrl, settings, count, { log: logEnabled });
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
  // Permanently deactivate the progress bar so that logInfo() in the summary
  // block no longer redraws it to stderr (which would mask the quit prompt).
  progress.finish();

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

  // Machine-readable summary line parsed by scheduled_run.sh for ntfy notification
  const summaryLine = savedJudgements === 0
    ? 'Nothing new found.'
    : `${newSitemapIndexCount} index(es) processed, ${savedJudgements} judgement(s) saved${errorCount > 0 ? `, ${errorCount} error(s)` : ''}.`;
  console.log(`SUMMARY: ${summaryLine}`);

  // Always show the quit prompt; if we have an interactive terminal,
  // we wait until 'q' or Ctrl+C is pressed (which is handled by setupQuitListener).
  progress.showQuitPrompt();
  if (process.stdin && process.stdin.isTTY) {
    // Keep the event loop alive until the user presses q.
    await new Promise(() => {});
  } else {
    flushAll();
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

setupQuitListener();

main().catch(err => {
  logFatal(`Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
