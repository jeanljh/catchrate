// Standalone HTML report: one file, no network requests. Everything is rendered
// and escaped here; the only script is the static one below, which the CSP
// allows by hash.

import crypto from 'node:crypto';
import { describeOps } from './mutations.js';
import { pct, testTitle } from './util.js';
import type { Diff, DiffItem } from './report.js';
import type { MutantOutcome, MutantResult, Report, ReportTest } from './types.js';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// fine for element text and quoted attributes
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);

const OUTCOME_LABEL: Record<MutantOutcome, string> = {
  killed: 'Caught',
  survived: 'Missed',
  'not-applied': 'Not reached',
  'no-visible-effect': 'No visible change',
  skipped: 'Skipped',
  error: 'Error',
};

// Filters and copy buttons. Never put report data in here: its hash is in the CSP.
const SCRIPT = `(() => {
  const state = { outcome: document.body.dataset.defaultOutcome || 'all', risk: 'all' };
  const apply = () => {
    for (const el of document.querySelectorAll('.mutant')) {
      el.hidden = !((state.outcome === 'all' || el.dataset.outcome === state.outcome) && (state.risk === 'all' || el.dataset.risk === state.risk));
    }
    for (const s of document.querySelectorAll('section.test')) s.hidden = !s.querySelector('.mutant:not([hidden])');
    for (const b of document.querySelectorAll('[data-filter-outcome]')) b.setAttribute('aria-pressed', String(b.dataset.filterOutcome === state.outcome));
    const empty = document.getElementById('empty');
    if (empty) empty.hidden = Boolean(document.querySelector('.mutant:not([hidden])'));
  };
  for (const b of document.querySelectorAll('[data-filter-outcome]')) b.addEventListener('click', () => { state.outcome = b.dataset.filterOutcome; apply(); });
  const risk = document.getElementById('risk');
  if (risk) risk.addEventListener('change', () => { state.risk = risk.value; apply(); });
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
      catch { b.textContent = 'Copy failed'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
  }
  apply();
})();`;

const SCRIPT_HASH = `sha256-${crypto.createHash('sha256').update(SCRIPT).digest('base64')}`;
export const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; img-src data:; base-uri 'none'; form-action 'none'`;

const STYLE = `
:root { --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --card:#f6f8fa;
  --good:#1a7f37; --warn:#9a6700; --bad:#cf222e; --accent:#0969da; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --card:#151b23;
  --good:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#4493f8; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1080px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:0; } .muted { color:var(--muted); }
code, pre { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; }
pre { margin:0; white-space:pre-wrap; word-break:break-word; }
.hero { display:flex; flex-wrap:wrap; gap:24px; align-items:center; justify-content:space-between; margin:16px 0 24px; }
.score { font-size:48px; font-weight:700; line-height:1; }
.good { color:var(--good); } .warn { color:var(--warn); } .bad { color:var(--bad); }
.stats { display:flex; flex-wrap:wrap; gap:8px; }
.stat { border:1px solid var(--line); border-radius:8px; padding:8px 12px; min-width:110px; }
.stat b { display:block; font-size:20px; }
table { width:100%; border-collapse:collapse; margin:8px 0 24px; }
th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:middle; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.bar { width:120px; height:8px; border-radius:4px; background:var(--line); overflow:hidden; display:inline-block; vertical-align:middle; margin-right:8px; }
.bar span { display:block; height:100%; background:currentColor; }
a { color:var(--accent); }
.filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0 16px; position:sticky; top:0; background:var(--bg); padding:8px 0; z-index:1; }
button, select { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:999px; padding:4px 12px; cursor:pointer; }
button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); font-weight:600; }
section.test { margin:24px 0; }
.test-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:6px; margin-bottom:12px; }
.mutant { border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; background:var(--card); padding:12px 14px; margin:10px 0; }
.mutant[data-outcome="survived"] { border-left-color:var(--bad); } .mutant[data-outcome="killed"] { border-left-color:var(--good); }
.mutant-head { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:6px; }
.badge { font-size:12px; font-weight:600; border-radius:999px; padding:1px 8px; border:1px solid currentColor; }
.chip { font-size:12px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:8px 0 0; } dt { color:var(--muted); }
dd { margin:0; min-width:0; }
.hint { display:flex; gap:8px; align-items:flex-start; } .hint > pre, .hint > span { flex:1; min-width:0; }
dd code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
.hint pre code { background:none; border:0; padding:0; }
.hint button { border-radius:6px; padding:2px 10px; font-size:12px; }
#empty { padding:24px; text-align:center; border:1px dashed var(--line); border-radius:8px; }
.verdict { border-radius:8px; padding:12px 16px; margin:16px 0; border:1px solid currentColor; }
footer { margin-top:48px; font-size:13px; }
@media (max-width:640px) { .bar { width:60px; } th.hide-sm, td.hide-sm { display:none; }
  dl { grid-template-columns:1fr; } dt { margin-top:6px; font-size:13px; } .score { font-size:40px; } }`;

const scoreClass = (s: number | null | undefined) => (s === null || s === undefined ? 'muted' : s >= 0.8 ? 'good' : s >= 0.5 ? 'warn' : 'bad');
const testName = testTitle;

function page(title: string, body: string, defaultOutcome = 'all'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP)}">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body data-default-outcome="${esc(defaultOutcome)}">
<main>
${body}
<footer class="muted">Generated by catchrate. This file is self-contained and makes no network requests.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function scoreBar(s: number | null): string {
  if (s === null) return '<span class="muted">n/a</span>';
  return `<span class="${scoreClass(s)}"><span class="bar"><span style="width:${Math.round(s * 100)}%"></span></span>${pct(s)}</span>`;
}

const isCode = (s: string) => /^(await |expect\()/.test(s.trim());

// LLM hints are one line of code; heuristic hints are prose with `code` spans.
// Either way, Copy should grab just the code.
function hintHtml(hint: string): { html: string; copy: string } {
  if (isCode(hint)) return { html: `<pre><code>${esc(hint.trim())}</code></pre>`, copy: hint.trim() };
  const parts = hint.split(/`([^`]*)`/);
  const html = parts.map((p, i) => (i % 2 ? `<code>${esc(p)}</code>` : esc(p))).join('');
  const firstCode = parts.find((p, i) => i % 2 === 1 && p.trim());
  return { html: `<span>${html}</span>`, copy: firstCode ?? hint };
}

