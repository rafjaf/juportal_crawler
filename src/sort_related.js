/**
 * --sort-related <ELI> <article> implementation
 *
 * For each judgement in the source ELI's data file that is mapped to a given
 * article via the equivalence table ("related" key of the target ELI), asks a
 * LLM to verify whether the judgement truly concerns the specified article or
 * should instead be reclassified under another article.
 *
 * The result is written as a "relatedArticle" key (string or array of strings)
 * on each judgement record in the source data file, overriding the equivalence
 * table for downstream consumers.
 *
 * Interactive flow per judgement:
 *   y / Enter  — accept the LLM's recommendation
 *   a          — accept this recommendation and auto-apply all future items
 *   q          — quit (changes already saved are kept)
 *   <art>;<art> — enter one or more articles manually, separated by semicolons
 */

import chalk from 'chalk';
import readline from 'node:readline';
import { logInfo, logSuccess, logWarn, logError, timestamp } from './logger.js';
import { loadDataFile, saveDataFile, loadSettings, saveSettings } from './storage.js';
import { eliToFilename, normalizeEliToFrench } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
/** Default model for this feature. Can be overridden by settings.openai_sort_related_model. */
const SORT_RELATED_DEFAULT_MODEL = 'gpt-5.4-nano';

/** Per-session in-memory cache of data files to avoid repeated disk reads. */
const _dataFileCache = new Map();

/** Number of judgements sent to the LLM in a single API call. */
const BATCH_SIZE = 10;

/** Minimum confidence level for the LLM recommendation to be used as default. */
const MIN_AUTO_CONFIDENCE = 'high';

/**
 * Abstract phrases that indicate an unavailable translation.
 * When all French abstracts consist only of these phrases, fall back to Dutch.
 */
const TRANSLATION_UNAVAILABLE_PHRASES = [
  'traduction non disponible',
  'traduction non encore disponible',
];

// ─── Per-ELI article instructions ────────────────────────────────────────────

/**
 * Instructions keyed by the target ELI data filename.
 * Each entry is an array of { article, description } objects.
 * The article "6.5" is the fallback / default article and should be listed FIRST.
 */
