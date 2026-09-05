/**
 * Juportal role/roll-number parsing and classification.
 *
 * The crawler historically calls this value `roleNumber`.  The public data
 * model uses `rollNumberSystem` and `matterFromRollNumber` to make clear that
 * classification is derived from the roll number only.
 */

export const CAS_ROLL_NUMBER_RE = /^\d{2}\/CAS\/\d{4,}$/i;

export const LEGACY_ROLL_NUMBER_RE =
  /^[A-Z]\.(?:\d{2}|\d{4})\.\d{4,5}\.[A-ZNF](?:-[A-Z]\.(?:\d{2}|\d{4})\.\d{4,5}\.[A-ZNF])?$/i;

const LEGACY_MATTERS = {
  C: 'civil',
  P: 'criminal',
  S: 'social',
  F: 'tax',
  D: 'disciplinary',
};

/**
 * Extract the value from a French or Dutch Juportal role-number reference.
 * Both a spaced colon ("Numéro de rôle : ...") and no colon are accepted.
 * The published number itself is preserved verbatim apart from outer space.
 */
export function extractRollNumberReference(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^(?:Numéro de rôle|Rolnummer)\s*:?\s*(\S(?:.*\S)?)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Identify the roll-number system and, only where the legacy prefix supports
 * it, derive the matter. CAS numbers intentionally remain unclassified.
 */
export function classifyRollNumber(rollNumber) {
  if (typeof rollNumber !== 'string' || !rollNumber.trim()) {
    return { rollNumberSystem: null, matterFromRollNumber: null };
  }

  const value = rollNumber.trim();
  if (CAS_ROLL_NUMBER_RE.test(value)) {
    return { rollNumberSystem: 'CAS', matterFromRollNumber: null };
  }

  if (LEGACY_ROLL_NUMBER_RE.test(value)) {
    return {
      rollNumberSystem: 'legacy',
      matterFromRollNumber: LEGACY_MATTERS[value[0].toUpperCase()] || null,
    };
  }

  return { rollNumberSystem: 'unknown', matterFromRollNumber: null };
}
