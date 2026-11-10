// Applying mutants to a response. The ops are a JSON Patch subset (RFC 6902)
// plus `status` and `setBody`. Mutants are data, never code.

import { MAX_OPS, OPS } from './constants.js';
import type { Exchange, MutationOp, OpName, Target } from './types.js';

export class MutationError extends Error {}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | null;
}

export interface MutatedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Segment = string | number;
type Container = Record<string, unknown> | unknown[];

export function parsePointer(pointer: unknown): string[] {
  if (typeof pointer !== 'string') throw new MutationError(`JSON pointer must be a string, got ${typeof pointer}`);
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new MutationError(`JSON pointer must start with "/": ${pointer}`);
  const segments = pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const unsafe = segments.find((s) => UNSAFE_SEGMENTS.has(s));
  if (unsafe !== undefined) throw new MutationError(`JSON pointer segment "${unsafe}" is not allowed`);
  return segments;
}

// would touch the prototype instead of the data
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function formatPointer(segments: readonly Segment[]): string {
  if (segments.length === 0) return '';
  return '/' + segments.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

const INDEX_RE = /^(0|[1-9]\d*)$/;

function arrayIndex(arr: unknown[], token: string, { allowEnd = false } = {}): number {
  if (allowEnd && token === '-') return arr.length;
  if (!INDEX_RE.test(token)) throw new MutationError(`"${token}" is not a valid array index`);
  const idx = Number(token);
  const max = allowEnd ? arr.length : arr.length - 1;
  if (idx > max) throw new MutationError(`array index ${idx} is out of range (length ${arr.length})`);
  return idx;
}

function isContainer(v: unknown): v is Container {
  return v !== null && typeof v === 'object';
}

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export function getAt(doc: unknown, segments: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const token of segments) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(cur, token)];
    else if (isContainer(cur) && hasOwn(cur, token)) cur = (cur as Record<string, unknown>)[token];
    else throw new MutationError(`path ${formatPointer(segments)} does not exist`);
  }
  return cur;
}

function parentOf(doc: unknown, segments: readonly string[]): { parent: Container; key: string } {
  const parent = getAt(doc, segments.slice(0, -1));
  if (!isContainer(parent)) throw new MutationError(`parent of ${formatPointer(segments)} is not an object or array`);
  return { parent, key: segments[segments.length - 1]! };
}

function opReplace(doc: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const { parent, key } = parentOf(doc, segments);
  if (Array.isArray(parent)) parent[arrayIndex(parent, key)] = value;
  else if (hasOwn(parent, key)) parent[key] = value;
  else throw new MutationError(`path ${formatPointer(segments)} does not exist`);
  return doc;
}

function opRemove(doc: unknown, segments: string[]): unknown {
  if (segments.length === 0) throw new MutationError('cannot remove the document root');
  const { parent, key } = parentOf(doc, segments);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key), 1);
  else if (hasOwn(parent, key)) delete parent[key];
  else throw new MutationError(`path ${formatPointer(segments)} does not exist`);
  return doc;
}

function opAdd(doc: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const { parent, key } = parentOf(doc, segments);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, { allowEnd: true }), 0, value);
  else parent[key] = value;
  return doc;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

const DROPPED_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding'];

/** Throws MutationError if an op doesn't apply. */
export function applyMutation(response: HttpResponse, ops: readonly MutationOp[]): MutatedResponse {
  let status = response.status;
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  let text = response.body ?? '';
  let json: unknown;
  let haveJson = false;

  const loadJson = (): unknown => {
    if (!haveJson) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new MutationError('response body is not JSON, so JSON operations cannot apply');
      }
      haveJson = true;
    }
    return json;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'status':
        status = op.value;
        break;
      case 'setBody':
        text = typeof op.value === 'string' ? op.value : JSON.stringify(op.value);
        haveJson = false;
        json = undefined;
        break;
      case 'replace':
        json = opReplace(loadJson(), parsePointer(op.path), clone(op.value));
        text = JSON.stringify(json);
        break;
      case 'remove':
        json = opRemove(loadJson(), parsePointer(op.path));
        text = JSON.stringify(json);
        break;
      case 'add':
        json = opAdd(loadJson(), parsePointer(op.path), clone(op.value));
        text = JSON.stringify(json);
        break;
      case 'move': {
        const from = parsePointer(op.from);
        const to = parsePointer(op.path);
        if (to.length > from.length && formatPointer(to.slice(0, from.length)) === formatPointer(from)) {
          throw new MutationError(`cannot move ${op.from} into its own child ${op.path}`);
        }
        const doc = loadJson();
        const value = getAt(doc, from);
        json = opAdd(opRemove(doc, from), to, value);
        text = JSON.stringify(json);
        break;
      }
      case 'copy': {
        const doc = loadJson();
        json = opAdd(doc, parsePointer(op.path), clone(getAt(doc, parsePointer(op.from))));
        text = JSON.stringify(json);
        break;
      }
      default: {
        // only reachable with hand-edited JSON
        const unknownOp: never = op;
        throw new MutationError(`unknown operation "${(unknownOp as { op: string }).op}"`);
      }
    }
  }

  for (const name of Object.keys(headers)) {
    if (DROPPED_HEADERS.includes(name.toLowerCase())) delete headers[name];
  }
  return { status, headers, body: text };
}

