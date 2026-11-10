import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, describeOps, dryRun, matchesTarget, MutationError, parsePointer, validateMutant } from '../dist/mutations.js';
import type { MutationOp } from '../dist/types.js';

const res = (body: unknown, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json', 'content-length': '99' },
  body: JSON.stringify(body),
});
const cart = { items: [{ name: 'A', price: 1 }, { name: 'B', price: 2 }], total: 3, 'a/b': 1, 'c~d': 2 };
const body = (ops: MutationOp[]) => JSON.parse(applyMutation(res(cart), ops).body);

test('parsePointer handles escapes and root', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
  assert.throws(() => parsePointer('items'), MutationError);
});

test('replace, remove, add, move, copy', () => {
  assert.equal(body([{ op: 'replace', path: '/total', value: 4 }]).total, 4);
  assert.equal(body([{ op: 'replace', path: '/a~1b', value: 9 }])['a/b'], 9);
  assert.deepEqual(body([{ op: 'remove', path: '/items/0' }]).items, [{ name: 'B', price: 2 }]);
  assert.equal(body([{ op: 'add', path: '/items/-', value: { name: 'C', price: 5 } }]).items.length, 3);
  assert.equal(body([{ op: 'add', path: '/items/0', value: { name: 'Z' } }]).items[0].name, 'Z');
  assert.deepEqual(
    body([{ op: 'move', from: '/items/1', path: '/items/0' }]).items.map((i: { name: string }) => i.name),
    ['B', 'A'],
  );
  assert.equal(body([{ op: 'copy', from: '/items/0/name', path: '/items/1/name' }]).items[1].name, 'A');
  assert.equal(body([{ op: 'replace', path: '', value: [] }]).length, 0);
});

test('missing paths and bad indexes throw', () => {
  assert.throws(() => body([{ op: 'replace', path: '/nope', value: 1 }]), /does not exist/);
  assert.throws(() => body([{ op: 'remove', path: '/items/5' }]), /out of range/);
  assert.throws(() => body([{ op: 'replace', path: '/items/01', value: 1 }]), /not a valid array index/);
  assert.throws(() => body([{ op: 'move', from: '/items', path: '/items/0' }]), /own child/);
});

test('status and setBody change the response and drop stale headers', () => {
  const out = applyMutation(res(cart), [
    { op: 'status', value: 500 },
    { op: 'setBody', value: { error: 'boom' } },
  ]);
  assert.equal(out.status, 500);
  assert.deepEqual(JSON.parse(out.body), { error: 'boom' });
  assert.equal(out.headers['content-length'], undefined);
  assert.equal(out.headers['content-type'], 'application/json');
});

test('JSON ops on a non-JSON body fail clearly', () => {
  assert.throws(() => applyMutation({ status: 200, body: '<html>' }, [{ op: 'remove', path: '/a' }]), /not JSON/);
});

test('the original value is not shared with the mutated body', () => {
  const value = { nested: [1] };
  const out = applyMutation(res({ a: 1 }), [{ op: 'replace', path: '/a', value }]);
  value.nested.push(2);
  assert.deepEqual(JSON.parse(out.body).a, { nested: [1] });
});

test('validateMutant reports structural problems', () => {
  assert.deepEqual(validateMutant({ id: 'm', target: { method: 'GET', path: '/x' }, ops: [{ op: 'status', value: 500 }] }), []);
  const errors = validateMutant({ id: '', target: { method: 'GET', path: 'x' }, ops: [{ op: 'status', value: 99 }, { op: 'nope' }] });
  assert.ok(errors.some((e) => e.includes('id')));
  assert.ok(errors.some((e) => e.includes('target.path')));
  assert.ok(errors.some((e) => e.includes('status must be')));
  assert.ok(errors.some((e) => e.includes('unknown op')));
});

test('dryRun rejects mutants that do nothing or do not apply', () => {
  const exchange = { status: 200, body: JSON.stringify(cart) };
  const base = { id: 'm', target: { method: 'GET', path: '/api' } };
  assert.equal(dryRun({ ...base, ops: [{ op: 'replace', path: '/total', value: 4 }] }, exchange), null);
  assert.match(dryRun({ ...base, ops: [{ op: 'replace', path: '/total', value: 3 }] }, exchange) ?? '', /does not change/);
  assert.match(dryRun({ ...base, ops: [{ op: 'remove', path: '/missing' }] }, exchange) ?? '', /does not exist/);
  assert.match(dryRun({ ...base, ops: [{ op: 'status', value: 500 }] }, null) ?? '', /no body/);
});

test('matchesTarget compares method and pathname only', () => {
  const t = { method: 'POST', path: '/api/checkout' };
  assert.ok(matchesTarget(t, 'post', 'http://localhost:1/api/checkout?x=1'));
  assert.ok(!matchesTarget(t, 'GET', 'http://localhost:1/api/checkout'));
  assert.ok(!matchesTarget(t, 'POST', 'http://localhost:1/api/checkout/2'));
});

test('describeOps is readable', () => {
  assert.equal(describeOps([{ op: 'status', value: 500 }, { op: 'remove', path: '/items/0' }]), 'status → 500; remove /items/0');
});
