// Offline mutant generator. Deterministic and free, but dumber than an LLM.
// It only touches values that show up in the final page snapshot: if the user
// can't see a value, no UI test can catch a bug in it.

import { DEFAULT_MAX_PER_TEST } from './constants.js';
import { dryRun, formatPointer } from './mutations.js';
import { REDACTED } from './redact.js';
import { hash } from './store.js';
import { escapeRegExp } from './util.js';
import type { Exchange, Mutant, MutationOp, ProposalResult, Recording, Rejected, Risk, Target } from './types.js';

type Segment = string | number;
type Kind = 'status' | 'array' | 'boolean' | 'number' | 'string';

interface Candidate {
  target: Target;
  kind: Kind;
  score: number;
  risk: Risk;
  title: string;
  rationale: string;
  ops: MutationOp[];
  assertionHint: string;
}

interface Ctx {
  target: Target;
  /** e.g. "GET /api/cart", for titles */
  label: string;
  /** lowercased, whitespace collapsed */
  snapshot: string;
  /** undefined if the body isn't JSON */
  body: unknown;
}

export interface HeuristicOptions {
  maxPerTest?: number;
}

// Rough priorities, highest picked first.
const SCORE = {
  droppedEntry: 7,
  serverError: 5,
  number: 4,
  moneyBonus: 2,
  aggregateBonus: 3,
  topLevelBonus: 1,
  text: 4,
  siblingBonus: 1,
  flag: 1,
  /** writes are usually what the flow is about */
  writeBonus: 2,
} as const;

const MONEY_KEY = /(total|price|amount|subtotal|sum|balance|cost|fee|tax|discount|qty|quantity|count)/i;
const AGGREGATE_KEY = /^(total|subtotal|grand_?total|amount_?due|balance|sum|discount|tax)$/i;
const MAX_LEAVES = 400;
// Fields that change how other values look without appearing on the page
// themselves. Found on a trading chart where `digits` sets price precision.
const FORMAT_KEY = /^(digits|decimals|precision|scale|currency|currency_?code|locale|units?|format|time_?zone|tz)$/i;

export function proposeHeuristic(recording: Recording, { maxPerTest = DEFAULT_MAX_PER_TEST }: HeuristicOptions = {}): ProposalResult {
  const snapshot = normalise(recording.snapshot ?? '');
  const candidates = uniqueByTarget(recording.exchanges).flatMap((exchange) => candidatesFor(exchange, snapshot));
  candidates.sort((a, b) => b.score - a.score);
  return toProposal(pickDiverse(candidates, maxPerTest), recording);
}

