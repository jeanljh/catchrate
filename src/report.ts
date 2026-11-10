// Scoring, the Markdown report and the before/after diff.

import { describeOps } from './mutations.js';
import { pct, testTitle } from './util.js';
import type { Counts, MutantOutcome, MutantResult, Report, ReportMeta, ReportTest, TestResult } from './types.js';

export function countOutcomes(mutants: readonly MutantResult[]): Counts {
  const counts: Counts = { killed: 0, survived: 0, notApplied: 0, noVisibleEffect: 0, error: 0, skipped: 0 };
  for (const m of mutants) {
    if (m.outcome === 'killed') counts.killed++;
    else if (m.outcome === 'survived') counts.survived++;
    else if (m.outcome === 'not-applied') counts.notApplied++;
    else if (m.outcome === 'no-visible-effect') counts.noVisibleEffect++;
    else if (m.outcome === 'skipped') counts.skipped++;
    else counts.error++;
  }
  return counts;
}

/** caught / (caught + missed); null if nothing was reachable */
export function score(counts: Counts): number | null {
  const scored = counts.killed + counts.survived;
  return scored ? counts.killed / scored : null;
}

export function buildReport({ results, meta = {} }: { results: readonly TestResult[]; meta?: ReportMeta }): Report {
  const tests: ReportTest[] = results.map((t) => {
    const counts = countOutcomes(t.mutants);
    return { ...t, counts, score: score(counts) };
  });
  const totals = countOutcomes(tests.flatMap((t) => t.mutants));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    ...meta,
    summary: { tests: tests.length, mutants: tests.reduce((n, t) => n + t.mutants.length, 0), ...totals, score: score(totals) },
    tests,
  };
}

// report.md tends to end up as a PR comment, and a lot of its text is untrusted
// (test titles, response values, LLM output). Keep that text to one line of
// inert Markdown: no HTML, no links, nothing that could close our <details>.

// HTML inside a code span renders literally, so spans are left alone
export function inline(s: unknown): string {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([[\]])/g, '\\$1')))
    .join('');
}