interface MutantLike {
  id?: unknown;
  target?: { method?: unknown; path?: unknown } | null;
  ops?: unknown;
}

/** Returns the problems found; empty means valid. */
export function validateMutant(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') return ['mutant is not an object'];
  const { id, target, ops } = m as MutantLike;
  if (typeof id !== 'string' || !id) errors.push('missing id');
  if (!target || typeof target !== 'object') errors.push('missing target');
  else {
    if (typeof target.method !== 'string' || !target.method) errors.push('target.method must be a string');
    if (typeof target.path !== 'string' || !target.path.startsWith('/')) errors.push('target.path must start with "/"');
  }
  if (!Array.isArray(ops) || ops.length === 0) errors.push('ops must be a non-empty array');
  else if (ops.length > MAX_OPS) errors.push(`at most ${MAX_OPS} ops are allowed`);
  else {
    ops.forEach((raw: unknown, i) => {
      const op = (raw ?? {}) as Record<string, unknown>;
      if (!(OPS as readonly string[]).includes(op.op as OpName)) {
        errors.push(`ops[${i}]: unknown op "${String(op.op)}"`);
        return;
      }
      if (op.op === 'status') {
        if (!Number.isInteger(op.value) || (op.value as number) < 100 || (op.value as number) > 599) {
          errors.push(`ops[${i}]: status must be an integer 100-599`);
        }
        return;
      }
      if (op.op === 'setBody') {
        if (op.value === undefined) errors.push(`ops[${i}]: setBody needs a value`);
        return;
      }
      if (typeof op.path !== 'string') errors.push(`ops[${i}]: ${op.op} needs a path`);
      if ((op.op === 'move' || op.op === 'copy') && typeof op.from !== 'string') errors.push(`ops[${i}]: ${op.op} needs a from`);
      if ((op.op === 'replace' || op.op === 'add') && op.value === undefined) errors.push(`ops[${i}]: ${op.op} needs a value`);
    });
  }
  return errors;
}

/** null if the mutant applies to the recording and changes it, otherwise why not */
export function dryRun(mutant: { ops: readonly MutationOp[] }, exchange: Pick<Exchange, 'status' | 'body'> | null | undefined): string | null {
  const problems = validateMutant(mutant);
  if (problems.length) return problems.join('; ');
  if (!exchange || exchange.body == null) return 'the recorded response has no body to mutate';
  try {
    const before = { status: exchange.status, headers: {}, body: exchange.body };
    const after = applyMutation(before, mutant.ops);
    if (after.status === before.status && sameBody(after.body, before.body)) return 'the mutation does not change the response';
    return null;
  } catch (e) {
    return e instanceof MutationError ? e.message : `unexpected error: ${(e as Error).message}`;
  }
}

function sameBody(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

// method + pathname; query strings are ignored
export function matchesTarget(target: Target, method: string, url: string | URL): boolean {
  if (target.method.toUpperCase() !== String(method).toUpperCase()) return false;
  const pathname = typeof url === 'string' ? new URL(url).pathname : url.pathname;
  return pathname === target.path;
}

export function findExchange(exchanges: readonly Exchange[], target: Target): Exchange | null {
  return exchanges.find((x) => matchesTarget(target, x.method, x.url)) ?? null;
}

export function describeOps(ops: readonly MutationOp[]): string {
  const v = (x: unknown) => {
    const s = JSON.stringify(x);
    return s && s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  return ops
    .map((op) => {
      switch (op.op) {
        case 'status':
          return `status → ${op.value}`;
        case 'setBody':
          return `body → ${v(op.value)}`;
        case 'replace':
          return `${op.path} → ${v(op.value)}`;
        case 'remove':
          return `remove ${op.path}`;
        case 'add':
          return `add ${op.path} = ${v(op.value)}`;
        case 'move':
          return `move ${op.from} → ${op.path}`;
        case 'copy':
          return `copy ${op.from} → ${op.path}`;
      }
    })
    .join('; ');
}
