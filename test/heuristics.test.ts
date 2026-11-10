import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIdLike, isVisible, proposeHeuristic } from '../dist/heuristics.js';
import type { Recording } from '../dist/types.js';

const exchange = (method: string, path: string, status: number, body: unknown) => ({
  method,
  url: `http://localhost${path}`,
  path,
  status,
  contentType: 'application/json',
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const recording: Recording = {
  key: 'chromium › cart.spec.ts › cart',
  project: 'chromium',
  titlePath: ['cart.spec.ts', 'cart'],
  title: 'cart',
  file: '/cart.spec.ts',
  line: 1,
  status: 'passed',
  recordedAt: '2026-01-01T00:00:00.000Z',
  exchanges: [
    exchange('GET', '/api/cart', 200, {
      id: 'c_99',
      updatedAt: '2026-01-01',
      items: [
        { sku: 'A1', name: 'Mug', price: 12.5, qty: 2 },
        { sku: 'B2', name: 'Pen', price: 3, qty: 1 },
      ],
      total: 28,
      giftWrap: false,
    }),
    exchange('POST', '/api/order', 201, { orderId: 'Z-1', status: 'ok' }),
    exchange('GET', '/logo.svg', 200, '<svg/>'),
  ],
  snapshot: '- heading "Cart"\n- row "Mug 2 $25.00"\n- row "Pen 1 $3.00"\n- text: Total $28.00\n- status: Order Z-1 placed',
};

test('isVisible matches numbers as whole tokens in their displayed forms', () => {
  const snap = '- text: total $28.00 and 125';
  assert.ok(isVisible(28, snap));
  assert.ok(isVisible(125, snap));
  assert.ok(!isVisible(12, snap));
  assert.ok(!isVisible(2, snap));
  assert.ok(isVisible('total', snap));
  assert.ok(!isVisible('x', snap));
});

test('isVisible matches strings as whole words', () => {
  const snap = '- status: broken link (pro)';
  assert.ok(!isVisible('ok', snap));
  assert.ok(!isVisible('link (', '- text: linking'));
  assert.ok(isVisible('Pro', snap));
  assert.ok(isVisible('broken link', snap));
});

test('isIdLike spots identifiers without catching ordinary words that end in "id"', () => {
  for (const key of ['id', '_id', 'ID', 'orderId', 'user_id', 'sessionUUID', 'createdAt', 'updated_at', 'etag']) {
    assert.ok(isIdLike(key), key);
  }
  for (const key of ['paid', 'valid', 'isPaid', 'void', 'giftWrap', 'inStock']) {
    assert.ok(!isIdLike(key), key);
  }
});

test('flags with names like "paid" are mutated; id flags are not', () => {
  const rec: Recording = {
    ...recording,
    exchanges: [
      {
        method: 'GET',
        url: 'http://localhost/api/invoice',
        path: '/api/invoice',
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ paid: true, hasId: true }),
      },
    ],
  };
  const titles = proposeHeuristic(rec, { maxPerTest: 20 }).mutants.map((m) => m.title);
  assert.ok(titles.includes('GET /api/invoice: flip /paid to false'));
  assert.ok(!titles.some((t) => t.includes('/hasId')));
});

test('proposes visible, varied mutants and skips invisible ids', () => {
  const { mutants, rejected } = proposeHeuristic(recording, { maxPerTest: 8 });
  assert.equal(rejected.length, 0);
  assert.ok(mutants.length >= 5 && mutants.length <= 8);
  const titles = mutants.map((m) => m.title).join('\n');
  assert.match(titles, /\/total 28 → 29/);
  assert.match(titles, /drop the first entry of \/items/);
  assert.match(titles, /POST \/api\/order fails with HTTP 500/);
  assert.match(titles, /orderId "Z-1"/);
  assert.doesNotMatch(titles, /\/id |updatedAt|\/sku/);
  // only the first list item gets field mutants
  assert.doesNotMatch(titles, /\/items\/1\//);
  for (const m of mutants) assert.equal(m.source, 'heuristic');
});

test('formatting fields get mutants even though their value is not on the page', () => {
  const rec: Recording = {
    ...recording,
    exchanges: [
      {
        method: 'GET',
        url: 'http://localhost/api/symbol',
        path: '/api/symbol',
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: 'USTEC', digits: 2, count: 2 }),
      },
    ],
    snapshot: '- button "2h"\n- text: USTEC O27,910.90',
  };
  const mutants = proposeHeuristic(rec, { maxPerTest: 20 }).mutants;
  const digits = mutants.find((m) => m.title.includes('/digits'));
  assert.ok(digits, 'digits gets a mutant');
  assert.deepEqual(digits.ops, [{ op: 'replace', path: '/digits', value: 3 }]);
  assert.match(digits.assertionHint, /decimal places/);
  // the "2" in "2h" is a label, so `count: 2` is not on the page
  assert.ok(!mutants.some((m) => m.title.includes('/count')));
});

test('lists inside later list items are skipped too', () => {
  const rec: Recording = {
    ...recording,
    exchanges: [
      {
        method: 'GET',
        url: 'http://localhost/api/orders',
        path: '/api/orders',
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ orders: [{ lines: ['Mug'] }, { lines: ['Pen'] }] }),
      },
    ],
    snapshot: '- text: Mug Pen',
  };
  const titles = proposeHeuristic(rec, { maxPerTest: 20 }).mutants.map((m) => m.title).join('\n');
  assert.match(titles, /drop the first entry of \/orders\/0\/lines/);
  assert.doesNotMatch(titles, /\/orders\/1\//);
});

test('string mutants borrow a sibling value when there is one', () => {
  const { mutants } = proposeHeuristic(recording, { maxPerTest: 20 });
  const name = mutants.find((m) => m.ops[0]?.op === 'replace' && m.ops[0].path === '/items/0/name');
  assert.ok(name, 'expected a mutant on the first item name');
  assert.deepEqual(name.ops[0], { op: 'replace', path: '/items/0/name', value: 'Pen' });
});

test('error mutants replace the body as a real server error would', () => {
  const { mutants } = proposeHeuristic(recording, { maxPerTest: 20 });
  const err = mutants.find((m) => m.title === 'GET /api/cart fails with HTTP 500');
  assert.deepEqual(err?.ops, [
    { op: 'status', value: 500 },
    { op: 'setBody', value: { error: 'Internal Server Error' } },
  ]);
});

test('ids are stable across runs and respect the limit', () => {
  const a = proposeHeuristic(recording, { maxPerTest: 3 });
  const b = proposeHeuristic(recording, { maxPerTest: 3 });
  assert.equal(a.mutants.length, 3);
  assert.deepEqual(
    a.mutants.map((m) => m.id),
    b.mutants.map((m) => m.id),
  );
});

test('no snapshot means only error and flag mutants', () => {
  const { mutants } = proposeHeuristic({ ...recording, snapshot: null }, { maxPerTest: 20 });
  assert.ok(mutants.every((m) => m.risk === 'error-handling' || m.risk === 'wrong-state'));
});