// A mutant hits every matching request anyway, so one per method + path.
function uniqueByTarget(exchanges: readonly Exchange[]): Exchange[] {
  const seen = new Set<string>();
  return exchanges.filter((x) => {
    const key = `${x.method} ${x.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidatesFor(exchange: Exchange, snapshot: string): Candidate[] {
  const ctx: Ctx = {
    target: { method: exchange.method, path: exchange.path },
    label: `${exchange.method} ${exchange.path}`,
    snapshot,
    body: parseJson(exchange.body),
  };
  const out: Candidate[] = [];
  if (exchange.status >= 200 && exchange.status < 300) out.push(serverError(ctx));
  if (ctx.body !== undefined) out.push(...bodyCandidates(ctx));
  const bonus = exchange.method === 'GET' || exchange.method === 'HEAD' ? 0 : SCORE.writeBonus;
  return out.map((c) => ({ ...c, score: c.score + bonus }));
}

function bodyCandidates(ctx: Ctx): Candidate[] {
  const out: Candidate[] = [];
  let leaves = 0;
  walk(ctx.body, [], (value, segments) => {
    if (++leaves > MAX_LEAVES) return false;
    // first list item only, the rest would be near-duplicates
    if (segments.some((s) => typeof s === 'number' && s > 0)) return true;
    const candidate = Array.isArray(value) ? droppedEntry(value, segments, ctx) : leafCandidate(value, segments, ctx);
    if (candidate) out.push(candidate);
    return true;
  });
  return out;
}

function leafCandidate(value: unknown, segments: Segment[], ctx: Ctx): Candidate | null {
  if (value === null || typeof value === 'object' || value === REDACTED) return null;
  const key = String(segments.at(-1) ?? '');
  if (typeof value === 'boolean') return isIdLike(key) ? null : flippedFlag(value, segments, key, ctx);
  if (FORMAT_KEY.test(key) && (typeof value === 'number' || typeof value === 'string')) return changedFormat(value, segments, key, ctx);
  // the user can't see it, so neither can a UI test
  if (!isVisible(value, ctx.snapshot)) return null;
  if (typeof value === 'number') return changedNumber(value, segments, key, ctx);
  if (typeof value === 'string') return changedText(value, segments, key, ctx);
  return null;
}

function changedFormat(value: string | number, segments: Segment[], key: string, ctx: Ctx): Candidate | null {
  const pointer = formatPointer(segments);
  const next = typeof value === 'number' ? mutateNumber(value) : (siblingValue(ctx.body, segments, value) ?? '');
  if (next === value) return null;
  return {
    target: ctx.target,
    kind: typeof value === 'number' ? 'number' : 'string',
    score: SCORE.number + SCORE.moneyBonus,
    risk: 'wrong-data',
    title: `${ctx.label}: ${pointer} ${JSON.stringify(value)} → ${JSON.stringify(next)}`,
    rationale: `"${key}" controls how values are displayed, so prices, dates or amounts come out formatted wrong.`,
    assertionHint: `Assert the exact formatted text (decimal places, currency, units), not a loose pattern like /[\\d,]+\\.\\d+/.`,
    ops: [{ op: 'replace', path: pointer, value: next }],
  };
}

function serverError(ctx: Ctx): Candidate {
  return {
    target: ctx.target,
    kind: 'status',
    score: SCORE.serverError,
    risk: 'error-handling',
    title: `${ctx.label} fails with HTTP 500`,
    rationale: 'The server returns an error instead of data. A test that relies on this request should notice the failure.',
    // a real 500 doesn't come with the success payload
    ops: [
      { op: 'status', value: 500 },
      { op: 'setBody', value: { error: 'Internal Server Error' } },
    ],
    assertionHint: `Assert the outcome of the step that calls ${ctx.label}, so a failed request makes the test fail.`,
  };
}

function droppedEntry(list: unknown[], segments: Segment[], ctx: Ctx): Candidate | null {
  if (list.length === 0) return null;
  const visible = list.some((el) => leafValues(el).some((v) => isVisible(v, ctx.snapshot)));
  if (!visible) return null;
  const pointer = formatPointer(segments);
  return {
    target: ctx.target,
    kind: 'array',
    score: SCORE.droppedEntry,
    risk: 'missing-data',
    title: `${ctx.label}: drop the first entry of ${pointer || 'the list'}`,
    rationale: `The response loses one of its ${list.length} entries. The page should show one fewer item.`,
    ops: [{ op: 'remove', path: formatPointer([...segments, 0]) }],
    assertionHint: `Assert the exact number of items, e.g. \`await expect(<item locator>).toHaveCount(${list.length})\`.`,
  };
}

function flippedFlag(value: boolean, segments: Segment[], key: string, ctx: Ctx): Candidate {
  const pointer = formatPointer(segments);
  return {
    target: ctx.target,
    kind: 'boolean',
    score: SCORE.flag,
    risk: 'wrong-state',
    title: `${ctx.label}: flip ${pointer} to ${!value}`,
    rationale: `A flag the page may use to decide what to show changes from ${value} to ${!value}.`,
    ops: [{ op: 'replace', path: pointer, value: !value }],
    assertionHint: `Assert the UI state that depends on "${key}".`,
  };
}

function changedNumber(value: number, segments: Segment[], key: string, ctx: Ctx): Candidate {
  const pointer = formatPointer(segments);
  const next = mutateNumber(value);
  const money = MONEY_KEY.test(key);
  const shown = visibleForm(value, ctx.snapshot) ?? formatNumber(value);
  return {
    target: ctx.target,
    kind: 'number',
    score:
      SCORE.number +
      (money ? SCORE.moneyBonus : 0) +
      (AGGREGATE_KEY.test(key) ? SCORE.aggregateBonus : 0) +
      (segments.length <= 1 ? SCORE.topLevelBonus : 0),
    risk: money ? 'wrong-calculation' : 'wrong-data',
    title: `${ctx.label}: ${pointer} ${value} → ${next}`,
    rationale: money ? `An off-by-one error in "${key}". Users would see a wrong amount.` : `"${key}" comes back with a different value than the page should show.`,
    ops: [{ op: 'replace', path: pointer, value: next }],
    assertionHint: `Assert the exact value shown for "${key}", e.g. \`await expect(<locator>).toHaveText(/${escapeRegExp(shown)}/)\`.`,
  };
}

function changedText(value: string, segments: Segment[], key: string, ctx: Ctx): Candidate | null {
  const pointer = formatPointer(segments);
  // Swap in a sibling's value when there is one. Otherwise blank it: a missing
  // field is a real bug, reversed text ("gnillop") isn't.
  const sibling = siblingValue(ctx.body, segments, value);
  const next = sibling ?? '';
  if (next === value) return null;
  return {
    target: ctx.target,
    kind: 'string',
    score: SCORE.text + (sibling !== null ? SCORE.siblingBonus : 0),
    risk: sibling !== null ? 'wrong-data' : 'missing-data',
    title: `${ctx.label}: ${pointer} "${value}" → "${next}"`,
    rationale: sibling !== null ? `The page shows another entry's "${key}". A mixed-up record should be caught.` : `"${key}" comes back empty.`,
    ops: [{ op: 'replace', path: pointer, value: next }],
    assertionHint: `Assert the text "${value}" where it should appear, e.g. \`await expect(<locator>).toHaveText('${value.replace(/'/g, "\\'")}')\`.`,
  };
}

// Best first, capped per kind and per request so we get variety rather than
// eight tweaks of one field.
function pickDiverse(sorted: readonly Candidate[], max: number): Candidate[] {
  const picked: Candidate[] = [];
  const perKind = new Map<Kind, number>();
  const perTarget = new Map<string, number>();
  const kindCap = Math.max(2, Math.ceil(max / 3));
  const targetCap = Math.max(2, Math.ceil(max / 2));
  for (const c of sorted) {
    if (picked.length >= max) break;
    const t = `${c.target.method} ${c.target.path}`;
    if ((perKind.get(c.kind) ?? 0) >= kindCap || (perTarget.get(t) ?? 0) >= targetCap) continue;
    perKind.set(c.kind, (perKind.get(c.kind) ?? 0) + 1);
    perTarget.set(t, (perTarget.get(t) ?? 0) + 1);
    picked.push(c);
  }
  return picked;
}

function toProposal(picked: readonly Candidate[], recording: Recording): ProposalResult {
  const mutants: Mutant[] = [];
  const rejected: Rejected[] = [];
  for (const { kind: _kind, score: _score, ...c } of picked) {
    const mutant: Mutant = { id: `m_${hash([recording.key, c.target, c.ops], 8)}`, source: 'heuristic', ...c };
    const exchange = recording.exchanges.find((x) => x.method === c.target.method && x.path === c.target.path);
    const problem = dryRun(mutant, exchange);
    if (problem) rejected.push({ title: c.title, reason: problem });
    else mutants.push(mutant);
  }
  return { mutants, rejected };
}

type Visitor = (value: unknown, segments: Segment[]) => boolean;

function walk(value: unknown, segments: Segment[], visit: Visitor): boolean {
  if (!visit(value, segments)) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!walk(value[i], [...segments, i], visit)) return false;
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!walk(v, [...segments, k], visit)) return false;
  }
  return true;
}

