import chalk from 'chalk';
import readline from 'node:readline';
import fs from 'fs';
import { logInfo, logSuccess, logWarn, logFatal, timestamp } from './logger.js';
import { loadSettings, saveSettings, loadMissingEliFile, saveMissingEliFile, loadDataFile, saveDataFile, flushAll } from './storage.js';
import { progress } from './progress.js';
import { LOG_FILE } from './constants.js';
import { extractOldStyleArticle, extractOldStyleArticleWithEli, extractLegalBasisKey, eliToFilename } from './utils.js';

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
      // readline.close() pauses stdin; re-enable so the keypress quit listener stays active
      if (wasRaw) process.stdin.resume();
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
export async function fixArticlesFromLog() {
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
  // - missingEliBases: use extractOldStyleArticle (no ELI, old-style format)
  // - legalBases with ELI: use extractOldStyleArticleWithEli (article precedes counter)
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
            type: 'missing',
            logKey,
            entry,
            base: missing,
            rawText,
            newArticles: articles,
          });
        }
      }
    }
    // Check legalBases (ELI entries) for "general" articles that hide an
    // article number before the publication counter: "- ARTICLE - COUNTER Lien ELI".
    // Deduplicate by ELI: one review item per unique (logKey, eli) pair.
    const eliMap = new Map(); // eli → { rawText, articles: Set }
    for (const base of (entry.legalBases || [])) {
      if (base.article === 'general' && base.eli) {
        const rawText = base.legalBasisFR || base.legalBasisNL || '';
        const articles = extractOldStyleArticleWithEli(rawText);
        if (articles) {
          if (!eliMap.has(base.eli)) {
            eliMap.set(base.eli, { rawText, articles: new Set() });
          }
          for (const a of articles) eliMap.get(base.eli).articles.add(a);
        }
      }
    }
    for (const [eli, { rawText, articles }] of eliMap) {
      toReview.push({
        type: 'eli',
        logKey,
        entry,
        eli,
        rawText,
        newArticles: [...articles],
      });
    }
  }

  if (toReview.length === 0) {
    logInfo(`${timestamp()} No "general" articles can be improved with the new detection.`);
    return;
  }

  logInfo(`${timestamp()} Found ${toReview.length} "general" article(s) that can be corrected.`);

  // Load settings for progress tracking
  const settings = loadSettings();
  const lastProcessedIdx = settings.fixArticlesLastIdx ?? -1;

  // If resuming, skip already-processed entries
  const startIdx = lastProcessedIdx + 1;
  if (startIdx > 0 && startIdx < toReview.length) {
    logInfo(`${timestamp()} Resuming from entry ${startIdx + 1}/${toReview.length} (after index ${lastProcessedIdx})`);
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
    const { type, logKey, entry, base, eli, rawText, newArticles } = item;

    progress.clear();
    console.log('');
    logInfo(chalk.bold(`[${i + 1}/${total}]`) + ` ${entry.ecli} (${entry.date})`);
    logInfo(`  Raw: ${chalk.cyan(rawText)}`);
    logInfo(`  Current: article=${chalk.red('general')}  →  New: article=${chalk.green(newArticles.join(', '))}`);
    if (type === 'eli') {
      logInfo(`  ELI | ${eli}`);
      logInfo(`  File: ${eliToFilename(eli)}`);
    } else {
      logInfo(`  Missing ELI | key: ${base.rawLegalBasisText}`);
    }

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
      settings.fixArticlesLastIdx = i;
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
      if (type === 'eli') {
        // Fix in ELI data file: move ECLI from general → specific article key(s)
        const filename = eliToFilename(eli);
        const data = loadDataFile(filename);
        if (data && data.general && data.general[entry.ecli]) {
          const ecliData = data.general[entry.ecli];
          for (const art of newArticles) {
            if (!data[art]) data[art] = {};
            data[art][entry.ecli] = ecliData;
          }
          delete data.general[entry.ecli];
          if (Object.keys(data.general).length === 0) delete data.general;
          saveDataFile(filename, data);
          logSuccess(`  ✔ Updated ${filename}: general → [${newArticles.join(', ')}]`);
        } else if (!data) {
          logWarn(`  ⚠ File ${filename} not found — skipping`);
        } else {
          logWarn(`  ⚠ ${entry.ecli} not found in general for ${filename} — may already be fixed`);
        }
      } else {
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
      }
      correctedCount++;
    } else {
      skippedCount++;
    }

    // Record progress
    settings.fixArticlesLastIdx = i;
    progress.doneIndexes = i + 1;
    progress.render();
  }

  progress.finish();

  // Save settings & flush on completion; clear resume index
  delete settings.fixArticlesLastIdx;
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
