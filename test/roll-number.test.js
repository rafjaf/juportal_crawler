import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CAS_ROLL_NUMBER_RE,
  classifyRollNumber,
  extractRollNumberReference,
} from '../src/roll_number.js';
import { parseSitemapXmlContent } from '../src/sitemap.js';

const fixtureUrl = name => new URL(`./fixtures/${name}`, import.meta.url);

test('recognises CAS roll numbers without inferring matter', () => {
  assert.match('26/CAS/0418', CAS_ROLL_NUMBER_RE);
  assert.match('26/cas/0006', CAS_ROLL_NUMBER_RE);
  assert.deepEqual(classifyRollNumber('26/CAS/0418'), {
    rollNumberSystem: 'CAS',
    matterFromRollNumber: null,
  });
});

test('classifies legacy roll numbers from their matter prefix', () => {
  assert.deepEqual(classifyRollNumber('P.26.0036.N'), {
    rollNumberSystem: 'legacy',
    matterFromRollNumber: 'criminal',
  });
  assert.deepEqual(classifyRollNumber('C.25.0065.N'), {
    rollNumberSystem: 'legacy',
    matterFromRollNumber: 'civil',
  });
});

test('extracts French and Dutch labelled values while preserving zeroes and slashes', () => {
  assert.equal(extractRollNumberReference('Numéro de rôle : 26/CAS/0006'), '26/CAS/0006');
  assert.equal(extractRollNumberReference('Rolnummer P.26.0036.N'), 'P.26.0036.N');
});

test('parses a CAS sitemap fixture and retains both language URLs', async () => {
  const xml = fs.readFileSync(fixtureUrl('cas-sitemap.xml'), 'utf8');
  const judgment = await parseSitemapXmlContent(xml, fileURLToPath(fixtureUrl('cas-sitemap.xml')));

  assert.equal(judgment.roleNumber, '26/CAS/0418');
  assert.equal(judgment.rollNumberSystem, 'CAS');
  assert.equal(judgment.matterFromRollNumber, null);
  assert.deepEqual(judgment.judgementUrls, [
    'https://juportal.be/content/ECLI:BE:CASS:2026:ARR.20260804.VAC.3/FR',
    'https://juportal.be/content/ECLI:BE:CASS:2026:ARR.20260804.VAC.3/NL',
  ]);
  assert.deepEqual(judgment.abstractsFR, ['Résumé français']);
  assert.deepEqual(judgment.abstractsNL, ['Nederlandse samenvatting']);
});

test('parses a legacy sitemap fixture', async () => {
  const xml = fs.readFileSync(fixtureUrl('legacy-sitemap.xml'), 'utf8');
  const judgment = await parseSitemapXmlContent(xml, fileURLToPath(fixtureUrl('legacy-sitemap.xml')));

  assert.equal(judgment.roleNumber, 'P.26.0036.N');
  assert.equal(judgment.rollNumberSystem, 'legacy');
  assert.equal(judgment.matterFromRollNumber, 'criminal');
});