// fence longer than any backtick run inside, so the span always closes
export function code(s: unknown): string {
  const text = String(s ?? '').replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest || text.startsWith(' ') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const hint = (h: string) => (/^(await |expect\()/.test(h.trim()) ? code(h.trim()) : inline(h));
const cell = (s: unknown) => inline(s).replace(/\|/g, '\\|');
const testName = (t: { titlePath: string[] }) => inline(testTitle(t));
const fileName = (t: { titlePath: string[] }) => inline(t.titlePath[0]);
const injected = (m: Pick<MutantResult, 'target' | 'ops'>) => `${code(`${m.target.method} ${m.target.path}`)} ${inline(describeOps(m.ops))}`;

export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const out: string[] = [];
  out.push('# Catch rate report', '');
  out.push(
    `${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC · ${s.tests} tests · ${s.mutants} simulated bugs` +
      (report.source ? ` · mutants from ${inline(report.source)}${report.model ? ` (${inline([report.provider, report.model].filter(Boolean).join(': '))})` : ''}` : ''),
    '',
  );
  out.push(`**Catch rate: ${pct(s.score)}.** The suite caught ${s.killed} of ${s.killed + s.survived} simulated backend bugs it could reach.`, '');
  const uncounted: string[] = [];
  if (s.notApplied) uncounted.push(`${s.notApplied} targeted requests the test never made`);
  if (s.noVisibleEffect) uncounted.push(`${s.noVisibleEffect} left the final page unchanged, so no UI check could see them`);
  if (uncounted.length) out.push(`Not counted toward the score: ${uncounted.join('; ')}.`, '');
  if (s.error || s.skipped) out.push(`${s.error} errored and ${s.skipped} were skipped (unstable or missing tests). See the end of the report.`, '');

  const ordered = [...report.tests].sort((a, b) => (a.score ?? 2) - (b.score ?? 2));
  out.push('| Test | File | Score | Caught | Missed | Not reached | No visible change | Errors |', '|---|---|---|---|---|---|---|---|');
  for (const t of ordered) {
    const c = t.counts;
    const status = t.status === 'ok' ? pct(t.score) : cell(t.status);
    out.push(`| ${cell(testTitle(t))} | ${cell(t.titlePath[0])} | ${status} | ${c.killed} | ${c.survived} | ${c.notApplied} | ${c.noVisibleEffect} | ${c.error + c.skipped} |`);
  }
  out.push('');

  const withSurvivors = ordered.filter((t) => t.mutants.some((m) => m.outcome === 'survived'));
  if (withSurvivors.length) {
    out.push('## Bugs these tests would miss', '');
    out.push('Each one is a realistic backend bug that was injected into the test run while the test still passed.', '');
    for (const t of withSurvivors) {
      out.push(`### ${testName(t)} (${fileName(t)}), catch rate ${pct(t.score)}`, '');
      for (const m of t.mutants.filter((x) => x.outcome === 'survived')) {
        out.push(`- **${inline(m.title)}** ${code(m.risk)}`);
        out.push(`  - Injected: ${injected(m)}`);
        if (m.rationale) out.push(`  - Why it matters: ${inline(m.rationale)}`);
        if (m.assertionHint) out.push(`  - Would be caught by: ${hint(m.assertionHint)}`);
      }
      out.push('');
    }
  } else {
    out.push('Every simulated bug the tests could reach was caught.', '');
  }

  const problems = report.tests.filter((t) => t.status !== 'ok' || t.mutants.some((m) => m.outcome === 'error'));
  if (problems.length) {
    out.push('## Errors, unstable and missing tests', '');
    for (const t of problems) {
      out.push(`- **${testName(t)}** (${fileName(t)}): ${t.status === 'ok' ? 'some mutants errored' : inline(t.detail?.split('\n')[0])}`);
      for (const m of t.mutants.filter((x) => x.outcome === 'error')) out.push(`  - ${inline(m.title)}: ${inline(m.detail)}`);
    }
    out.push('');
  }

  const listed = (outcome: MutantOutcome, summary: string) => {
    const items = report.tests.flatMap((t) => t.mutants.filter((m) => m.outcome === outcome).map((m) => ({ t, m })));
    if (!items.length) return;
    out.push(`<details><summary>${summary} (${items.length})</summary>`, '');
    for (const { t, m } of items) out.push(`- ${testName(t)}: ${inline(m.title)}`);
    out.push('', '</details>', '');
  };
  listed('not-applied', 'Not reached: the test never made the request');
  listed('no-visible-effect', 'No visible change: the final page looked the same as without the bug');
  return out.join('\n');
}

export interface DiffItem {
  test: ReportTest;
  mutant: MutantResult;
}

export interface Diff {
  weakened: DiffItem[];
  lostCoverage: DiffItem[];
  strengthened: DiffItem[];
  unmatched: DiffItem[];
  perTest: { key: string; titlePath: string[]; before: number | string | null; after: number | string | null }[];
  /** some test stopped catching something it used to */
  regressed: boolean;
}

// Both reports have to come from the same mutants.json. Killed before but not
// after means the change weakened the test.
export function diffReports(before: Report, after: Report): Diff {
  const index = (report: Report) => {
    const map = new Map<string, { t: ReportTest; m: MutantResult }>();
    for (const t of report.tests) for (const m of t.mutants) map.set(`${t.key}\u0000${m.id}`, { t, m });
    return map;
  };
  const b = index(before);
  const a = index(after);
  const diff: Diff = { weakened: [], lostCoverage: [], strengthened: [], unmatched: [], perTest: [], regressed: false };

  for (const [k, { t, m }] of b) {
    const now = a.get(k);
    if (!now) {
      diff.unmatched.push({ test: t, mutant: m });
      continue;
    }
    const was = m.outcome;
    const is = now.m.outcome;
    const item = { test: now.t, mutant: now.m };
    if (was === 'killed' && is === 'survived') diff.weakened.push(item);
    else if (was === 'killed' && is === 'not-applied') diff.lostCoverage.push(item);
    else if (was === 'survived' && is === 'killed') diff.strengthened.push(item);
  }

  const keys = new Set([...before.tests.map((t) => t.key), ...after.tests.map((t) => t.key)]);
  for (const key of keys) {
    const tb = before.tests.find((t) => t.key === key);
    const ta = after.tests.find((t) => t.key === key);
    diff.perTest.push({
      key,
      titlePath: (ta ?? tb)!.titlePath,
      before: tb?.status === 'ok' ? tb.score : (tb?.status ?? 'absent'),
      after: ta?.status === 'ok' ? ta.score : (ta?.status ?? 'absent'),
    });
  }

  diff.regressed = diff.weakened.length + diff.lostCoverage.length > 0;
  return diff;
}

export function renderDiffMarkdown(diff: Diff): string {
  const out = ['# Catch rate diff', ''];
  if (diff.regressed) {
    out.push(
      `**${diff.weakened.length + diff.lostCoverage.length} simulated bugs that were caught before are no longer caught.** The change weakened the tests below, even if the diff looks harmless.`,
      '',
    );
  } else {
    out.push('No test got weaker: every simulated bug caught before is still caught.', '');
  }

  const changed = diff.perTest.filter((p) => p.before !== p.after);
  if (changed.length) {
    out.push('| Test | Before | After |', '|---|---|---|');
    const show = (v: number | string | null) => (typeof v === 'string' ? cell(v) : pct(v));
    for (const p of changed) out.push(`| ${cell(testTitle(p))} (${cell(p.titlePath[0])}) | ${show(p.before)} | ${show(p.after)} |`);
    out.push('');
  }

  const section = (title: string, items: DiffItem[], note?: string) => {
    if (!items.length) return;
    out.push(`## ${title}`, '');
    if (note) out.push(note, '');
    for (const { test, mutant } of items) {
      out.push(`- **${testName(test)}**: ${inline(mutant.title)}`);
      out.push(`  - Injected: ${injected(mutant)}`);
      if (mutant.assertionHint) out.push(`  - Restore with: ${hint(mutant.assertionHint)}`);
    }
    out.push('');
  };
  section('Now missed (caught before)', diff.weakened);
  section('No longer reached (caught before)', diff.lostCoverage, 'The test no longer makes this request, so a step or check was likely removed.');
  section('Newly caught', diff.strengthened);
  if (diff.unmatched.length) out.push(`${diff.unmatched.length} mutants from the first report had no counterpart in the second. Were both runs made from the same mutants file?`, '');
  return out.join('\n');
}
