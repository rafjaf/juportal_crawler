# Legal Basis Encoding in Juportal Sitemap Indexes

## Overview

Each judgement published on `juportal.just.fgov.be` is listed in an XML sitemap
file under `https://juportal.just.fgov.be/JUPORTAsitemap/{yyyy}/{mm}/{dd}/sitemap_N.xml`.
The sitemap encodes legal bases (laws and articles cited by the court) as a series
of `<ecli:reference>` elements. Their format has evolved significantly over time and
contains several traps for parsers.

---

## XML Structure

Each sitemap file contains exactly **one `<url>` entry** per file (one judgement per
sitemap XML). The relevant elements are all children of `<ecli:document><ecli:metadata>`.

```xml
<ecli:reference type="OTHER" lang="fr">...</ecli:reference>
<ecli:reference type="ELI"   lang="fr">...</ecli:reference>
```

The two `type` values serve different roles:
- **`type="OTHER"`** — human-readable references: article numbers, law names, dates, publication references, legal principles, role numbers.
- **`type="ELI"`** — machine-readable ELI URL for the preceding `OTHER` reference(s).

References always come in **pairs or groups**: one or more `OTHER` entries name
the law and article, then an `ELI` entry supplies the machine-readable identifier
for those articles. An `ELI` entry always refers to all immediately preceding
`OTHER` entries that belong to the same law (identified by law-key grouping).

---

## Reference Formats — `type="OTHER"`

### 1. Modern format with `Art.` prefix and publication counter (post ~2003)

The most common format. Three segments separated by ` - `:

```
Law Name - DD-MM-YYYY - Art. X[, Y, ...] [- NN]
```

Examples:
```
Loi - 15-12-1980 - Art. 74/6
Code judiciaire - 10-10-1967 - Art. 780, 3°, et 1138, 2°
Titre préliminaire du Code de procédure pénale - 17-04-1878 - Art. 3, 4 et 26 - 01
Loi - 03-07-1978 - Art. 15
```

Notes:
- The optional trailing ` - NN` (two-digit counter, e.g. `- 01`, `- 30`) disambiguates repeated article references for the same law. It does **not** indicate an article number.
- Article prefixes vary: `Art.`, `Artt.`, `Ar.`, `At.` — all must be handled.
- Article numbers can include letters: `136ter`, `74/6`, `555/16`.
- Multiple articles are comma- or "et"-separated: `Art. 3, 4 et 26`.
- An `ELI` reference immediately follows to supply the URL.

### 2. No-article format with date, followed by ELI (modern)

Used when the court cites a law in its entirety (no specific article), or when the
article number is embedded in the old field position but no `Art.` prefix is used:

```
Law Name - DD-MM-YYYY
Law Name - DD-MM-YYYY - NN [Lien ELI No pub NUMAC]
```

Examples:
```
Loi - 15-12-1980 - 30 Lien ELI No pub 1980121550
Directive 2014/41/UE du Parlement européen - 03-04-2014
```

The ` - NN [Lien ELI...]` suffix is a publication counter with optional Justel link
text — it is **not** an article number. An `ELI` reference follows.

**Regex used**: `RE_REF_NO_ART` = `/\d{2}-\d{2}-\d{4}\s*(?:-\s*\d+\b.*)?$/i`

### 3. Old-format single-segment (pre-ELI era, ~pre-2003)

Used in older sitemaps. Contains the law name and date but only a bare article number
as the final segment — **no `Art.` prefix and no publication counter**. Critically,
**no `ELI` reference follows**:

```
Law Name - DD-MM-YYYY - ArticleNumber
```

Examples:
```
Titre préliminaire du Code de procédure pénale - 17-04-1878 - 26
Loi - 03-07-1978 - 15
```

This format is **a subset of the no-article format** because the same
`RE_REF_NO_ART` regex matches it (it sees a date with an optional trailing number).
The article must be extracted by `extractOldStyleArticle()` which handles:
- bare numbers: `26`
- comma-qualified: `51,§4`
- ranges: `10-11`

