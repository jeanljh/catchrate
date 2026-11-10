import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, grepFor, looksUnchanged } from '../dist/runner.js';
import { buildReport, diffReports, renderDiffMarkdown, renderMarkdown } from '../dist/report.js';
import { parseArgs } from '../dist/cli.js';
import type { Mutant, MutantOutcome, MutantsTest, Outcome, TestResult } from '../dist/types.js';

const mutant = (id: string): Mutant => ({
  id,
  source: 'heuristic',
  title: `bug ${id}`,
  rationale: '',
  risk: 'wrong-data',
  target: { method: 'GET', path: '/api/cart' },
  ops: [{ op: 'replace', path: '/total', value: 1 }],
  assertionHint: "await expect(page.getByTestId('total')).toHaveText('$28.00');",
});

const t: MutantsTest = {
  key: 'p › a.spec.ts › works',
  project: 'p',
  titlePath: ['a.spec.ts', 'works'],
  title: 'works',
  file: '/a.spec.ts',
  mutants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(mutant),
  rejected: [],
};

const ok = (o: Partial<Outcome> = {}): Outcome => ({
  id: 'x',
  control: false,
  status: 'passed',
  intercepted: 1,
  applied: 1,
  snapshot: ['- heading "Cart"', '- text: Total $29.00'],
  routeErrors: [],
  error: null,
  durationMs: 1,
  ...o,
});

const page = ['- heading "Cart"', '- text: Total $28.00'];

const withOutcomes = (outcomes: MutantOutcome[]): TestResult => ({
  ...t,
  status: 'ok',
  mutants: t.mutants.map((m, i) => ({ ...m, outcome: outcomes[i]! })),
});

test('classify sorts mutants into outcomes', () => {
  const outcomes = new Map<string, Outcome>([
    ['control', ok({ id: 'control', control: true, snapshot: page })],
    ['control-2', ok({ id: 'control-2', control: true, snapshot: page })],
    ['m1', ok({ status: 'failed', error: 'Error: expect failed' })],
    ['m2', ok()],
    ['m3', ok({ intercepted: 0, applied: 0 })],
    ['m4', ok({ snapshot: page })],
    ['m5', ok({ status: 'timedOut' })],
  ]);
  const r = classify(t, outcomes);
  assert.equal(r.status, 'ok');
  assert.deepEqual(
    r.mutants.map((m) => m.outcome),
    ['killed', 'survived', 'not-applied', 'no-visible-effect', 'killed', 'error'],
  );
});

test('a failing control discards the test; a missing test is reported as missing', () => {
  const unstable = classify(t, new Map([['control', ok({ status: 'failed', error: 'flaky' })]]));
  assert.equal(unstable.status, 'unstable');
  assert.ok(unstable.mutants.every((m) => m.outcome === 'skipped'));
  // the second control failing counts too: that's how a flaky test shows up
  const flaky = classify(t, new Map([['control', ok()], ['control-2', ok({ status: 'failed' })]]));
  assert.equal(flaky.status, 'unstable');
  assert.equal(classify(t, new Map(), { code: 1, output: 'Error: No tests found' }).status, 'missing');
  assert.equal(classify(t, new Map(), { code: 1, output: 'boom' }).status, 'error');
});

test('looksUnchanged ignores live data but not real changes', () => {
  const a = ['- heading "Chart"', '- text: O27,910.90 C27,927.00', '- button "00:54:18 UTC"', '- text: Signed in'];
  const b = ['- heading "Chart"', '- text: O27,910.90 C27,931.25', '- button "00:54:18 UTC"', '- text: Signed in'];
  const same = (m: string[]) => looksUnchanged(m, a, b);
  // ticking clock (identical in both controls) and a live price (differs between them)
  assert.ok(same(['- heading "Chart"', '- text: O27,910.90 C27,933.75', '- button "00:54:31 UTC"', '- text: Signed in']));
  // a precision bug changes the shape of the live line
  assert.ok(!same(['- heading "Chart"', '- text: O27,910.900 C27,933.750', '- button "00:54:31 UTC"', '- text: Signed in']));
  // a stable line changing is always visible
  assert.ok(!same(['- heading "Chart"', '- text: O27,910.90 C27,927.00', '- button "00:54:18 UTC"', '- text: Signed out']));
  // a digits-only change on a stable, non-clock line is visible too
  assert.ok(!same(['- heading "Chart 2"', ...a.slice(1)]));
  assert.ok(!looksUnchanged(a.slice(1), a, b), 'different structure');
  assert.ok(!looksUnchanged(null, a, b));
});

test('report scores only reachable, visible mutants', () => {
  const report = buildReport({
    results: [withOutcomes(['killed', 'survived', 'not-applied', 'no-visible-effect', 'killed', 'killed'])],
    meta: { source: 'heuristic' },
  });
  assert.equal(report.summary.score, 3 / 4);
  assert.equal(report.tests[0]?.counts.notApplied, 1);
  assert.equal(report.tests[0]?.counts.noVisibleEffect, 1);
  const md = renderMarkdown(report);
  assert.match(md, /\*\*Catch rate: 75%\.\*\*/);
  assert.match(md, /## Bugs these tests would miss/);
  assert.match(md, /bug m2/);
  assert.match(md, /`await expect\(page\.getByTestId\('total'\)\)/);
});

test('diff flags a test that stopped catching bugs', () => {
  const before = buildReport({ results: [withOutcomes(['killed', 'killed', 'killed', 'survived', 'survived', 'survived'])] });
  const after = buildReport({ results: [withOutcomes(['survived', 'not-applied', 'killed', 'killed', 'survived', 'survived'])] });

  const diff = diffReports(before, after);
  assert.equal(diff.regressed, true);
  assert.deepEqual(
    diff.weakened.map((x) => x.mutant.id),
    ['m1'],
  );
  assert.deepEqual(
    diff.lostCoverage.map((x) => x.mutant.id),
    ['m2'],
  );
  assert.deepEqual(
    diff.strengthened.map((x) => x.mutant.id),
    ['m4'],
  );
  const md = renderDiffMarkdown(diff);
  assert.match(md, /2 simulated bugs that were caught before are no longer caught/);
  assert.match(md, /\| works \(a\.spec\.ts\) \| 50% \| 40% \|/);

  assert.equal(diffReports(before, before).regressed, false);
});

test('grepFor selects one test by its file and titles', () => {
  const re = new RegExp(grepFor(['cart.spec.ts', 'Cart', 'shows total ($)']));
  assert.ok(re.test(' chromium cart.spec.ts Cart shows total ($)'));
  assert.ok(!re.test(' chromium cart.spec.ts Mini Cart shows total ($)'));
  assert.ok(!re.test(' chromium mini-cart.spec.ts Cart shows total ($)'));
  assert.ok(!re.test(' chromium cart.spec.ts Cart shows total ($) again'));
  // Playwright appends tags from { tag: [...] } after the title
  assert.ok(re.test(' chromium cart.spec.ts Cart shows total ($) @smoke @cart'));
  assert.ok(!re.test(' chromium cart.spec.ts Cart shows total ($) @smoke extra'));
});

test('parseArgs reads flags in both forms', () => {
  const o = parseArgs(['run', '--cwd', 'x', '--workers=2', '--llm', 'extra']);
  assert.deepEqual(o._, ['run', 'extra']);
  assert.equal(o.cwd, 'x');
  assert.equal(o.workers, '2');
  assert.equal(o.llm, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['--cwd']), /needs a value/);
});