const ELI_ARTICLE_INSTRUCTIONS = new Map([
  [
    'eli_loi_2024_02_27_2024A01600_justel.json',
    [
      { article: '6.5',   description: 'solution à retenir par défaut ou en cas de doute. C\'est l\'article de base relatif à la responsabilité civile extracontractuelle' },
      { article: '6.1',   description: 'caractère supplétif de la responsabilité extracontractuelle, possibilité d\'y déroger par contrat (clauses exonératoires)' },
      { article: '6.2',   description: 'cumul de la responsabilité extracontractuelle avec d\'autres actions' },
      { article: '6.3',   description: 'concours entre la responsabilité contractuelle et extra-contractuelle; coexistence de ces deux responsabilités envers un tiers; immunité de l\'agent d\'exécution (hulppersoon)' },
      { article: '6.4',   description: 'application de la responsabilité extracontractuelle aux personnes morales' },
      { article: '6.6',   description: 'définition et critères de la faute' },
      { article: '6.7',   description: 'force majeure' },
      { article: '6.8',   description: 'causes de justifications : erreur invincible, état de nécessité, légitime défense, ordre de la loi ou de l\'autorité, consentement de la victime' },
      { article: '6.9',   description: 'responsabilité personnelle du mineur' },
      { article: '6.11',  description: 'responsabilité de la personne atteinte d\'un trouble mental ou d\'un majeur dépourvu de la capacité de discernement' },
      { article: '6.12',  description: 'responsabilité des parents pour les fautes de leur enfant mineur (ancien article 1384, al. 2)' },
      { article: '6.13',  description: 'responsabilité des enseignants et instituteurs (ancien article 1384, al. 4)' },
      { article: '6.14',  description: 'responsabilité des maîtres et commettants pour leurs préposés (ancien article 1384, al. 3)' },
      { article: '6.15',  description: 'responsabilité des personnes morales du fait de leurs organes' },
      { article: '6.16',  description: 'responsabilité du fait des choses vicieuses' },
      { article: '6.17',  description: 'responsabilité du fait des animaux' },
      { article: '6.18',  description: 'lien causal en général, équivalence des conditions (sans la faute le dommage se serait produit de la même manière), alternative légitime (remplacement du comportement fautif par son exécution correcte)' },
      { article: '6.19',  description: 'responsabilité in solidum ou solidaire en cas de co-auteurs' },
      { article: '6.20',  description: 'partage de responsabilité en cas de faute de la victime' },
      { article: '6.21',  description: 'action récursoire entre coresponsables' },
      { article: '6.22',  description: 'perte d\'une chance' },
      { article: '6.24',  description: 'notion de base du dommage et caractère légitime; dommage consistant pour la victime à devoir verser une indemnité à un tiers (obligation propre de réparation)' },
      { article: '6.25',  description: 'caractère certain du dommage' },
      { article: '6.26',  description: 'dommage moral' },
      { article: '6.27',  description: 'dommage par ricochet' },
      { article: '6.28',  description: 'mesure à prendre par la victime ou le responsable pour prévenir le dommage ou son aggravation' },
      { article: '6.29',  description: 'prédispositions pathologiques de la victime à subir le dommage et état antérieur de la victime' },
      { article: '6.30',  description: 'principe de la réparation intégrale' },
      { article: '6.32',  description: 'moment de la détermination de l\'étendue du dommage; prise en compte d\'événements postérieurs étrangers à la faute ou au dommage' },
      { article: '6.33',  description: 'réparation en nature' },
      { article: '6.34',  description: 'réparation du préjudice corporel par rente, forfait ou capitalisation' },
      { article: '6.35',  description: 'cumul d\'indemnités; efforts accrus de la victime; libéralités consenties à la victime' },
      { article: '6.36',  description: 'évaluation distincte des postes du dommage; évaluation en équité, ex aequo et bono' },
      { article: '6.38',  description: 'dommage matériel aux choses' },
      { article: '6.39',  description: 'libre disposition de l\'indemnité' },
      { article: '6.41',  description: 'responsabilité du fait des produits défectueux' },
      { article: '5.241', description: 'intérêts compensatoires' },
    ],
  ],
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function promptUserFn(question) {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    process.stdin.ref();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      process.stdin.resume();
      if (wasRaw) {
        process.stdin.setRawMode(true);
        process.stdin.unref();
      }
      resolve(answer.trim());
    });
  });
}

/**
 * Get the OpenAI API key from settings, or prompt the user to enter it.
 */
async function getOrPromptApiKey() {
  const settings = loadSettings();
  if (settings.openai_api_key) return settings.openai_api_key;

  console.log('');
  logWarn('  OpenAI API key not found in settings.json.');
  const key = await promptUserFn(chalk.yellow('  Enter your OpenAI API key: ') + chalk.bold('> '));
  const trimmed = key.trim();
  if (!trimmed) return null;

  settings.openai_api_key = trimmed;
  saveSettings(settings);
  return trimmed;
}

/**
 * Select the best abstract text for a judgement.
 * Prefers French unless all French abstracts are translation placeholders.
 * Returns a string or null.
 */
function selectAbstract(judgement) {
  const isPlaceholder = (text) =>
    TRANSLATION_UNAVAILABLE_PHRASES.some(p => text.toLowerCase().trim().startsWith(p));

  const frTexts = Array.isArray(judgement.abstractFR) ? judgement.abstractFR : [];
  const nlTexts = Array.isArray(judgement.abstractNL) ? judgement.abstractNL : [];

  const usableFR = frTexts.filter(t => t && !isPlaceholder(t));
  if (usableFR.length > 0) return usableFR.join(' / ');

  const usableNL = nlTexts.filter(t => t && !isPlaceholder(t));
  if (usableNL.length > 0) return `[NL] ${usableNL.join(' / ')}`;

  return null;
}

/**
 * Build the stable system prompt for the given ELI's article instructions.
 * This text is kept constant across all batches so OpenAI can cache it.
 */
