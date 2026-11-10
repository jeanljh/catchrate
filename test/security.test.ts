// Regression tests for the security fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { applyMutation, parsePointer } from '../dist/mutations.js';
import { OpenAICompatibleProvider } from '../dist/providers/index.js';
import { isSecretKey, REDACTED, redactBody, redactJson, redactText, stripQuery } from '../dist/redact.js';
import { buildReport, code, inline, renderMarkdown } from '../dist/report.js';
import { safeJoin } from '../dist/store.js';
import { parseMutantsFile, parseReport } from '../dist/validate.js';
import type { MutantsFile, TestResult } from '../dist/types.js';

// built at runtime so GitHub's secret scanning doesn't flag this file
const fake = (prefix: string, rest: string, sep = '-') => `${prefix}${sep}${rest}`;

test('isSecretKey recognises credential fields but not ordinary ones', () => {
  for (const key of ['password', 'access_token', 'refreshToken', 'csrf-token', 'apiKey', 'x_api_key', 'Authorization', 'set-cookie', 'client_secret', 'privateKey', 'sid', 'ssn', 'cvv', 'pin']) {
    assert.ok(isSecretKey(key), key);
  }
  for (const key of ['name', 'total', 'author', 'shipping', 'inside', 'description', 'status', 'pinned']) {
    assert.ok(!isSecretKey(key), key);
  }
  assert.ok(isSecretKey('accountNumber', ['account_number']), 'extra keys match regardless of style');
});

test('redactJson masks secret keys and credential-looking values at any depth', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
  const out = redactJson({
    user: { name: 'Ada', password: 'hunter2', tokens: { access: 'abc' } },
    sessions: [{ sessionToken: 'xyz', note: `token is ${jwt}` }],
    total: 28,
  }) as any;
  assert.equal(out.user.name, 'Ada');
  assert.equal(out.user.password, REDACTED);
  // everything under a secret key is masked, structure kept
  assert.deepEqual(out.user.tokens, { access: REDACTED });
  assert.equal(out.sessions[0].sessionToken, REDACTED);
  assert.equal(out.sessions[0].note, `token is ${REDACTED}`);
  assert.equal(out.total, 28);
});

