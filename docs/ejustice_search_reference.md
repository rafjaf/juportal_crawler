# Ejustice Website Search – Technical Reference

## Overview

The Belgian Justel database at `https://www.ejustice.just.fgov.be/cgi_loi/rech.pl`
provides a search interface over consolidated Belgian legislation. This document
describes how the search form works and how to extract ELI identifiers from
search results.

## Search Form

- **URL**: `https://www.ejustice.just.fgov.be/cgi_loi/rech.pl?language=fr`
- **Action**: POST to `rech_res.pl`
- **Charset**: `iso-8859-1`

### Key Form Fields

| Field     | Description                        | Example Value                |
|-----------|------------------------------------|------------------------------|
| `language`| Language of the interface          | `fr`                         |
| `dt`      | Nature juridique (select)          | `LOI`, `CODE JUDICIAIRE`     |
| `ddd`     | Date de promulgation (from)        | `1951-04-30`                 |
| `ddf`     | Date de promulgation (to)          | `1951-04-30`                 |
| `text1`   | Mot(s) – keyword search            | `baux commerciaux`           |
| `chercher`| Search mode: `t` (tout), `c` (titre) | `c`                       |
| `fr`      | French text language checkbox      | `f`                          |
| `nl`      | Dutch text language checkbox       | `n`                          |
| `choix1`  | Boolean operator for text2         | `et`                         |
| `choix2`  | Boolean operator for text3         | `et`                         |
| `trier`   | Sort by                            | `promulgation`               |

### Nature Juridique Options (French)

Single text per search (returns 1 result):
- `CODE DE DROIT ECONOMIQUE`
- `CODE DE LA NATIONALITE BELGE`
- `CODE DE DROIT INTERNATIONAL PRIVE`
- etc.

Collections (returns multiple texts, article ranges in titles):
- `CODE JUDICIAIRE` → multiple parts (art. ranges: 1-57, 58-555/16, 556-663, 664-1385octiesdecies, etc.)
- `CODE D'INSTRUCTION CRIMINELLE` → multiple numbered parts
- `CODE CIVIL`
- `CODE PENAL`
- `CODE DES SOCIETES`
- etc.

Generic types (may return many results, need narrowing by date/title):
- `LOI`
- `ARRETE ROYAL`
- `ARRETE MINISTERIEL`
- `DECRET COMMUNAUTE FRANCAISE`
- `DECRET CONSEIL FLAMAND`
- `DECRET REGION WALLONNE`
- `ORDONNANCE (BRUXELLES)`
- `TRAITE`
- `CONVENTION COLLECTIVE DE TRAVAIL`
- etc.

## Search Results

### Result Page Structure

Results are rendered as `<div class="list-item">` blocks containing:
- A link with class `list-item--title` whose href contains `numac_search=NNNNNNNNNN`
- The title text after the `list-item--title` link
- A date paragraph with class `list-item--date`

### Numac Extraction

From a result link:
```
article.pl?language=fr&sum_date=&pd_search=1967-10-31&numac_search=1967101052&...
```
The `numac_search` parameter contains the NUMAC identifier.

### Pagination

Results may be paginated. The `list.pl` URL with `page=N` parameter handles pages.
Each page contains approximately 20 results.

## ELI Extraction

### From Article Page

Each search result links to an `article.pl` page. The ELI is extracted from that
page using a cascade of selectors, tried in order:

1. **`<a id="link-text">`** — the standard selector, present on most modern documents:
   ```html
   <a id="link-text" class="links-link" href="https://www.ejustice.just.fgov.be/eli/loi/1967/10/10/1967101052/justel">
     https://www.ejustice.just.fgov.be/eli/loi/1967/10/10/1967101052/justel
   </a>
   ```

2. **`<a class="links-link" href*="cgi_loi">`** — fallback for documents whose article
   page omits `#link-text` but does expose a `cgi_loi` link.

3. **`<a href*="justel">`** — secondary fallback for any anchor pointing to a justel URL.