function buildSystemPrompt(instructions) {
  const articleLines = instructions
    .map(({ article, description }) => `- Art. ${article} : ${description}`)
    .join('\n');

  return (
    'Tu es un juriste belge expert en droit de la responsabilité civile extracontractuelle. ' +
    'Tu analyses des résumés de décisions de justice belges (en français ou en néerlandais) ' +
    'et tu détermines lequel ou lesquels parmi les articles suivants correspond le mieux au ' +
    'contenu principal de chaque résumé.\n\n' +
    'Articles pertinents (avec leur portée principale) :\n' +
    articleLines + '\n\n' +
    'Règles importantes :\n' +
    '1. L\'article 6.5 est subsidiaire : ne le retiens que si aucun autre article ne convient mieux. Ne l\'inclus JAMAIS dans ta réponse si tu retiens un ou plusieurs autres articles.\n' +
    '2. Pour qu\'un article autre que 6.5 soit attribué, il doit être au cœur du résumé, pas seulement mentionné en passant.\n' +
    '3. Si le résumé porte sur plusieurs sujets distincts couverts par des articles différents (autres que 6.5), tu peux attribuer plusieurs articles.\n' +
    '4. Tu réponds exclusivement par un objet JSON — sans markdown ni prose en dehors du JSON.\n' +
    '5. Champ "confidence" : "high" = tu es certain(e), "medium" = probable, "low" = incertain(e).'
  );
}

/**
 * Build the user prompt for a batch of judgements.
 */
function buildUserPrompt(batch) {
  const lines = [
    'Analyse les résumés suivants et retourne pour chacun le ou les articles applicables.',
    'Format de réponse (respecte-le exactement) :',
    '{"classifications":[{"index":1,"articles":["6.5"],"confidence":"high","reasoning":"<une phrase concise>"},...]}',
    '',
    'Résumés à analyser :',
  ];

  for (let i = 0; i < batch.length; i++) {
    const { ecli, abstract, date, court } = batch[i];
    lines.push('');
    lines.push(`[${i + 1}] ECLI: ${ecli}`);
    if (court || date) lines.push(`    Juridiction: ${court || '?'}  Date: ${date || '?'}`);
    lines.push(`    Résumé: ${abstract || '(aucun résumé disponible)'}`);
  }

  return lines.join('\n');
}

/**
 * Call the OpenAI API to classify a batch of judgements.
 */
async function classifyBatch(apiKey, systemPrompt, batch, model) {
  const userPrompt = buildUserPrompt(batch);

  let response;
  try {
    response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    logWarn(`  ⚠ API call failed: ${err.message}`);
    return null;
  }

  if (!response.ok) {
    const errText = await response.text();
    logWarn(`  ⚠ API error ${response.status}: ${errText.substring(0, 200)}`);
    return null;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    logWarn(`  ⚠ API returned empty content`);
    return null;
  }

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.classifications)) {
      logWarn(`  ⚠ Unexpected response structure: ${content.substring(0, 200)}`);
      return null;
    }
    return parsed.classifications;
  } catch (err) {
    logWarn(`  ⚠ Failed to parse JSON response: ${err.message}\n    Raw: ${content.substring(0, 300)}`);
    return null;
  }
}

/**
 * Parse manual article input: "6.5 ; 6.18" → ["6.5", "6.18"]
 */