**Without `extractOldStyleArticle` as fallback, the article is silently set to
`'general'`, causing the judgement to be stored under the wrong article key.**

### 4. Oldest format — no date, no ELI (pre-sitemap ELI era, ~pre-1995)

Used in the very oldest sitemap entries. Only law name and article number, no date:

```
Law Name - ArticleNumber
```

Examples:
```
ancien Code Civil - 544
Wetboek van Strafvordering - 26
```

**Regex used**: `RE_OLD_STYLE_ART_REF` = `/^.+\s*-\s*(\d+\w*(?:\s*,\s*\d+\w*)*)\s*$/`

These entries have no ELI and no date; they go directly to `legalBasesWithoutEli`.

### 5. Publication journal references

Distinguishable by a double-dash ` - - ` pattern:

```
ARRESTEN VAN HET HOF VAN CASSATIE - - 1995(P.785)
PASICRISIE BELGE - - 1995(I,P.811)
RECHTSKUNDIG WEEKBLAD - - 1995(96)(P.823-824)
```

These are **not legal bases** and must be skipped. The empty middle column (law date)
produces the ` - - ` signature.

### 6. General legal principles

No law, no date, no ELI. Recognisable by name:

```
Principe général du droit ...
Algemeen rechtsbeginsel ...
Legaliteitsbeginsel
```

**Regex used**: `RE_LEGAL_PRINCIPLE` = `/^(Principe général du droit|(?:\w+\s+)?\w*beginsel)\b/i`

### 7. Role number

A single entry per judgement:

```
Numéro de rôle : C.20.0123.F
Rolnummer : P.21.0456.N
```

### 8. URL references (non-ELI)

Some laws have no ELI URL but do have a `cgi_loi` URL embedded directly in an
`OTHER` reference (rather than as an `ELI` reference):

```
https://www.ejustice.just.fgov.be/cgi_loi/change_lg.pl?table_name=loi&cn=1966121931
```

These are treated like `ELI` references for article association purposes.

---

## Reference Format — `type="ELI"`

The ELI entry supplies a URL for the preceding law group:

```xml
<ecli:reference type="ELI" lang="fr">http://www.ejustice.just.fgov.be/eli/loi/1878/04/17/1878041750/justel</ecli:reference>
<ecli:reference type="ELI" lang="nl">http://www.ejustice.just.fgov.be/eli/wet/1878/04/17/1878041750/justel</ecli:reference>
```

Both `lang="fr"` and `lang="nl"` ELI entries appear for bilingual laws. They carry
the same NUMAC (`1878041750`) but different type paths (`loi` vs `wet`). All are
normalized to the French form internally (`/eli/loi/...`).

**Protocol**: ELI URLs in the XML use `http://` but internal constants use `https://`.
Comparison requires protocol normalization.

---

## Parsing Strategy in `sitemap.js`

The parser walks the `<ecli:reference>` list in document order and maintains a
**"pending articles" buffer** for the current law group:

1. `OTHER` with `Art.` → parse article(s), add to buffer, record law-key.
2. `OTHER` with no-article date format → try `extractOldStyleArticleWithEli` (two
   segments after date), fall back to `extractOldStyleArticle` (one segment), then
   fall back to `'general'`. Add to buffer.
3. `OTHER` with no-date → old-style, send directly to `legalBasesWithoutEli`.
4. `OTHER` with `Numéro de rôle` / `Rolnummer` → extract role number, skip.
5. `OTHER` that is a URL → flush buffer with this URL as ELI.
6. `OTHER` legal principle → flush buffer, add principle to `legalBasesWithoutEli`.
7. `OTHER` publication journal (double-dash) → skip.
8. `ELI` → flush pending buffer: assign this ELI to all buffered articles.

A **law-key ELI cache** (`lawKeyEliCache`) allows an ELI seen once for a law to be
reused if the same law appears again later without a new ELI entry.

After parsing, collected `legalBases` (with ELI) are deduplicated and ELI-corrected
(see below). `legalBasesWithoutEli` entries are routed to the missing-ELI pipeline.

---

## ELI Normalization and Correction

### Protocol: `http://` → `https://`