4. **Constructed `cgi_loi` URL** — if the page is reachable but none of the above
   selectors match (common for old TRAITE and other pre-ELI-scheme documents), a
   stable URL is synthesised from the numac:
   ```
   https://www.ejustice.just.fgov.be/cgi_loi/loi_a1.pl?language=fr&la=F&table_name=loi&cn={numac}
   ```
   This format is understood by `eliToFilename()` (which looks for `table_name` + `cn`
   query parameters) and produces a unique, collision-free filename
   `cgi_loi_loi_{numac}.json`.

The article page is fetched with:
```
GET article.pl?language=fr&numac_search={numac}&page=1&lg_txt=F&caller=list
```

### ELI Formats

| Format       | Example |
|--------------|---------|
| Full ELI     | `https://www.ejustice.just.fgov.be/eli/{type}/{yyyy}/{mm}/{dd}/{numac}/justel` |
| cgi_loi (change_lg) | `https://www.ejustice.just.fgov.be/cgi_loi/change_lg.pl?language=fr&la=F&table_name={type}&cn={numac}` |
| cgi_loi (loi_a1) | `https://www.ejustice.just.fgov.be/cgi_loi/loi_a1.pl?language=fr&la=F&table_name=loi&cn={numac}` |

`eliToFilename()` handles all three formats:
- Full ELI → `eli_{type}_{yyyy}_{mm}_{dd}_{numac}_justel.json`
- cgi_loi (either variant) → `cgi_loi_{table_name}_{cn}.json`

### Type Mapping (dt → ELI type)

| dt Option              | ELI type path | table_name |
|------------------------|---------------|------------|
| LOI                    | loi           | loi        |
| ARRETE ROYAL           | arrete        | loi        |
| ARRETE MINISTERIEL     | arrete        | loi        |
| CODE JUDICIAIRE        | loi           | loi        |
| CODE CIVIL             | loi           | loi        |
| CODE PENAL             | loi           | loi        |
| CONSTITUTION 1994      | constitution  | loi        |
| DECRET ...             | decret        | loi        |
| ORDONNANCE (BRUXELLES) | ordonnance    | loi        |
| TRAITE                 | traite        | loi        |

Note: The actual ELI type is best extracted from the article page. Old TRAITE and
other pre-ELI documents (roughly pre-1990s) often carry no `/eli/` URL at all; the
constructed `loi_a1.pl` fallback is used for those.

## Article Range Parsing for Codes

For multi-part codes, titles contain article ranges:
```
CODE JUDICIAIRE - Première partie : PRINCIPES GENERAUX. (art. 1 à 57)
CODE JUDICIAIRE - Deuxième partie : L'ORGANISATION JUDICIAIRE (article 58 à 555/16)
CODE JUDICIAIRE - Troisième partie : DE LA COMPETENCE. (art. 556 à 663)
CODE JUDICIAIRE - Quatrième partie : DE LA PROCEDURE CIVILE. (art. 664 à 1385octiesdecies)
CODE JUDICIAIRE - Cinquième partie : SAISIES CONSERVATOIRES... (art. 1386 à 1675/27)
CODE JUDICIAIRE - Sixième partie : L'ARBITRAGE. (art. 1676 à 1723)
CODE JUDICIAIRE - Septième partie : LA MEDIATION (art. 1723/1 à 1737)
CODE JUDICIAIRE - Huitième partie : Droit collaboratif (art. 1738 à 1747)
```

The regex to extract: `\(art(?:icle)?\.?\s+(\S+)\s+[àa]\s+(\S+)\)`
- Group 1: start article
- Group 2: end article

German translations and "Annexe" entries should be filtered out.

## Texts NOT Findable on Ejustice

- European Directives and Regulations (Richtlijn, Verordening, Directive CEE, Règlement CE/UE)
- European Charters (Charte des droits fondamentaux, Handvest)
- General legal principles (Principe général du droit, Algemeen rechtsbeginsel)
- Foreign laws
- Collective bargaining agreements (except via CONVENTION COLLECTIVE DE TRAVAIL for some)

## Rate Limiting

The website should be queried with reasonable delays between requests
(1-2 seconds) to avoid overloading the server.
