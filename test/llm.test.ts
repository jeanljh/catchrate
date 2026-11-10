import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL } from '../dist/constants.js';
import { buildUserPrompt, proposeWithLLM, ProposeError, toMutants } from '../dist/llm.js';
import type { RawProposal } from '../dist/llm.js';
import { ClaudeProvider } from '../dist/providers/index.js';
import type { ClaudeClient } from '../dist/providers/index.js';
import type { Recording } from '../dist/types.js';

const recording: Recording = {
  key: 'chromium › cart.spec.ts › cart',
  project: 'chromium',
  titlePath: ['cart.spec.ts', 'cart'],
  title: 'cart',
  file: '/does/not/exist.spec.ts',
  line: 3,
  status: 'passed',
  recordedAt: '2026-01-01T00:00:00.000Z',
  exchanges: [
    {
      method: 'GET',
      url: 'http://localhost/api/cart',
      path: '/api/cart',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ name: 'Mug' }], total: 28 }),
    },
  ],
  snapshot: '- text: Total $28.00',
};

type RawOp = RawProposal['mutants'][number]['ops'][number];
const op = (o: Partial<RawOp> & Pick<RawOp, 'op'>): RawOp => ({ path: null, from: null, valueJson: null, ...o });
const item = (o: Partial<RawProposal['mutants'][number]>) => ({
  title: 't',
  risk: 'wrong-calculation',
  rationale: 'r',
  method: 'GET',
  path: '/api/cart',
  assertionHint: 'h',
  ops: [],
  ...o,
});

test('toMutants converts valueJson, normalises paths and dry-runs each mutant', () => {
  const raw: RawProposal = {
    mutants: [
      item({ title: 'total off', ops: [op({ op: 'replace', path: '/total', valueJson: '29' })] }),
      item({ title: 'full url', path: 'http://localhost/api/cart?x=1', ops: [op({ op: 'status', path: '/ignored', valueJson: '"503"' })] }),
      item({ title: 'bad path', ops: [op({ op: 'remove', path: '/nope' })] }),
      item({ title: 'unknown request', path: '/api/other', ops: [op({ op: 'status', valueJson: '500' })] }),
      item({ title: 'bad json', ops: [op({ op: 'replace', path: '/total', valueJson: '{oops' })] }),
      item({ title: 'no-op', ops: [op({ op: 'replace', path: '/total', valueJson: '28' })] }),
      item({ title: 'total off again', ops: [op({ op: 'replace', path: '/total', valueJson: '29' })] }),
    ],
  };
  const { mutants, rejected } = toMutants(raw, recording, 8);
  assert.deepEqual(
    mutants.map((m) => m.title),
    ['total off', 'full url'],
  );
  assert.deepEqual(mutants[0]?.ops, [{ op: 'replace', path: '/total', value: 29 }]);
  assert.deepEqual(mutants[1]?.ops, [{ op: 'status', value: 503 }]);
  assert.equal(mutants[1]?.target.path, '/api/cart');
  const reasons = Object.fromEntries(rejected.map((r) => [r.title, r.reason]));
  assert.match(reasons['bad path']!, /does not exist/);
  assert.match(reasons['unknown request']!, /not among the recorded requests/);
  assert.match(reasons['bad json']!, /not valid JSON/);
  assert.match(reasons['no-op']!, /does not change/);
  assert.match(reasons['total off again']!, /duplicate/);
});

test('toMutants enforces the per-test limit', () => {
  const raw: RawProposal = { mutants: [29, 30, 31].map((v) => item({ title: `t${v}`, ops: [op({ op: 'replace', path: '/total', valueJson: String(v) })] })) };
  const { mutants, rejected } = toMutants(raw, recording, 2);
  assert.equal(mutants.length, 2);
  assert.match(rejected[0]!.reason, /over the limit/);
});

