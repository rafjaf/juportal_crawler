# Juportal Crawler

A Node.js crawler that extracts structured legal data from the [Juportal](https://juportal.be) website — specifically, abstracts of Belgian Court of Cassation (CASS) judgements. Data is extracted from sitemaps listed in `robots.txt`, processed from most recent to oldest, and exported as JSON files organised by ELI (European Legislation Identifier). The resulting dataset is consumed by the [Better Justel](https://github.com/rafjaf/BetterJustel) browser extension, which displays case law abstracts under each article of Belgian legislation.

## Installation

```bash
npm install
```

## Usage

```bash
node index.js [option]
```

### Options

| Option | Description |
|---|---|
| *(no arguments)* | Fetch all sitemap indexes from `robots.txt` and crawl them from most recent to oldest, skipping already-processed entries. |
| `<url>` | Process a single sitemap or sitemap index URL, bypassing the already-processed check. Accepts individual sitemap XML URLs or sitemap_index XML URLs (all children are processed). |
| `--process-missing-eli` | Re-process entries in `missing_eli.json` that now have an ELI assigned, integrating them into the data files. |
| `--fix-errors` | Re-process every sitemap listed in `errors.json` using the latest algorithm. Entries that are now successfully parsed are removed from `errors.json`. |
| `--find-missing-eli` | Search for the correct ELI of each entry in `missing_eli.json` by consulting `log.json` and the ejustice.be website. Interactive (yes/no/all/quit). |
| `--find-missing-eli <key>` | Same as above, but skips all entries before `<key>` and runs in auto mode (high-confidence proposals are applied automatically, others are skipped). |
| `--fix-articles-from-log` | Review `log.json` entries where `article="general"` was detected, and re-analyse them using the improved old-style article detection. Corrections are applied to data files and `missing_eli.json` interactively. |
| `--add-related <file>` | Read an article-mapping JSON file and inject cross-references into the target ELI data files. |
| `--sort-related <ELI> <art>` | For each judgement mapped to `<art>` via the equivalence table of `<ELI>`, ask the LLM whether the judgement truly pertains to that article or should be reclassified. |
| `--fix-tpcpp` | Re-examine CIC first-part data (1808111701) for articles 8–32 and move entries that actually belong to the TPCPP (1878041750) based on the law date in the original sitemap. |
| `--redo` | Re-crawl all sitemaps from `robots.txt`, ignoring the list of already-processed entries in `settings.json`. Judgements that already have data in `data/` (detected by their ECLI) are skipped automatically. |
| `--log` | Log each saved judgement to `log.json` with full detail (for debugging / auditing the crawl logic). |
| `--help`, `-h` | Show the help message. |

Press `q` at any time during a crawl to quit gracefully (all in-memory data is flushed to disk before exit).

## Output

Extracted judgements are stored as JSON files in the `data/` directory, one file per Belgian statute, named after its ELI identifier (e.g. `cgi_loi_loi_1804032230.json`). Each file contains an array of judgement records, each with the ECLI, date, article reference, and extracted abstract text.

## Credits

This crawler was written by Rafaël Jafferali.

## Disclaimer

**Important notice — please read carefully before using this software or the data it produces.**

- The judgement abstracts extracted by this crawler are drawn from publicly available data on [Juportal](https://juportal.be). They are in no way exhaustive: important decisions may be missing, may be misclassified or outdated, and may contain errors introduced during parsing. This dataset does not replace a systematic research on Juportal and other legal databases. **Never rely on this data, especially for professional use, without personally verifying each judgement in the original sources.**

- This software is still under development, has been partly written with the assistance of AI, and may therefore contain bugs or errors. Do not rely on it, especially for professional use, and always double-check results against official sources.

- The crawler accesses only publicly available information on Juportal. It does not guarantee that the data it produces is complete, accurate, or up to date.

- Do not hesitate to report any problem or suggested improvement, and/or to contribute to the source code.

## Terms and conditions

The use of this software is governed by the [GNU General Public License v3](./LICENSE). This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Additionally, the use of this software is governed by Belgian law and any dispute pertaining to the validity, interpretation, performance or extinction of the license agreement, as well as more generally any dispute in connection with this software, will be exclusively submitted to the courts having their seat in Nivelles (Belgium).