test('redactText and redactBody catch keys in free text and non-JSON bodies', () => {
  assert.equal(redactText('Authorization: Bearer abcdefgh12345678'), `Authorization: ${REDACTED}`);
  assert.equal(redactText(`key ${fake('sk', 'ant-FAKEFAKEFAKE1234567890')} leaked`), `key ${REDACTED} leaked`);
  assert.equal(redactText(fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123', '')), REDACTED);
  assert.equal(redactBody('<p>Bearer abcdefgh12345678</p>'), `<p>${REDACTED}</p>`);
  assert.equal(JSON.parse(redactBody('{"apiKey":"k1","n":1}')).apiKey, REDACTED);
});

test('stripQuery drops query strings and fragments', () => {
  assert.equal(stripQuery('https://shop.test/api/cart?token=abc#x'), 'https://shop.test/api/cart');
  assert.equal(stripQuery('not a url?x=1'), 'not a url');
});

const validFile = (): MutantsFile => ({
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  generator: { source: 'heuristic' },
  tests: [
    {
      key: 'p › a.spec.ts › t',
      project: 'p',
      titlePath: ['a.spec.ts', 't'],
      title: 't',
      file: '/a.spec.ts',
      rejected: [],
      mutants: [
        {
          id: 'm_0123abcd',
          source: 'heuristic',
          title: 'bug',
          risk: 'wrong-data',
          rationale: '',
          target: { method: 'GET', path: '/api/x' },
          ops: [{ op: 'status', value: 500 }],
          assertionHint: '',
        },
      ],
    },
  ],
});

test('parseMutantsFile accepts a well-formed file', () => {
  assert.equal(parseMutantsFile(validFile()).tests.length, 1);
});

test('parseMutantsFile rejects ids that could escape the output folder, bad ops and unknown risks', () => {
  const file = validFile() as any;
  file.tests[0].mutants.push({ ...file.tests[0].mutants[0], id: '../../../.github/workflows/evil' });
  file.tests[0].mutants.push({ ...file.tests[0].mutants[0], id: 'm_0123abcd' });
  file.tests[0].mutants.push({ ...file.tests[0].mutants[0], id: 'm_ffffffff', ops: [{ op: 'eval', value: 'x' }] });
  file.tests[0].mutants.push({ ...file.tests[0].mutants[0], id: 'm_eeeeeeee', risk: 'pwn' });
  assert.throws(
    () => parseMutantsFile(file, 'mutants.json'),
    (e: unknown) =>
      e instanceof Error &&
      /mutants\.json is invalid/.test(e.message) &&
      /id must look like "m_<hex>"/.test(e.message) &&
      /is duplicated/.test(e.message) &&
      /unknown op "eval"/.test(e.message) &&
      /risk must be one of/.test(e.message),
  );
  assert.throws(() => parseMutantsFile({ version: 2, tests: [] }), /unsupported version/);
  assert.throws(() => parseMutantsFile('nope'), /not a JSON object/);
});

test('parseReport rejects files that are not reports', () => {
  assert.throws(() => parseReport({ hello: 'world' }, 'x.json'), /x\.json is not a catchrate report/);
});

test('safeJoin keeps paths inside the base folder', () => {
  const base = path.resolve('tmp-out');
  assert.equal(safeJoin(base, 'run', 'm_01.json'), path.join(base, 'run', 'm_01.json'));
  assert.throws(() => safeJoin(base, 'run', '../../evil.json'), /outside/);
  assert.throws(() => safeJoin(base, path.resolve('/etc/passwd')), /outside/);
  assert.throws(() => safeJoin(base, '.'), /outside/);
});

test('JSON pointers cannot reach prototype properties', () => {
  assert.throws(() => parsePointer('/__proto__/polluted'), /not allowed/);
  assert.throws(() => parsePointer('/a/constructor/prototype'), /not allowed/);
  const res = { status: 200, body: '{"a":{}}' };
  assert.throws(() => applyMutation(res, [{ op: 'add', path: '/a/__proto__', value: { polluted: true } }]), /not allowed/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('untrusted text cannot inject HTML, links or break out of code spans', () => {
  assert.equal(inline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(inline('[click](https://evil.test)'), '\\[click\\](https://evil.test)');
  assert.equal(inline('line one\nline two'), 'line one line two');
  assert.equal(inline('keep `<b>` code'), 'keep `<b>` code');
  assert.equal(code('a`b'), '`` a`b ``');
  assert.equal(code('plain'), '`plain`');
});

test('a hostile mutant title renders inertly in report.md', () => {
  const result: TestResult = {
    key: 'p › a.spec.ts › t',
    project: 'p',
    titlePath: ['a.spec.ts', '</details><script>x</script>'],
    title: 't',
    file: '/a.spec.ts',
    status: 'ok',
    mutants: [
      {
        ...validFile().tests[0]!.mutants[0]!,
        title: '</details><img src=x> [phish](https://evil.test)',
        outcome: 'survived',
      },
    ],
  };
  const md = renderMarkdown(buildReport({ results: [result] }));
  assert.ok(!md.includes('<script>'), 'no raw script tag');
  assert.ok(!md.includes('<img'), 'no raw img tag');
  assert.ok(!/(^|[^\\])\[phish\]\(/.test(md), 'no live link');
  assert.equal(md.match(/<\/details>/g)?.length ?? 0, 0, 'no stray </details>');
});

test('API keys are never sent over plain HTTP to another machine', () => {
  assert.throws(
    () => new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'http://llm.example.com/v1', model: 'm', apiKey: 'k' }),
    /Refusing to send an API key over unencrypted HTTP/,
  );
  // local, https, or plain http without a key are all fine
  new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: 'k' });
  new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: 'k' });
  new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'http://gpu-box.lan:8000/v1', model: 'm' });
});

test('base URLs must be http(s) without embedded credentials', () => {
  assert.throws(() => new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'file:///etc/passwd', model: 'm' }), /http or https/);
  assert.throws(() => new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'https://user:pw@llm.example.com/v1', model: 'm' }), /must not contain credentials/);
  assert.throws(() => new OpenAICompatibleProvider({ id: 'openai', baseUrl: 'not a url', model: 'm' }), /not a valid URL/);
});

test('secrets echoed in server error messages are masked', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream rejected key ${fake('sk', 'live-FAKEFAKEFAKEFAKEFAKE')}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', maxRetries: 0 });
    await assert.rejects(
      provider.complete({ system: 's', user: 'u', schema: {}, schemaName: 'x' }),
      (e: unknown) => e instanceof Error && e.message.includes(REDACTED) && !e.message.includes('FAKEFAKE'),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