test('the prompt carries the responses, snapshot and a note when the source is unreadable', () => {
  const prompt = buildUserPrompt(recording, 5);
  assert.match(prompt, /Propose up to 5 mutants/);
  assert.match(prompt, /<response index="1" method="GET" path="\/api\/cart"/);
  assert.match(prompt, /"total": 28/);
  assert.match(prompt, /Total \$28\.00/);
  assert.match(prompt, /test source file could not be read/);
});

test('titles with quotes or angle brackets cannot break the prompt markup', () => {
  const prompt = buildUserPrompt({ ...recording, titlePath: ['a.spec.ts', 'shows "<b>" & more'] }, 5);
  assert.match(prompt, /title="a\.spec\.ts › shows &quot;&lt;b&gt;&quot; &amp; more"/);
});

interface Stub {
  client: ClaudeClient;
  calls: Record<string, unknown>[];
}

function stubClient(handler: (params: Record<string, unknown>) => unknown, retrieve: (id: string) => Promise<unknown> = async (id) => ({ id })): Stub {
  const calls: Record<string, unknown>[] = [];
  const client = {
    models: { retrieve },
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return handler(params);
        },
      },
    },
  };
  return { client: client as unknown as ClaudeClient, calls };
}

const textResponse = (obj: unknown) => ({
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify(obj) },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
});

test('proposeWithLLM sends a structured-output request with server-side fallback', async () => {
  const { client, calls } = stubClient(() => textResponse({ mutants: [item({ ops: [op({ op: 'replace', path: '/total', valueJson: '30' })] })] }));
  const { results, failures, usage } = await proposeWithLLM([recording], { provider: new ClaudeProvider({ client }), maxPerTest: 4 });
  assert.equal(failures.length, 0);
  assert.equal(results.get(recording.key)?.mutants.length, 1);
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 50 });
  const params = calls[0] as {
    model: string;
    betas: string[];
    fallbacks: unknown;
    thinking?: unknown;
    output_config: { effort: string; format: { type: string } };
  };
  assert.equal(params.model, DEFAULT_MODEL);
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.effort, 'medium');
  assert.equal(params.thinking, undefined);
});

test('refusals and truncated output become per-test failures, not crashes', async () => {
  let n = 0;
  const { client } = stubClient(() =>
    n++ === 0
      ? { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: {} }
      : { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"mutants": [' }], usage: {} },
  );
  const { failures } = await proposeWithLLM([recording, { ...recording, key: 'other' }], { provider: new ClaudeProvider({ client }), concurrency: 1 });
  assert.equal(failures.length, 2);
  assert.match(failures[0]!.reason, /declined.*cyber/);
  assert.match(failures[1]!.reason, /max_tokens/);
});

test('bad credentials abort the whole run with a helpful message', async () => {
  const { client } = stubClient(() => {
    throw Object.create(Anthropic.AuthenticationError.prototype);
  });
  await assert.rejects(proposeWithLLM([recording], { provider: new ClaudeProvider({ client }) }), (e: unknown) => e instanceof ProposeError && /ANTHROPIC_API_KEY/.test(e.message));
});

test('the preflight stops on missing credentials or an unknown model before any test is sent', async () => {
  const noCreds = stubClient(
    () => assert.fail('should not be called'),
    async () => {
      throw new Error('Could not resolve authentication method.');
    },
  );
  await assert.rejects(proposeWithLLM([recording], { provider: new ClaudeProvider({ client: noCreds.client }) }), (e: unknown) => e instanceof ProposeError && /ANTHROPIC_API_KEY/.test(e.message));
  assert.equal(noCreds.calls.length, 0);

  const badModel = stubClient(
    () => assert.fail('should not be called'),
    async () => {
      throw Object.create(Anthropic.NotFoundError.prototype);
    },
  );
  await assert.rejects(proposeWithLLM([recording], { provider: new ClaudeProvider({ client: badModel.client, model: 'nope' }) }), /Model "nope" was not found/);
});
