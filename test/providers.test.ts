// OpenAI-compatible provider against a fake chat completions server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SetupError } from '../dist/errors.js';
import { proposeWithLLM } from '../dist/llm.js';
import { createProvider, extractJson, OpenAICompatibleProvider } from '../dist/providers/index.js';
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

const MUTANTS = {
  mutants: [
    {
      title: 'Total off by one',
      risk: 'wrong-calculation',
      rationale: 'Users see the wrong total.',
      method: 'GET',
      path: '/api/cart',
      ops: [{ op: 'replace', path: '/total', from: null, valueJson: '29' }],
      assertionHint: "await expect(page.getByTestId('total')).toHaveText('$28.00');",
    },
  ],
};

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any> | null;
}
type Reply = { status?: number; headers?: Record<string, string>; json?: unknown };
type Handler = (req: Seen, n: number) => Reply;

// runs fn against a throwaway server and returns every request it got
async function withServer(handler: Handler, fn: (baseUrl: string) => Promise<void>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const reply = handler(entry, seen.length);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return seen;
}

const models = (...ids: string[]): Reply => ({ json: { object: 'list', data: ids.map((id) => ({ id })) } });
const chat = (content: string, finish = 'stop'): Reply => ({
  json: { choices: [{ finish_reason: finish, message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
});
const isModels = (r: Seen) => r.method === 'GET' && r.url === '/v1/models';
const formatOf = (r: Seen) => (r.body?.response_format?.type as string | undefined) ?? 'none';

test('uses JSON-schema structured output and turns the reply into mutants', async () => {
  const seen = await withServer(
    (r) => (isModels(r) ? models('local-model') : chat(JSON.stringify(MUTANTS))),
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl, model: 'local-model' });
      const { results, failures, usage } = await proposeWithLLM([recording], { provider });
      assert.equal(failures.length, 0);
      assert.equal(results.get(recording.key)?.mutants[0]?.title, 'Total off by one');
      assert.deepEqual(usage, { inputTokens: 120, outputTokens: 40 });
    },
  );
  const call = seen.find((r) => r.url === '/v1/chat/completions')!;
  assert.equal(call.body?.model, 'local-model');
  assert.equal(formatOf(call), 'json_schema');
  assert.equal(call.body?.response_format.json_schema.name, 'mutants');
  assert.equal(call.headers.authorization, undefined, 'local servers get no key');
});

test('steps down from json_schema to json_object to plain text, and remembers what worked', async () => {
  const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify(MUTANTS)}\n\`\`\`\nGood luck!`;
  const seen = await withServer(
    (r) => {
      if (isModels(r)) return models('m');
      return formatOf(r) === 'none' ? chat(fenced) : { status: 400, json: { error: { message: 'response_format not supported' } } };
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ id: 'lmstudio', baseUrl, model: 'm' });
      const { failures } = await proposeWithLLM([recording, { ...recording, key: 'second' }], { provider, concurrency: 1 });
      assert.equal(failures.length, 0);
    },
  );
  const calls = seen.filter((r) => r.url === '/v1/chat/completions');
  assert.deepEqual(calls.map(formatOf), ['json_schema', 'json_object', 'none', 'none']);
  assert.match(calls[2]!.body?.messages[0].content, /must match this JSON Schema/);
});

test('a 400 that is not about the response format fails that test without downgrading the rest', async () => {
  const seen = await withServer(
    (r) => {
      if (isModels(r)) return models('m');
      return r.body?.messages[1].content.includes('second') ? chat(JSON.stringify(MUTANTS)) : { status: 400, json: { error: 'prompt is too long: 140000 tokens' } };
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl, model: 'm' });
      const second = { ...recording, key: 'second', titlePath: ['cart.spec.ts', 'second'] };
      const { failures, results } = await proposeWithLLM([recording, second], { provider, concurrency: 1 });
      assert.equal(failures.length, 1);
      assert.match(failures[0]!.reason, /HTTP 400 .*prompt is too long/);
      assert.equal(results.get('second')?.mutants.length, 1);
    },
  );
  const calls = seen.filter((r) => r.url === '/v1/chat/completions');
  assert.deepEqual(calls.map(formatOf), ['json_schema', 'json_schema'], 'still asking for json_schema');
});

