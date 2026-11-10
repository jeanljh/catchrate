// Asks a model (see ./providers) for mutants, one request per test. The model
// only ever returns data, ops on a recorded response, and every mutant gets
// dry-run against the recording before we keep it.

import fs from 'node:fs';
import { DEFAULT_MAX_PER_TEST, MAX_OPS, OPS, RISKS } from './constants.js';
import { ProposeError, SetupError } from './errors.js';
import { dryRun, findExchange } from './mutations.js';
import { ClaudeProvider } from './providers/claude.js';
import type { MutantProvider } from './providers/types.js';
import { hash } from './store.js';
import { escapeAttr } from './util.js';
import type { Mutant, MutationOp, OpName, ProposalResult, Recording, Rejected, Risk, Target } from './types.js';

export { ProposeError, SetupError };

const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });

export const MUTANT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mutants'],
  properties: {
    mutants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'risk', 'rationale', 'method', 'path', 'ops', 'assertionHint'],
        properties: {
          title: { type: 'string' },
          risk: { type: 'string', enum: [...RISKS] },
          rationale: { type: 'string' },
          method: { type: 'string' },
          path: { type: 'string' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['op', 'path', 'from', 'valueJson'],
              properties: {
                op: { type: 'string', enum: [...OPS] },
                path: nullable('string'),
                from: nullable('string'),
                valueJson: nullable('string'),
              },
            },
          },
          assertionHint: { type: 'string' },
        },
      },
    },
  },
};

// what the model sends back, per MUTANT_SCHEMA
interface RawOp {
  op: OpName;
  path: string | null;
  from: string | null;
  /** JSON text, though models that ignore the schema sometimes send the raw value */
  valueJson: unknown;
}
interface RawMutant {
  title: string;
  risk: string;
  rationale: string;
  method: string;
  path: string;
  ops: RawOp[];
  assertionHint: string;
}
export interface RawProposal {
  mutants: RawMutant[];
}

export const SYSTEM_PROMPT = `You design semantic mutants for end-to-end (E2E) test suites.

A mutant simulates one realistic backend bug by editing one API response that a Playwright test received. The tool replays the test with the edited response. If the test still passes, the test would miss that bug in production, and the report tells the team which assertion to add. Your mutants are only useful if they are bugs the user of the app would notice and a well-written test of this flow ought to catch.

How a mutant is expressed:
- "method" and "path" name one recorded request (path is the URL pathname only, e.g. /api/cart). Every response to that request is mutated.
- "ops" is a list of operations applied in order:
  - replace, add: "path" is a JSON Pointer into the response body (RFC 6901, e.g. /items/0/price), "valueJson" is the new value as JSON text (e.g. "65.96", "\\"Bob\\"", "false", "{\\"a\\":1}").
  - remove: "path" only. Removing an array element shifts the rest.
  - move, copy: "from" and "path" JSON Pointers.
  - status: "valueJson" is the new HTTP status code (e.g. "500", "403", "409").
  - setBody: "valueJson" is the full new body as JSON text.
  Set fields an operation doesn't use to null. Paths must exist in the recorded body (add may target a new key or the array index "-").

What makes a good mutant:
- It changes something visible to the user, or something the flow depends on. The final accessibility snapshot shows what was on screen. A change to an id or timestamp that never reaches the page is an equivalent mutant, so skip it.
- It is a plausible bug: a wrong total or price, a missing or duplicated line item, another customer's record, a stale or wrong status, a write that fails with 4xx/5xx, an empty list, a permission flag flipped.
- Mutants are diverse. Cover different requests and different kinds of risk rather than ten variations of one field.
- Prefer one or two operations per mutant. Keep related fields consistent only when the bug requires it.

For each mutant also give:
- "title": short, specific (e.g. "Cart total off by $1").
- "risk": one category from the enum.
- "rationale": one sentence on what the user would experience.
- "assertionHint": one Playwright assertion line that would catch this bug, written in the style of the test's existing locators (e.g. await expect(page.getByTestId('total')).toHaveText('$64.96');).`;