function leafValues(value: unknown): unknown[] {
  const out: unknown[] = [];
  walk(value, [], (v) => {
    if (v !== null && typeof v !== 'object') out.push(v);
    return out.length < 50;
  });
  return out;
}

function parseJson(text: string | null): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

// Ids and bookkeeping rather than user-facing state. The suffix check is
// case-sensitive on purpose: orderId and user_id match, paid and valid don't.
export function isIdLike(key: string): boolean {
  return /^(_?id|uuid|guid|etag|version|__typename)$/i.test(key) || /(_id|_uuid|Id|ID|Uuid|UUID)$/.test(key) || /(created|updated|timestamp)/i.test(key);
}

// `snapshot` must already be normalised
export function isVisible(value: unknown, snapshot: string): boolean {
  if (!snapshot) return false;
  if (typeof value === 'number') return visibleForm(value, snapshot) !== null;
  if (typeof value === 'string') {
    const v = normalise(value.trim());
    // whole words only, or "ok" would match "broken"
    return v.length >= 2 && new RegExp(`(^|[^a-z0-9])${escapeRegExp(v)}($|[^a-z0-9])`).test(snapshot);
  }
  return false;
}

// prefer the longest form on the page, e.g. "5.00" over "5"
function visibleForm(n: number, snapshot: string): string | null {
  if (!snapshot) return null;
  const found = numberForms(n).filter((form) => containsNumber(snapshot, form));
  return found.length ? found.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

function numberForms(n: number): string[] {
  const forms = new Set([String(n), n.toFixed(2)]);
  if (Number.isInteger(n) && Math.abs(n) >= 1000) forms.add(n.toLocaleString('en-US'));
  return [...forms];
}

// So 5 doesn't match inside 25.00. A lone digit followed by letters is a label
// like the "2h" button, not the value 2.
function containsNumber(haystack: string, needle: string): boolean {
  const after = needle.length === 1 ? '(?![0-9a-z])' : '(?![0-9])';
  return new RegExp(`(^|[^0-9.])${escapeRegExp(needle)}${after}`).test(haystack);
}

function mutateNumber(n: number): number {
  if (n === 0) return 1;
  return Math.round((n + 1) * 1e6) / 1e6;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// For a string in a list of objects, borrow the same field from a sibling so
// the mutant looks like a mixed-up record instead of gibberish.
function siblingValue(root: unknown, segments: Segment[], value: string): string | null {
  if (segments.length < 2) return null;
  const index = segments.at(-2);
  const field = segments.at(-1)!;
  if (typeof index !== 'number') return null;
  let list: unknown = root;
  for (const s of segments.slice(0, -2)) list = (list as Record<Segment, unknown> | undefined)?.[s];
  if (!Array.isArray(list)) return null;
  for (let j = 0; j < list.length; j++) {
    const other = (list[j] as Record<Segment, unknown> | undefined)?.[field];
    if (j !== index && typeof other === 'string' && other !== value) return other;
  }
  return null;
}