test('accepts raw values when a model ignores the valueJson convention', async () => {
  const loose = { mutants: [{ ...MUTANTS.mutants[0], ops: [{ op: 'replace', path: '/total', valueJson: 31 }] }] };
  await withServer(
    (r) => (isModels(r) ? models('m') : chat(JSON.stringify(loose))),
    async (baseUrl) => {
      const { results } = await proposeWithLLM([recording], { provider: new OpenAICompatibleProvider({ id: 'ollama', baseUrl, model: 'm' }) });
      assert.deepEqual(results.get(recording.key)?.mutants[0]?.ops, [{ op: 'replace', path: '/total', value: 31 }]);
    },
  );
});

test('sends the API key, and a rejected key stops the run', async () => {
  const seen = await withServer(
    () => ({ status: 401, json: { error: { message: 'bad key' } } }),
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ id: 'openai', baseUrl, model: 'm', apiKey: 'sk-test', keyHint: 'Set OPENAI_API_KEY.' });
      await assert.rejects(proposeWithLLM([recording], { provider }), (e: unknown) => e instanceof SetupError && /rejected the API key.*OPENAI_API_KEY/.test(e.message));
    },
  );
  assert.equal(seen[0]?.headers.authorization, 'Bearer sk-test');
  assert.equal(seen.length, 1, 'no test is sent after the check fails');
});

test('an unreachable local server is a setup error with a hint', async () => {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' });
  await assert.rejects(provider.check(), (e: unknown) => e instanceof SetupError && /Could not reach.*Is Ollama running\?/s.test(e.message));
});

test('an unknown model lists what the server has', async () => {
  await withServer(
    () => models('llama3.1:8b', 'qwen3:14b'),
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl, model: 'qwen3:4b' });
      await assert.rejects(provider.check(), /isn't available.*Available: llama3\.1:8b, qwen3:14b/);
    },
  );
});

test('rate limits are retried', async () => {
  const seen = await withServer(
    (r, n) => {
      if (isModels(r)) return models('m');
      return n === 2 ? { status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } } : chat(JSON.stringify(MUTANTS));
    },
    async (baseUrl) => {
      const { failures } = await proposeWithLLM([recording], { provider: new OpenAICompatibleProvider({ id: 'openai', baseUrl, model: 'm' }) });
      assert.equal(failures.length, 0);
    },
  );
  assert.equal(seen.filter((r) => r.url === '/v1/chat/completions').length, 2);
});

test('a truncated reply fails only that test', async () => {
  await withServer(
    (r) => (isModels(r) ? models('m') : chat('{"mutants": [', 'length')),
    async (baseUrl) => {
      const { failures } = await proposeWithLLM([recording], { provider: new OpenAICompatibleProvider({ id: 'ollama', baseUrl, model: 'm' }) });
      assert.match(failures[0]!.reason, /token limit/);
    },
  );
});

test('extractJson finds the object in fenced or chatty replies', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Sure! {"a":{"b":2}} Hope that helps.'), '{"a":{"b":2}}');
});

test('createProvider applies presets, keys and required options', () => {
  assert.throws(() => createProvider({ provider: 'ollama', env: {} }), /--model is required with --provider ollama/);
  assert.throws(() => createProvider({ provider: 'openai', model: 'm', env: {} }), /No API key.*OPENAI_API_KEY/);

  const ollama = createProvider({ provider: 'ollama', model: 'qwen3:14b', env: {} }) as OpenAICompatibleProvider;
  assert.equal(ollama.baseUrl, 'http://localhost:11434/v1');
  assert.equal(ollama.defaultConcurrency, 1);

  const lm = createProvider({ provider: 'lmstudio', model: 'm', env: {} }) as OpenAICompatibleProvider;
  assert.equal(lm.baseUrl, 'http://localhost:1234/v1');

  const openai = createProvider({ provider: 'openai', model: 'm', env: { OPENAI_API_KEY: 'k' } }) as OpenAICompatibleProvider;
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(openai.defaultConcurrency, 4);

  // A custom base URL (e.g. OpenRouter) doesn't demand OPENAI_API_KEY up front.
  const router = createProvider({ provider: 'openai', model: 'm', baseUrl: 'https://openrouter.ai/api/v1/', env: {} }) as OpenAICompatibleProvider;
  assert.equal(router.baseUrl, 'https://openrouter.ai/api/v1');

  assert.equal(createProvider({ env: {} }).id, 'claude');
});
