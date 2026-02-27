import chalk from 'chalk';
import xml2js from 'xml2js';
import { ROBOTS_TXT_URL, RE_ART_REF_WITH_COUNTER, RE_ART_REF_NO_COUNTER, RE_ART_REF_NO_DATE, RE_REF_NO_ART, RE_LEGAL_PRINCIPLE } from './constants.js';
import { logInfo, logWarn, logSuccess, timestamp } from './logger.js';
import { fetchWithRetry } from './fetch.js';
import {
  normalizeWhitespace,
  normalizeEliToFrench,
  normalizeCgiUrl,
  parseArticleNumbers,
  extractLegalBasisKey,
  extractDateFromBasisText,
  buildBasisTextLookup,
} from './utils.js';

// ─── robots.txt Parsing ──────────────────────────────────────────────────────

/**
 * Parse robots.txt and extract sitemap index URLs, sorted most recent first.
 */
export async function fetchSitemapIndexUrls() {
  logInfo(`${timestamp()} Fetching robots.txt from ${ROBOTS_TXT_URL}...`);
  const text = await fetchWithRetry(ROBOTS_TXT_URL);
  
  const lines = text.split('\n');
  const sitemapUrls = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Sitemap:')) {
      const url = trimmed.replace('Sitemap:', '').trim();
      sitemapUrls.push(url);
    }
  }

  logSuccess(`✔ Found ${sitemapUrls.length} sitemap index URLs in robots.txt`);
  
  // Sort by date descending (most recent first)
  // URL format: .../YYYY/MM/DD/sitemap_index_N.xml
  sitemapUrls.sort((a, b) => {
    const dateA = extractDateFromUrl(a);
    const dateB = extractDateFromUrl(b);
    return dateB.localeCompare(dateA);
  });

  return sitemapUrls;
}

/**
 * Extract a date string (YYYY/MM/DD) from a sitemap URL for sorting.
 */
export function extractDateFromUrl(url) {
  const match = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return '0000-00-00';
}

// ─── Sitemap Index Parsing ───────────────────────────────────────────────────

/**
 * Fetch a sitemap index and return the list of sitemap URLs it contains.
 */
export async function fetchSitemapUrls(sitemapIndexUrl) {
  const xml = await fetchWithRetry(sitemapIndexUrl);
  const result = await xml2js.parseStringPromise(xml, { explicitArray: false });
  
  const sitemapIndex = result.sitemapindex;
  if (!sitemapIndex || !sitemapIndex.sitemap) {
    logWarn(`⚠ No sitemaps found in ${sitemapIndexUrl}`);
    return [];
  }

  // Ensure it's an array
  const sitemaps = Array.isArray(sitemapIndex.sitemap) 
    ? sitemapIndex.sitemap 
    : [sitemapIndex.sitemap];

  return sitemaps.map(s => s.loc).filter(Boolean);
}

// ─── Sitemap XML Parsing ─────────────────────────────────────────────────────

/**
 * Parse a sitemap XML and extract judgement data.
 * Returns null if the judgement is not from CASS court.
 */