export interface LLMOptions {
  /** defaults to Claude */
  provider?: MutantProvider;
  maxPerTest?: number;
  /** defaults to provider.defaultConcurrency */
  concurrency?: number;
  log?: (message: string) => void;
}

export interface LLMResult {
  results: Map<string, ProposalResult>;
  failures: { key: string; reason: string }[];
  usage: { inputTokens: number; outputTokens: number };
}

// A SetupError stops everything; any other error only fails that one test.
export async function proposeWithLLM(recordings: readonly Recording[], options: LLMOptions = {}): Promise<LLMResult> {
  const { provider = new ClaudeProvider(), maxPerTest = DEFAULT_MAX_PER_TEST, log = () => {} } = options;
  const concurrency = options.concurrency ?? provider.defaultConcurrency;

  await provider.check();

  const results = new Map<string, ProposalResult>();
  const failures: LLMResult['failures'] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let next = 0;

  async function worker(): Promise<void> {
    while (next < recordings.length) {
      const recording = recordings[next++]!;
      try {
        const reply = await provider.complete({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(recording, maxPerTest),
          schema: MUTANT_SCHEMA,
          schemaName: 'mutants',
        });
        usage.inputTokens += reply.inputTokens;
        usage.outputTokens += reply.outputTokens;
        const result = toMutants(parseReply(reply.text), recording, maxPerTest);
        results.set(recording.key, result);
        log(`  ${recording.key}: ${result.mutants.length} mutants (${result.rejected.length} rejected)`);
      } catch (e) {
        if (e instanceof SetupError) throw e;
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ key: recording.key, reason });
        log(`  ${recording.key}: failed (${reason})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, recordings.length)) }, worker));
  return { results, failures, usage };
}

function parseReply(text: string): RawProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProposeError('the response was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as RawProposal).mutants)) {
    throw new ProposeError('the response JSON has no "mutants" list');
  }
  return parsed as RawProposal;
}

const MAX_SOURCE_CHARS = 60_000;
const MAX_BODY_CHARS = 30_000;
const MAX_EXCHANGES_CHARS = 200_000;
const MAX_SNAPSHOT_CHARS = 40_000;

export function buildUserPrompt(recording: Recording, maxPerTest: number): string {
  const notes: string[] = [];

  const exchanges: string[] = [];
  let used = 0;
  for (const [i, x] of recording.exchanges.entries()) {
    let body = x.body ?? '(no body)';
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // not JSON; keep the raw text
    }
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS);
      notes.push(`response ${i + 1} body was cut to ${MAX_BODY_CHARS} characters`);
    }
    if (x.truncated) notes.push(`response ${i + 1} body was already cut when recorded`);
    const attrs = `index="${i + 1}" method="${escapeAttr(x.method)}" path="${escapeAttr(x.path)}" status="${x.status}" content-type="${escapeAttr(x.contentType)}"`;
    const block = `<response ${attrs}>\n${body}\n</response>`;
    if (used + block.length > MAX_EXCHANGES_CHARS) {
      notes.push(`${recording.exchanges.length - i} later responses were left out for length`);
      break;
    }
    used += block.length;
    exchanges.push(block);
  }

  let snapshot = recording.snapshot ?? '(no snapshot captured)';
  if (snapshot.length > MAX_SNAPSHOT_CHARS) {
    snapshot = snapshot.slice(0, MAX_SNAPSHOT_CHARS);
    notes.push('the page snapshot was cut for length');
  }

  const source = readTestSource(recording, notes);

  return [
    `Propose up to ${maxPerTest} mutants for this Playwright test.`,
    `<test title="${escapeAttr(recording.titlePath.join(' › '))}" project="${escapeAttr(recording.project)}" file="${escapeAttr(recording.titlePath[0])}" line="${recording.line}">`,
    source,
    '</test>',
    '<recorded_responses>',
    exchanges.join('\n'),
    '</recorded_responses>',
    '<final_page_accessibility_snapshot>',
    snapshot,
    '</final_page_accessibility_snapshot>',
    notes.length ? `<input_notes>\n${notes.join('\n')}\n</input_notes>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function readTestSource(recording: Recording, notes: string[]): string {
  let text: string;
  try {
    text = fs.readFileSync(recording.file, 'utf8');
  } catch {
    notes.push('the test source file could not be read');
    return '(source unavailable)';
  }
  if (text.length <= MAX_SOURCE_CHARS) return text;
  // big spec file: just send a window around the test
  const lines = text.split('\n');
  const start = Math.max(0, recording.line - 1 - 40);
  const end = Math.min(lines.length, recording.line - 1 + 200);
  notes.push(`the spec file is long; only lines ${start + 1}-${end} are included`);
  return lines.slice(start, end).join('\n');
}

// Keep what applies cleanly to the recording, and say why the rest was dropped.
export function toMutants(raw: RawProposal | null | undefined, recording: Recording, maxPerTest = DEFAULT_MAX_PER_TEST): ProposalResult {
  const mutants: Mutant[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();

  for (const item of raw?.mutants ?? []) {
    const title = item?.title ?? '(untitled)';
    try {
      if (!Array.isArray(item.ops) || item.ops.length === 0) throw new ProposeError('no operations');
      if (item.ops.length > MAX_OPS) throw new ProposeError(`more than ${MAX_OPS} operations`);
      const ops = item.ops.map(convertOp);
      const target: Target = { method: String(item.method).toUpperCase(), path: normalisePath(item.path) };
      const exchange = findExchange(recording.exchanges, target);
      if (!exchange) throw new ProposeError(`${target.method} ${target.path} was not among the recorded requests`);
      const mutant: Mutant = {
        id: `m_${hash([recording.key, target, ops], 8)}`,
        source: 'llm',
        title,
        risk: isRisk(item.risk) ? item.risk : 'other',
        rationale: item.rationale ?? '',
        target,
        ops,
        assertionHint: item.assertionHint ?? '',
      };
      if (seen.has(mutant.id)) throw new ProposeError('duplicate of another mutant');
      const problem = dryRun(mutant, exchange);
      if (problem) throw new ProposeError(problem);
      seen.add(mutant.id);
      mutants.push(mutant);
    } catch (e) {
      rejected.push({ title, reason: (e as Error).message });
    }
  }

  if (mutants.length > maxPerTest) {
    for (const m of mutants.splice(maxPerTest)) rejected.push({ title: m.title, reason: `over the limit of ${maxPerTest} per test` });
  }
  return { mutants, rejected };
}

const isRisk = (r: unknown): r is Risk => (RISKS as readonly unknown[]).includes(r);

function convertOp(o: RawOp): MutationOp {
  const op: Record<string, unknown> = { op: o.op };
  if (o.path != null) op.path = o.path;
  if (o.from != null) op.from = o.from;
  if (typeof o.valueJson === 'string') {
    try {
      op.value = JSON.parse(o.valueJson);
    } catch {
      throw new ProposeError(`valueJson for ${o.op} is not valid JSON: ${o.valueJson}`);
    }
  } else if (o.valueJson != null) {
    // some models send the value itself instead of JSON text
    op.value = o.valueJson;
  }
  if (op.op === 'status' && typeof op.value === 'string' && /^\d{3}$/.test(op.value)) op.value = Number(op.value);
  if (op.op === 'status' || op.op === 'setBody') delete op.path;
  // dryRun() checks the shape
  return op as MutationOp;
}

function normalisePath(p: unknown): string {
  const s = String(p ?? '');
  if (/^https?:\/\//i.test(s)) return new URL(s).pathname;
  const noQuery = s.split('?')[0]!;
  return noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
}
