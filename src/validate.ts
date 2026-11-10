// Checks for files read back from disk. People commit mutants.json and re-run
// it in CI, so it's untrusted: a tampered file mustn't be able to write outside
// the output dir or sneak in anything but mutation data.

import { RISKS } from './constants.js';
import { validateMutant } from './mutations.js';
import type { MutantsFile, Report } from './types.js';

// ids end up in file names
export const MUTANT_ID = /^m_[0-9a-f]{8,64}$/;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Throws listing every problem found (up to 20). */
export function parseMutantsFile(data: unknown, source = 'mutants file'): MutantsFile {
  const problems: string[] = [];
  const add = (p: string) => problems.length < 20 && problems.push(p);
  const file = data as Partial<MutantsFile> | null;

  if (!file || typeof file !== 'object') throw new Error(`${source} is not a JSON object`);
  if (file.version !== 1) add(`unsupported version ${JSON.stringify(file.version)} (expected 1)`);
  if (!Array.isArray(file.tests)) add('"tests" must be an array');

  for (const [i, t] of (Array.isArray(file.tests) ? file.tests : []).entries()) {
    const at = `tests[${i}]`;
    if (!t || typeof t !== 'object') {
      add(`${at} is not an object`);
      continue;
    }
    if (typeof t.key !== 'string' || !t.key) add(`${at}.key must be a non-empty string`);
    if (typeof t.project !== 'string') add(`${at}.project must be a string`);
    if (!isStringArray(t.titlePath) || t.titlePath.length < 2) add(`${at}.titlePath must list the file and test title`);
    if (!Array.isArray(t.mutants)) {
      add(`${at}.mutants must be an array`);
      continue;
    }
    const seen = new Set<string>();
    for (const [j, m] of t.mutants.entries()) {
      const mt = `${at}.mutants[${j}]`;
      if (typeof m?.id !== 'string' || !MUTANT_ID.test(m.id)) add(`${mt}.id must look like "m_<hex>"`);
      else if (seen.has(m.id)) add(`${mt}.id ${m.id} is duplicated`);
      else seen.add(m.id);
      for (const problem of validateMutant(m)) add(`${mt}: ${problem}`);
      if (typeof m?.title !== 'string') add(`${mt}.title must be a string`);
      if (!(RISKS as readonly unknown[]).includes(m?.risk)) add(`${mt}.risk must be one of ${RISKS.join(', ')}`);
    }
  }

  if (problems.length) throw new Error(`${source} is invalid:\n  - ${problems.join('\n  - ')}`);
  return file as MutantsFile;
}

/** just enough to render or diff safely */
export function parseReport(data: unknown, source = 'report'): Report {
  const r = data as Partial<Report> | null;
  if (!r || typeof r !== 'object' || r.version !== 1 || !Array.isArray(r.tests) || !r.summary) {
    throw new Error(`${source} is not a catchrate report (version 1)`);
  }
  for (const t of r.tests) {
    if (!t || typeof t.key !== 'string' || !isStringArray(t.titlePath) || !Array.isArray(t.mutants)) {
      throw new Error(`${source} has a malformed test entry`);
    }
  }
  return r as Report;
}