function mutantCard(m: MutantResult): string {
  const h = m.assertionHint ? hintHtml(m.assertionHint) : null;
  const hint = h ? `<dt>Would be caught by</dt><dd class="hint">${h.html}<button type="button" data-copy="${esc(h.copy)}">Copy</button></dd>` : '';
  const outcomeClass = m.outcome === 'survived' ? 'bad' : m.outcome === 'killed' ? 'good' : 'muted';
  return `<article class="mutant" data-outcome="${esc(m.outcome)}" data-risk="${esc(m.risk)}">
  <div class="mutant-head"><span class="badge ${outcomeClass}">${esc(OUTCOME_LABEL[m.outcome] ?? m.outcome)}</span><strong>${esc(m.title)}</strong><span class="chip">${esc(m.risk)}</span><span class="chip">${esc(m.source)}</span></div>
  <dl>
    <dt>Injected</dt><dd><code>${esc(`${m.target.method} ${m.target.path}`)}</code> ${esc(describeOps(m.ops))}</dd>
    ${m.rationale ? `<dt>Why it matters</dt><dd>${esc(m.rationale)}</dd>` : ''}
    ${hint}
    ${m.detail && m.outcome !== 'survived' ? `<dt>Detail</dt><dd class="muted">${esc(m.detail)}</dd>` : ''}
  </dl>
</article>`;
}

function testSection(t: ReportTest, i: number): string {
  const status = t.status === 'ok' ? `<span class="${scoreClass(t.score)}">Catch rate ${pct(t.score)}</span>` : `<span class="muted">${esc(t.status)}: ${esc(t.detail?.split('\n')[0] ?? '')}</span>`;
  return `<section class="test" id="t-${i}">
  <div class="test-head"><h2>${esc(testName(t))} <span class="muted">· ${esc(t.titlePath[0])} · ${esc(t.project)}</span></h2>${status}</div>
  ${t.mutants.map(mutantCard).join('\n')}
</section>`;
}

