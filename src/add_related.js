/**
 * --add-related: Inject cross-reference ("related") information into ELI
 * data files based on an article-mapping JSON file.
 *
 * A mapping file (e.g. old_to_new_civil_code_mapping.full.json) contains:
 *   { "from": "<source code name>", "to": "<target code name>",
 *     "articles": { "<sourceArticle>": ["<targetArticle>", …], … } }
 *
 * For each mapping the command:
 *  1. Resolves which ELI covers the source article  (via split_texts.json)
 *  2. Resolves which ELI covers the target article  (via split_texts.json)
 *  3. Opens the target ELI data file and adds/merges a top-level "related"
 *     array entry with { from, fromELI, articles: { targetArt: [sourceArt…] } }
 */

import fs from 'fs';
import chalk from 'chalk';
import { logInfo, logSuccess, logWarn, logError, timestamp } from './logger.js';
import { loadDataFile, saveDataFile } from './storage.js';
import { eliToFilename } from './utils.js';
import { findEliForArticle } from './split_texts.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_TEXTS = JSON.parse(readFileSync(join(__dirname, '..', 'split_texts.json'), 'utf8'));

/**
 * Find a split text definition by its French or Dutch name (exact match).
 */
function findSplitTextByName(name) {
  const nameLower = name.toLowerCase();
  for (const st of SPLIT_TEXTS) {
    for (const n of Object.values(st.names)) {
      if (n.toLowerCase() === nameLower) {
        return st;
      }
    }
  }
  return null;
}

/**
 * Process an article-mapping file and update the target ELI data files
 * with cross-reference information in a "related" key.
 */
export function addRelated(mappingFilePath) {
  // Load mapping file
  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(mappingFilePath, 'utf8'));
  } catch (err) {
    logError(`Cannot read mapping file ${mappingFilePath}: ${err.message}`);
    return;
  }

  const { from, to, articles } = mapping;
  if (!from || !to || !articles) {
    logError('Mapping file must have "from", "to", and "articles" keys.');
    return;
  }

  // Find split text definitions for source and target codes
  const fromSplitText = findSplitTextByName(from);
  const toSplitText = findSplitTextByName(to);

  if (!fromSplitText) {
    logError(`Cannot find split text definition for "${from}" in split_texts.json`);
    return;
  }
  if (!toSplitText) {
    logError(`Cannot find split text definition for "${to}" in split_texts.json`);
    return;
  }

  logInfo(`${timestamp()} Processing mapping: ${chalk.cyan(from)} → ${chalk.cyan(to)}`);
  logInfo(`  ${Object.keys(articles).length} source articles to process`);

  // Group updates by target filename → fromELI → { targetArticle: [sourceArticles] }
  // This minimises file I/O by batching all changes per data file.
  const updates = new Map();
  let processedCount = 0;
  let skippedCount = 0;

  for (const [sourceArticle, targetArticles] of Object.entries(articles)) {
    if (!targetArticles || targetArticles.length === 0) {
      skippedCount++;
      continue;
    }

    // Find the ELI that covers this source article
    const sourceEli = findEliForArticle(fromSplitText, sourceArticle);
    if (!sourceEli) {
      logWarn(`  ⚠ Cannot find ELI for source article ${sourceArticle} in "${from}"`);
      skippedCount++;
      continue;
    }

    for (const targetArticle of targetArticles) {
      // Find the ELI that covers this target article
      const targetEli = findEliForArticle(toSplitText, targetArticle);
      if (!targetEli) {
        logWarn(`  ⚠ Cannot find ELI for target article ${targetArticle} in "${to}"`);
        skippedCount++;
        continue;
      }

      const targetFilename = eliToFilename(targetEli);

      // Initialise nested grouping structures
      if (!updates.has(targetFilename)) {
        updates.set(targetFilename, new Map());
      }
      const fileUpdates = updates.get(targetFilename);

      if (!fileUpdates.has(sourceEli)) {
        fileUpdates.set(sourceEli, {});
      }
      const eliArticles = fileUpdates.get(sourceEli);

      if (!eliArticles[targetArticle]) {
        eliArticles[targetArticle] = [];
      }
      if (!eliArticles[targetArticle].includes(sourceArticle)) {
        eliArticles[targetArticle].push(sourceArticle);
      }

      processedCount++;
    }
  }

  logInfo(`  ${processedCount} mappings resolved, ${skippedCount} skipped`);
  logInfo(`  Updating ${updates.size} data file(s)…`);

  // Apply updates to each target data file
  let filesUpdated = 0;
  for (const [filename, eliMap] of updates) {
    const data = loadDataFile(filename);

    // Build the new related entries for this file
    const newEntries = [];
    for (const [fromELI, arts] of eliMap) {
      newEntries.push({ from, fromELI, articles: arts });
    }

    // Merge with any existing "related" array
    if (Array.isArray(data.related)) {
      for (const newEntry of newEntries) {
        const existing = data.related.find(
          e => e.from === newEntry.from && e.fromELI === newEntry.fromELI
        );
        if (existing) {
          // Merge articles into the existing entry
          for (const [art, sources] of Object.entries(newEntry.articles)) {
            if (!existing.articles[art]) {
              existing.articles[art] = sources;
            } else {
              for (const s of sources) {
                if (!existing.articles[art].includes(s)) {
                  existing.articles[art].push(s);
                }
              }
            }
          }
        } else {
          data.related.push(newEntry);
        }
      }
    } else {
      data.related = newEntries;
    }

    saveDataFile(filename, data);
    filesUpdated++;
    logSuccess(`  ✔ ${filename} (${newEntries.reduce((n, e) => n + Object.keys(e.articles).length, 0)} article mappings)`);
  }

  logSuccess(`\n${timestamp()} Done — updated ${filesUpdated} file(s)`);
}