function parseManualArticles(input) {
  return input
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Load a data file, using the per-session cache to avoid repeated disk reads.
 */
function loadCached(filename) {
  if (!_dataFileCache.has(filename)) {
    _dataFileCache.set(filename, loadDataFile(filename));
  }
  return _dataFileCache.get(filename);
}

/**
 * Write a relatedArticle value to a judgement in a data file.
 * Updates the in-memory cache and saves the file to disk immediately.
 */
function applyRelatedArticle(sourceFilename, oldArticle, ecli, articles) {
  const data = loadCached(sourceFilename);
  if (!data[oldArticle] || !data[oldArticle][ecli]) {
    logWarn(`  ⚠ Could not find ${ecli} under article ${oldArticle} in ${sourceFilename}`);
    return false;
  }
  const value = articles.length === 1 ? articles[0] : articles;
  data[oldArticle][ecli].relatedArticle = value;
  saveDataFile(sourceFilename, data);
  return true;
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Main entry point for --sort-related.
 *
 * @param {string} targetEli   - The ELI whose "related" mapping table is consulted
 *                               (e.g. https://…/eli/loi/2024/02/27/2024A01600/justel)
 * @param {string} targetArticle - The article in the target ELI to sort
 *                               (e.g. "6.5")
 */
export async function sortRelated(targetEli, targetArticle) {
  // ── 1. Resolve the target ELI data file ─────────────────────────────────────
  const normalizedTargetEli = normalizeEliToFrench(targetEli);
  const targetFilename = eliToFilename(normalizedTargetEli);

  logInfo(`${timestamp()} Loading target ELI: ${chalk.cyan(normalizedTargetEli)}`);
  logInfo(`${timestamp()} File: ${chalk.gray(targetFilename)}`);

  const targetData = loadDataFile(targetFilename);
  if (!targetData || Object.keys(targetData).length === 0) {
    logError(`✖ Data file not found or empty: ${targetFilename}`);
    process.exit(1);
  }

  // ── 2. Find the "related" mapping ────────────────────────────────────────────
  const related = targetData.related;
  if (!Array.isArray(related) || related.length === 0) {
    logError(`✖ No "related" key found in ${targetFilename}`);
    process.exit(1);
  }

  // ── 3. Find the equivalent old article(s) for targetArticle ──────────────────
  // Find all related entries that map targetArticle to old article number(s)
  // and collect them. A single related entry may map multiple old articles
  // to the same new article (e.g. "6.16": ["1384", "1385"]).
  const equivalences = []; // { fromELI, oldArticle }
  for (const entry of related) {
    const articlesMap = entry.articles || {};
    if (targetArticle in articlesMap) {
      const fromELI = entry.fromELI;
      if (!fromELI) continue;
      const oldArticles = articlesMap[targetArticle];
      for (const oldArt of (Array.isArray(oldArticles) ? oldArticles : [oldArticles])) {
        equivalences.push({ fromELI: normalizeEliToFrench(fromELI), oldArticle: oldArt });
      }
    }
  }

  if (equivalences.length === 0) {
    logError(`✖ Article ${chalk.cyan(targetArticle)} not found in any "related" mapping in ${targetFilename}`);
    process.exit(1);
  }

  logInfo(`${timestamp()} Equivalences found for article ${chalk.cyan(targetArticle)}:`);
  for (const { fromELI, oldArticle } of equivalences) {
    logInfo(`  ${chalk.gray(fromELI)} → article ${chalk.cyan(oldArticle)}`);
  }

  // ── 4. Load the instructions for this ELI ────────────────────────────────────
  const instructions = ELI_ARTICLE_INSTRUCTIONS.get(targetFilename);
  if (!instructions) {
    logError(`✖ No article instructions defined for ${targetFilename}.`);
    logError(`  Add an entry to ELI_ARTICLE_INSTRUCTIONS in src/sort_related.js`);
    process.exit(1);
  }

  // ── 5. Collect judgements to process ─────────────────────────────────────────
  // For each equivalence (fromELI, oldArticle), gather judgements that don't
  // yet have a "relatedArticle" key.
  const toProcess = []; // { ecli, date, court, abstract, sourceFilename, oldArticle }

  for (const { fromELI, oldArticle } of equivalences) {
    const sourceFilename = eliToFilename(fromELI);
    const sourceData = loadCached(sourceFilename);

    if (!sourceData[oldArticle]) {
      logWarn(`  ⚠ Article ${oldArticle} not found in ${sourceFilename} — skipping`);
      continue;
    }

    const articleData = sourceData[oldArticle];
    let skipped = 0;
    let added = 0;

    for (const [ecli, judgement] of Object.entries(articleData)) {
      if ('relatedArticle' in judgement) {
        skipped++;
        continue;
      }
      const abstract = selectAbstract(judgement);
      toProcess.push({
        ecli,
        date: judgement.date || null,
        court: judgement.court || null,
        abstract,
        sourceFilename,
        oldArticle,
      });
      added++;
    }

    logInfo(`  ${chalk.cyan(sourceFilename)} art.${oldArticle}: ${added} to process, ${skipped} already have relatedArticle`);
  }

  if (toProcess.length === 0) {
    logSuccess(`✔ Nothing to process — all judgements already have a "relatedArticle" key.`);
    return;
  }

  logInfo(`\n${timestamp()} ${chalk.bold(`${toProcess.length} judgement(s) to analyse`)}`);
  logInfo(`  Model: ${chalk.cyan(SORT_RELATED_DEFAULT_MODEL)}, batch size: ${BATCH_SIZE}`);

  // ── 6. Get API key and model ──────────────────────────────────────────────────
  const apiKey = await getOrPromptApiKey();
  if (!apiKey) {
    logError('✖ No API key provided. Aborting.');
    process.exit(1);
  }

  const settings = loadSettings();
  const model = settings.openai_sort_related_model || SORT_RELATED_DEFAULT_MODEL;
  logInfo(`  Using model: ${chalk.cyan(model)}`);

  // ── 7. Build the stable system prompt (cached by OpenAI across batches) ───────
  const systemPrompt = buildSystemPrompt(instructions);

  // ── 8. Main processing loop ───────────────────────────────────────────────────
  let autoApply = false;
  let processedCount = 0;
  let appliedCount = 0;
  let skippedCount = 0;

  const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const batch = toProcess.slice(start, start + BATCH_SIZE);
    const batchNum = batchIdx + 1;

    logInfo(`\n${timestamp()} ${chalk.bold(`Batch ${batchNum}/${totalBatches}`)} (${batch.length} judgement(s))…`);

    // Call LLM
    const classifications = await classifyBatch(apiKey, systemPrompt, batch, model);

    // Build a lookup map by index (1-based)
    const classMap = new Map();
    if (classifications) {
      for (const c of classifications) {
        const idx = parseInt(c.index, 10);
        if (Number.isFinite(idx) && idx >= 1 && idx <= batch.length) {
          classMap.set(idx, c);
        }
      }
    }

    // Process each item in the batch
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      processedCount++;

      const classification = classMap.get(i + 1) || null;
      const isHighConfidence = classification?.confidence === 'high';
      const isUsableConfidence = classification?.confidence === 'high' || classification?.confidence === 'medium';
      // 6.5 is subsidiary: drop it when the LLM also identified more specific articles
      const rawLlmArticles = classification?.articles || null;
      const llmArticles = rawLlmArticles && rawLlmArticles.length > 1
        ? rawLlmArticles.filter(a => a !== '6.5')
        : rawLlmArticles;
      const llmReasoning = classification?.reasoning || null;

      // ── Display ────────────────────────────────────────────────────────────
      console.log('');
      console.log(chalk.bold.cyan(`── [${processedCount}/${toProcess.length}] ──────────────────────────────`));
      console.log(chalk.bold(`Jugement : ${item.ecli}`));
      if (item.date || item.court) {
        console.log(chalk.gray(`  Court: ${item.court || '?'}  Date: ${item.date || '?'}`));
      }
      console.log(chalk.gray(`  Source: ${item.sourceFilename} art. ${item.oldArticle}`));
      console.log('');

      if (item.abstract) {
        console.log(chalk.bold('Résumé :'));
        // Wrap at ~100 chars for readability
        const words = item.abstract.split(' ');
        let line = '  ';
        for (const word of words) {
          if (line.length + word.length > 100) {
            console.log(line);
            line = '  ';
          }
          line += word + ' ';
        }
        if (line.trim()) console.log(line);
      } else {
        console.log(chalk.gray('  (aucun résumé disponible)'));
      }

      console.log('');

      if (classification) {
        const confColor = isHighConfidence ? chalk.green : classification.confidence === 'medium' ? chalk.yellow : chalk.red;
        console.log(chalk.bold('LLM → ') +
          chalk.cyan(Array.isArray(llmArticles) ? llmArticles.join(', ') : '?') +
          '  ' + confColor(`[${classification.confidence}]`));
        if (llmReasoning) console.log(chalk.gray(`  Raisonnement : ${llmReasoning}`));
      } else {
        console.log(chalk.gray('  (pas de classification LLM disponible)'));
      }

      // In auto-apply mode, apply high and medium confidence results; skip low
      if (autoApply) {
        if (isUsableConfidence && llmArticles?.length > 0) {
          const ok = applyRelatedArticle(item.sourceFilename, item.oldArticle, item.ecli, llmArticles);
          if (ok) {
            logSuccess(`  ✔ Auto-applied (${classification.confidence}): ${llmArticles.join(', ')}`);
            appliedCount++;
          }
        } else {
          logWarn(`  ↷ Skipped (confidence: ${classification?.confidence || 'none'})`);
          skippedCount++;
        }
        continue;
      }

      // ── Interactive prompt ─────────────────────────────────────────────────
      const defaultHint = llmArticles?.length > 0
        ? chalk.gray(`Enter/y=${llmArticles.join(';')}/`)
        : '';
      const resp = await promptUserFn(
        chalk.yellow('  Appliquer? ') +
        defaultHint +
        chalk.gray('(y=oui/s=ignorer/a=auto/q=quitter ou saisir les articles séparés par ;) ') +
        chalk.bold('> ')
      );

      const respLc = resp.toLowerCase();

      if (respLc === 'q' || respLc === 'quit') {
        logInfo(`${timestamp()} Arrêt demandé. Les modifications déjà sauvegardées sont conservées.`);
        printSummary(processedCount, appliedCount, skippedCount, toProcess.length);
        return;
      }

      if (respLc === 'a') {
        autoApply = true;
        // Also apply the current item if high confidence
        if (isHighConfidence && llmArticles?.length > 0) {
          const ok = applyRelatedArticle(item.sourceFilename, item.oldArticle, item.ecli, llmArticles);
          if (ok) {
            logSuccess(`  ✔ Appliqué : ${llmArticles.join(', ')}`);
            appliedCount++;
          }
        } else {
          logWarn(`  ↷ Ignoré (confiance insuffisante pour auto-appliquer)`);
          skippedCount++;
        }
        continue;
      }

      // Empty input → accept LLM recommendation if high confidence
      if (resp === '' && isHighConfidence && llmArticles?.length > 0) {
        const ok = applyRelatedArticle(item.sourceFilename, item.oldArticle, item.ecli, llmArticles);
        if (ok) {
          logSuccess(`  ✔ Appliqué : ${llmArticles.join(', ')}`);
          appliedCount++;
        }
        continue;
      }

      // 'y' → accept LLM recommendation
      if ((respLc === 'y' || respLc === 'yes') && llmArticles?.length > 0) {
        const ok = applyRelatedArticle(item.sourceFilename, item.oldArticle, item.ecli, llmArticles);
        if (ok) {
          logSuccess(`  ✔ Appliqué : ${llmArticles.join(', ')}`);
          appliedCount++;
        }
        continue;
      }

      // 's' → skip explicitly
      if (respLc === 's' || respLc === 'skip') {
        logWarn(`  ↷ Ignoré`);
        skippedCount++;
        continue;
      }

      // Manual article entry
      if (resp && resp !== '' && respLc !== 'n') {
        const manual = parseManualArticles(resp);
        if (manual.length > 0) {
          const ok = applyRelatedArticle(item.sourceFilename, item.oldArticle, item.ecli, manual);
          if (ok) {
            logSuccess(`  ✔ Saisi manuellement : ${manual.join(', ')}`);
            appliedCount++;
          }
          continue;
        }
      }

      // Default: skip
      logWarn(`  ↷ Ignoré`);
      skippedCount++;
    }
  }

  printSummary(processedCount, appliedCount, skippedCount, toProcess.length);
}

function printSummary(processed, applied, skipped, total) {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║         SORT-RELATED COMPLETE            ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════╝'));
  logSuccess(`  Appliqués :  ${applied}`);
  if (skipped > 0) logWarn(`  Ignorés :    ${skipped}`);
  logInfo(`  Traités :    ${processed} / ${total}`);
  logInfo('');
}