export function renderHtml(report: Report): string {
  const s = report.summary;
  const ordered = [...report.tests].map((t, i) => ({ t, i })).sort((a, b) => (a.t.score ?? 2) - (b.t.score ?? 2));
  const source = report.source ? ` · mutants from ${esc(report.source)}${report.model ? ` (${esc([report.provider, report.model].filter(Boolean).join(': '))})` : ''}` : '';
  const risks = [...new Set(report.tests.flatMap((t) => t.mutants.map((m) => m.risk)))].sort();
  const outcomes: (MutantOutcome | 'all')[] = ['survived', 'killed', 'not-applied', 'no-visible-effect', 'error', 'skipped', 'all'];
  const count = (o: MutantOutcome | 'all') => (o === 'all' ? s.mutants : report.tests.reduce((n, t) => n + t.mutants.filter((m) => m.outcome === o).length, 0));

  const rows = ordered
    .map(
      ({ t, i }) => `<tr>
  <td><a href="#t-${i}">${esc(testName(t))}</a></td><td class="hide-sm muted">${esc(t.titlePath[0])}</td>
  <td>${t.status === 'ok' ? scoreBar(t.score) : `<span class="muted">${esc(t.status)}</span>`}</td>
  <td class="num">${t.counts.killed}</td><td class="num">${t.counts.survived}</td>
  <td class="num hide-sm">${t.counts.notApplied}</td><td class="num hide-sm">${t.counts.noVisibleEffect}</td><td class="num hide-sm">${t.counts.error + t.counts.skipped}</td>
</tr>`,
    )
    .join('\n');

  const body = `<h1>Catch rate report</h1>
<div class="muted">${esc(report.generatedAt.slice(0, 16).replace('T', ' '))} UTC · ${s.tests} tests · ${s.mutants} simulated bugs${source}</div>
<div class="hero">
  <div><div class="score ${scoreClass(s.score)}">${pct(s.score)}</div><div class="muted">caught ${s.killed} of ${s.killed + s.survived} reachable simulated bugs</div></div>
  <div class="stats">
    <div class="stat"><b class="good">${s.killed}</b>Caught</div>
    <div class="stat"><b class="bad">${s.survived}</b>Missed</div>
    <div class="stat"><b>${s.notApplied}</b>Not reached</div>
    <div class="stat"><b>${s.noVisibleEffect}</b>No visible change</div>
    <div class="stat"><b>${s.error + s.skipped}</b>Errors / skipped</div>
  </div>
</div>
<table>
<thead><tr><th>Test</th><th class="hide-sm">File</th><th>Catch rate</th><th class="num">Caught</th><th class="num">Missed</th><th class="num hide-sm">Not reached</th><th class="num hide-sm">No change</th><th class="num hide-sm">Errors</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="filters" role="toolbar" aria-label="Filter simulated bugs">
  ${outcomes.map((o) => `<button type="button" data-filter-outcome="${o}" aria-pressed="false">${o === 'all' ? 'All' : esc(OUTCOME_LABEL[o])} (${count(o)})</button>`).join('\n  ')}
  <label class="muted">Risk <select id="risk"><option value="all">All</option>${risks.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></label>
</div>
<p id="empty" class="muted" hidden>No simulated bugs match these filters.</p>
${ordered.map(({ t, i }) => testSection(t, i)).join('\n')}`;

  return page('Catch rate report', body, s.survived > 0 ? 'survived' : 'all');
}

function diffList(title: string, items: DiffItem[], note?: string): string {
  if (!items.length) return '';
  return `<section class="test"><div class="test-head"><h2>${esc(title)} (${items.length})</h2></div>
${note ? `<p class="muted">${esc(note)}</p>` : ''}
${items
  .map(({ test, mutant }) =>
    mutantCard({ ...mutant, title: `${testName(test)}: ${mutant.title}` }).replace('<article class="mutant"', `<article class="mutant" data-diff="${esc(title)}"`),
  )
  .join('\n')}
</section>`;
}

export function renderDiffHtml(diff: Diff): string {
  const show = (v: number | string | null) => (typeof v === 'string' ? `<span class="muted">${esc(v)}</span>` : scoreBar(v));
  const changed = diff.perTest.filter((p) => p.before !== p.after);
  const lost = diff.weakened.length + diff.lostCoverage.length;
  const body = `<h1>Catch rate diff</h1>
<div class="verdict ${diff.regressed ? 'bad' : 'good'}">${
    diff.regressed
      ? `<strong>${lost} simulated bugs that were caught before are no longer caught.</strong> The change weakened the tests below, even if the code diff looks harmless.`
      : '<strong>No test got weaker.</strong> Every simulated bug caught before is still caught.'
  }</div>
${
  changed.length
    ? `<table><thead><tr><th>Test</th><th class="hide-sm">File</th><th>Before</th><th>After</th></tr></thead><tbody>
${changed.map((p) => `<tr><td>${esc(testName(p))}</td><td class="hide-sm muted">${esc(p.titlePath[0])}</td><td>${show(p.before)}</td><td>${show(p.after)}</td></tr>`).join('\n')}
</tbody></table>`
    : ''
}
${diffList('Now missed (caught before)', diff.weakened)}
${diffList('No longer reached (caught before)', diff.lostCoverage, 'The test no longer makes this request, so a step or check was likely removed.')}
${diffList('Newly caught', diff.strengthened)}
${diff.unmatched.length ? `<p class="muted">${diff.unmatched.length} mutants from the first report had no counterpart in the second. Were both runs made from the same mutants file?</p>` : ''}`;
  return page('Catch rate diff', body, 'all');
}