export async function parseSitemapXml(sitemapUrl) {
  const xml = await fetchWithRetry(sitemapUrl);
  const result = await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    tagNameProcessors: [name => name.replace(/^ecli:/, '')],
    attrNameProcessors: [],
  });

  const urlset = result.urlset;
  if (!urlset || !urlset.url) {
    logWarn(`⚠ No URL entry found in ${sitemapUrl}`);
    return null;
  }

  const urlEntry = urlset.url;
  const doc = urlEntry.document;
  if (!doc || !doc.metadata) {
    logWarn(`⚠ No ecli:document/metadata found in ${sitemapUrl}`);
    return null;
  }

  const meta = doc.metadata;

  // ─── Court check ───
  const isVersionOf = meta.isVersionOf;
  const court = isVersionOf?.court;
  if (court !== 'CASS') {
    return { skipped: true, court };
  }

  // ─── ECLI ───
  const ecli = isVersionOf?.$?.value || isVersionOf?.value;

  // Skip conclusions (CONC); only process judgements (ARR)
  if (!ecli || !ecli.includes('ARR')) {
    return { skipped: true, court, ecli };
  }

  // ─── Date ───
  const judgementDate = meta.date;

  // ─── Identifiers (URLs) ───
  // We want the one with type="summarised"
  const identifiers = Array.isArray(meta.identifier) ? meta.identifier : [meta.identifier];
  let judgementUrl = null;
  for (const id of identifiers) {
    if (id?.$?.type === 'summarised') {
      judgementUrl = id._ || id;
      break;
    }
  }
  // Fallback: use first identifier if no summarised found
  if (!judgementUrl && identifiers.length > 0) {
    const first = identifiers[0];
    judgementUrl = first?._ || first;
    logWarn(`⚠ No 'summarised' identifier found, using first identifier for ${ecli}`);
  }

  // ─── Abstracts ───
  const abstractsFR = [];
  const abstractsNL = [];
  const rawAbstracts = meta.abstract;
  if (rawAbstracts) {
    const abstracts = Array.isArray(rawAbstracts) ? rawAbstracts : [rawAbstracts];
    for (const abs of abstracts) {
      const lang = abs?.$?.lang;
      const text = normalizeWhitespace(abs?._ || abs || '');
      if (!text) continue;
      if (lang === 'fr') {
        abstractsFR.push(text);
      } else if (lang === 'nl') {
        abstractsNL.push(text);
      }
    }
  }

  // ─── References: role number, legal bases with ELI ───
  let roleNumber = null;
  const legalBases = []; // { article, eli } — resolved
  const legalBasesWithoutEli = []; // { article, rawText } — ELI absent in XML
  const allBasisTexts = []; // { article, rawText, lang } — for FR/NL correlation
  
  const rawRefs = meta.reference;
  if (rawRefs) {
    const refs = Array.isArray(rawRefs) ? rawRefs : [rawRefs];
    
    // Parse references - ELI follows the article(s) it applies to
    // We need to track the current "law" group to associate articles with their ELI
    let currentArticles = []; // articles pending an ELI assignment
    let currentLawKey = null; // the law descriptor to group articles
    const lawKeyEliCache = {}; // lawKey → last ELI seen for that law (handles repeated articles without repeated ELI)
    
    for (const ref of refs) {
      const type = ref?.$?.type;
      const lang = ref?.$?.lang;
      // Collapse internal whitespace so multiline XML text values match cleanly
      const text = normalizeWhitespace((ref?._ || ref || '').toString());

      if (type === 'OTHER') {
        // Check for role number
        if (text.startsWith('Numéro de rôle') || text.startsWith('Rolnummer')) {
          roleNumber = text.replace(/^(Numéro de rôle|Rolnummer)\s*/, '').trim();
          continue;
        }

        // Check if it's a URL (not an article reference)
        if (text.startsWith('http://') || text.startsWith('https://')) {
          // This is a non-ELI law URL (e.g. ejustice.just.fgov.be/cgi_loi/...)
          // Treat it similarly to an ELI for the pending articles
          if (currentArticles.length > 0) {
            if (currentLawKey) lawKeyEliCache[currentLawKey] = text;
            for (const art of currentArticles) {
              art.eli = text;
            }
            legalBases.push(...currentArticles);
            currentArticles = [];
            currentLawKey = null;
          }
          continue;
        }

        // Detect general legal principles: no ELI, no article number, no law date.
        // e.g. "Principe général du droit van ...", "Algemeen rechtsbeginsel van ..."
        if (RE_LEGAL_PRINCIPLE.test(text)) {
          // Flush any pending articles for the previous law group first
          if (currentArticles.length > 0) {
            legalBasesWithoutEli.push(...currentArticles.map(a => ({ article: a.article, rawLegalBasisText: extractLegalBasisKey(a.rawText) })));
            currentArticles = [];
            currentLawKey = null;
          }
          logInfo(chalk.gray(`${timestamp()}       Legal principle (XML) | raw="${text}" | no ELI`));
          legalBasesWithoutEli.push({ article: null, rawLegalBasisText: text });
          continue;
        }

        // Parse article reference: "Law name - DD-MM-YYYY - [prefix] Art. X [- NN]"
        // Also matches no-date forms (RE_ART_REF_NO_DATE).
        // The trailing counter (- NN) is optional; support Art., Artt., Ar., At., etc.
        const artMatch =
          text.match(RE_ART_REF_WITH_COUNTER) ||
          text.match(RE_ART_REF_NO_COUNTER) ||
          text.match(RE_ART_REF_NO_DATE);
        if (artMatch) {
          // Derive the law name from the full text rather than a regex capture group,
          // keeping the regex signature consistent with judgement.js (one capture group).
          const lawName = extractLegalBasisKey(text);
          const rawArticles = artMatch[1].trim();
          
          const articles = parseArticleNumbers(rawArticles, text);
          
          // Build a law identifier key
          const newLawKey = lawName;
          
          logInfo(chalk.gray(`${timestamp()}       Legal basis (XML) | raw="${text}" | articles=[${articles.join(', ')}] | awaiting ELI`));

          if (newLawKey !== currentLawKey) {
            // New law group — flush previous articles that never received an ELI.
            // If the same law key appeared earlier and its ELI is cached, reuse it.
            if (currentArticles.length > 0) {
              const cachedEli = currentLawKey && lawKeyEliCache[currentLawKey];
              if (cachedEli) {
                for (const a of currentArticles) { a.eli = cachedEli; }
                legalBases.push(...currentArticles);
              } else {
                legalBasesWithoutEli.push(...currentArticles.map(a => ({ article: a.article, rawLegalBasisText: extractLegalBasisKey(a.rawText) })));
              }
            }
            currentArticles = [];
            currentLawKey = newLawKey;
          }
          
          for (const art of articles) {
            currentArticles.push({ article: art, eli: null, lang: lang || 'fr', rawText: text });
            allBasisTexts.push({ article: art, rawText: text, lang: lang || 'fr' });
          }
          continue;
        }

        // Detect a law reference with a date but no specific article → use "general".
        // e.g. "L. du 15 décembre 1980 ... - 15-12-1980 - 30 Lien ELI No pub 1980121550"
        //      "Directive 2014/41/UE ... - 03-04-2014"
        if (RE_REF_NO_ART.test(text)) {
          const newLawKey = extractLegalBasisKey(text);
          logInfo(chalk.gray(`${timestamp()}       No-article law ref (XML) | raw="${text}" | article=general | awaiting ELI`));
          // Flush previous articles for a different law group
          if (newLawKey !== currentLawKey) {
            if (currentArticles.length > 0) {
              const cachedEli = currentLawKey && lawKeyEliCache[currentLawKey];
              if (cachedEli) {
                for (const a of currentArticles) { a.eli = cachedEli; }
                legalBases.push(...currentArticles);
              } else {
                legalBasesWithoutEli.push(...currentArticles.map(a => ({ article: a.article, rawLegalBasisText: extractLegalBasisKey(a.rawText) })));
              }
            }
            currentArticles = [];
            currentLawKey = newLawKey;
          }
          currentArticles.push({ article: 'general', eli: null, lang: lang || 'fr', rawText: text });
          allBasisTexts.push({ article: 'general', rawText: text, lang: lang || 'fr' });
          continue;
        }
      }

      if (type === 'ELI') {
        // This ELI applies to all currentArticles
        if (currentArticles.length > 0) {
          if (currentLawKey) lawKeyEliCache[currentLawKey] = text;
          for (const art of currentArticles) {
            art.eli = text;
          }
          legalBases.push(...currentArticles);
          currentArticles = [];
          currentLawKey = null;
        }
        continue;
      }
    }

    // Flush remaining articles (those without an ELI).
    // Reuse the cached ELI for the law key if available.
    if (currentArticles.length > 0) {
      const cachedEli = currentLawKey && lawKeyEliCache[currentLawKey];
      if (cachedEli) {
        for (const a of currentArticles) { a.eli = cachedEli; }
        legalBases.push(...currentArticles);
      } else {
        legalBasesWithoutEli.push(...currentArticles.map(a => ({ article: a.article, rawLegalBasisText: extractLegalBasisKey(a.rawText) })));
      }
    }
  }

  // Deduplicate legal bases (same article + same ELI), keep only those with a resolvable ELI
  const basisTextLookup = buildBasisTextLookup(allBasisTexts);
  const seenBases = new Set();
  const uniqueBases = [];
  for (const lb of legalBases) {
    if (!lb.eli) continue;

    let eli = lb.eli;
    if (eli.includes('/eli/')) {
      // Normalize to French document type
      eli = normalizeEliToFrench(eli);
    } else if (eli.startsWith('http://') || eli.startsWith('https://')) {
      // Normalize cgi_wet → cgi_loi; keep cgi_loi as-is
      const normalized = normalizeCgiUrl(eli);
      if (!normalized) continue; // not a recognized cgi URL, skip
      eli = normalized;
    } else {
      continue;
    }

    const key = `${lb.article}|${eli}`;
    if (!seenBases.has(key)) {
      seenBases.add(key);
      const date = extractDateFromBasisText(lb.rawText || '') || 'no-date';
      const texts = basisTextLookup[`${lb.article}|${date}`] || {};
      uniqueBases.push({ ...lb, eli, legalBasisFR: texts.fr || null, legalBasisNL: texts.nl || null });
    }
  }

  // Enrich legalBasesWithoutEli with FR/NL raw texts
  for (const entry of legalBasesWithoutEli) {
    const date = extractDateFromBasisText(entry.rawLegalBasisText || '') || 'no-date';
    const texts = basisTextLookup[`${entry.article}|${date}`] || {};
    entry.legalBasisFR = texts.fr || null;
    entry.legalBasisNL = texts.nl || null;
  }

  return {
    skipped: false,
    court,
    ecli,
    judgementDate,
    judgementUrl,
    roleNumber,
    abstractsFR,
    abstractsNL,
    legalBases: uniqueBases,
    legalBasesWithoutEli,
  };
}