The XML consistently uses `http://` for ELI URLs. Internal code and file-naming
use `https://`. Always normalize before string comparison:

```js
function normalizeProtocol(url) {
  return (url || '').replace(/^http:\/\//, 'https://');
}
```

### Language: Dutch → French (`/eli/wet/` → `/eli/loi/`)

`normalizeEliToFrench()` converts Dutch document-type segments to French so a
single filename is used for bilingual laws.

### Date-based ELI correction (`correctEliByDate`)

Some sitemaps assign the wrong ELI to an article. The canonical case is the
TPCPP/CIC overlap (see below): the XML contains the CIC ELI
(`/eli/loi/1808/11/17/1808111701/justel`) but the raw text says `17-04-1878`.

`correctEliByDate(eli, article, rawTextDate)` detects this mismatch and redirects
to the correct ELI within the same `split_texts.json` group.

---

## Known Pitfall: TPCPP / CIC Overlap

### Background

Two Belgian laws share article numbers in the range 1–32:

| Law | ELI | Articles |
|-----|-----|---------|
| Titre préliminaire du Code de procédure pénale (17-04-1878) | `.../1878041750/justel` | 1–32 |
| Code d'instruction criminelle — Part 1 (17-11-1808) | `.../1808111701/justel` | 8–136ter |

The overlap zone (articles 8–32) is ambiguous.

### Root cause A — Wrong ELI in XML

Some sitemaps assign the CIC ELI to a TPCPP article even when the text clearly
says `17-04-1878`. The `correctEliByDate` function catches this by comparing the
date embedded in the ELI path with the date in the raw reference text.

### Root cause B — Correct ELI moved by `reassignSplitTextAbstracts`

Some sitemaps carry the correct TPCPP ELI from the start. Entries were
re-assigned to CIC because `split_texts.json` previously listed TPCPP as covering
only articles 1–7; articles 8–32 in the TPCPP file were then treated as out-of-range
and moved to CIC. Fixed by updating the TPCPP range to 1–32.

### Root cause C — Old-format article parsed as `'general'`

Old sitemaps (pre-~2003) use the single-segment format:
```
Titre préliminaire du Code de procédure pénale - 17-04-1878 - 26
```
`extractOldStyleArticleWithEli` requires TWO segments after the date (article +
counter) so returns `null` here → article fell back to `'general'` →
`isInOverlapRange('general')` failed → entry never moved. Fixed by adding
`extractOldStyleArticle` as a fallback.

---

## Reference Format Evolution Summary

| Era | Has `Art.` prefix | Has ELI reference | Has date | Parser path |
|-----|:-----------------:|:-----------------:|:--------:|-------------|
| Post ~2003 | ✓ | ✓ | ✓ | `RE_ART_REF_*` → ELI flush |
| Post ~2003 (general) | ✗ | ✓ | ✓ | `RE_REF_NO_ART` → `extractOldStyleArticleWithEli` → ELI flush |
| ~1995–2003 | ✗ | ✗ | ✓ | `RE_REF_NO_ART` → fallback `extractOldStyleArticle` → cache |
| Pre ~1995 | ✗ | ✗ | ✗ | `RE_OLD_STYLE_ART_REF` → `legalBasesWithoutEli` |

---

## Debugging Tips

- **Enable `--verbose`** to see per-reference parse decisions in the log.
- **Fetch the raw XML** directly: `curl -s 'https://juportal.just.fgov.be/JUPORTAsitemap/YYYY/MM/DD/sitemap_N.xml'`
- The raw text in `rawLegalBasisText` stored in `missing_eli.json` contains the
  law name + date, which can be used to find the ELI manually via ejustice search.
- If an article is stored under `'general'` key but you expect a numeric key, the
  raw reference text is in the single-segment old format and `extractOldStyleArticle`
  should handle it — check that function first.
- If an entry is filed under the wrong law (e.g. CIC instead of TPCPP), check
  whether the XML ELI date mismatches the reference text date — `correctEliByDate`
  should catch it, and if not, confirm `split_texts.json` has the correct article range.
