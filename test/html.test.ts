import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CSP, esc, renderDiffHtml, renderHtml } from '../dist/html.js';
import { buildReport, diffReports } from '../dist/report.js';
import type { Mutant, MutantOutcome, TestResult } from '../dist/types.js';

const mutant = (id: string, extra: Partial<Mutant> = {}): Mutant => ({
  id,
  source: 'heuristic',
  title: `bug ${id}`,
  rationale: 'Users see the wrong total.',
  risk: 'wrong-calculation',
  target: { method: 'GET', path: '/api/cart' },
  ops: [{ op: 'replace', path: '/total', value: 1 }],
  assertionHint: "await expect(page.getByTestId('total')).toHaveText('$28.00');",
  ...extra,
});

const result = (outcomes: MutantOutcome[], titlePath = ['cart.spec.ts', 'cart totals']): TestResult => ({
  key: `chromium › ${titlePath.join(' › ')}`,
  project: 'chromium',
  titlePath,
  title: titlePath.at(-1)!,
  file: `/${titlePath[0]}`,
  status: 'ok',
  mutants: outcomes.map((outcome, i) => ({ ...mutant(`m_0000000${i}`), outcome })),
});

test('renders scores, counts and every mutant', () => {
  const html = renderHtml(buildReport({ results: [result(['killed', 'killed', 'survived', 'not-applied'])], meta: { source: 'heuristic' } }));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<div class="score warn">67%<\/div>/);
  assert.match(html, /caught 2 of 3 reachable simulated bugs/);
  assert.equal(html.match(/<article class="mutant"/g)?.length, 4);
  assert.match(html, /data-default-outcome="survived"/, 'opens on the missed bugs');
  assert.match(html, /data-copy="await expect\(page\.getByTestId\(&#39;total&#39;\)\)/);
});

test('prose hints render their code as <code> and Copy takes just the code', () => {
  const r = result(['survived']);
  r.mutants[0] = { ...r.mutants[0]!, assertionHint: 'Assert the total, e.g. `await expect(total).toHaveText(/64\\.96/)`.' };
  const html = renderHtml(buildReport({ results: [r] }));
  assert.match(html, /<span>Assert the total, e\.g\. <code>await expect\(total\)\.toHaveText\(\/64\\\.96\/\)<\/code>\.<\/span>/);
  assert.match(html, /data-copy="await expect\(total\)\.toHaveText\(\/64\\\.96\/\)"/);
});

test('is self-contained: no external requests of any kind', () => {
  const html = renderHtml(buildReport({ results: [result(['survived'])] }));
  assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(src|href)=/i);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('the CSP allows exactly the one inline script, by hash', () => {
  const html = renderHtml(buildReport({ results: [result(['survived'])] }));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1);
  const hash = crypto.createHash('sha256').update(scripts[0]!).digest('base64');
  assert.ok(CSP.includes(`'sha256-${hash}'`), 'script hash is in the CSP');
  assert.match(CSP, /default-src 'none'/);
  assert.doesNotMatch(CSP, /script-src[^;]*'unsafe-inline'/);
  assert.ok(html.includes(`content="${esc(CSP)}"`));
});

test('hostile titles and values are escaped, not executed', () => {
  const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const r = result(['survived'], ['evil.spec.ts', evil]);
  r.mutants[0] = { ...r.mutants[0]!, title: evil, assertionHint: `x" onclick="alert(3)`, rationale: '</article><b>x</b>' };
  const html = renderHtml(buildReport({ results: [r] }));
  assert.equal(html.match(/<script>/g)?.length, 1, 'only our own script tag');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onclick="alert/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the diff page states the verdict and lists weakened tests', () => {
  const before = buildReport({ results: [result(['killed', 'killed', 'survived'])] });
  const after = buildReport({ results: [result(['survived', 'killed', 'survived'])] });
  const html = renderDiffHtml(diffReports(before, after));
  assert.match(html, /class="verdict bad"/);
  assert.match(html, /1 simulated bugs that were caught before are no longer caught/);
  assert.match(html, /Now missed \(caught before\) \(1\)/);
  assert.match(renderDiffHtml(diffReports(before, before)), /No test got weaker/);
});
