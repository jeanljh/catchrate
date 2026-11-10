// Output dir layout:
//   recordings/<slug>.json             record mode, one per test
//   mutants.json                       from propose
//   plans/<slug>.json                  runner -> fixture, one per test
//   outcomes/<runId>/<slug>/<id>.json  fixture -> runner, one per repeat
//   report.json, .md, .html            from run

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface OutPaths {
  root: string;
  recordings: string;
  mutants: string;
  plans: string;
  outcomes: string;
  reportJson: string;
  reportMd: string;
}

export const paths = (outDir: string): OutPaths => ({
  root: outDir,
  recordings: path.join(outDir, 'recordings'),
  mutants: path.join(outDir, 'mutants.json'),
  plans: path.join(outDir, 'plans'),
  outcomes: path.join(outDir, 'outcomes'),
  reportJson: path.join(outDir, 'report.json'),
  reportMd: path.join(outDir, 'report.md'),
});

// project + title path. No line numbers, so moving a test doesn't change its key.
export function testKey(projectName: string, titlePath: readonly string[]): string {
  return [projectName || '', ...titlePath].join(' › ');
}

// for ids and file names, not security
export function hash(value: unknown, length = 10): string {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, length);
}

// readable part for humans, hash so two keys never collide
export function slug(key: string): string {
  const readable = key
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${readable}-${hash(key, 8)}`;
}

// path.join that refuses to leave `base`. Use it for any path built from file
// contents.
export function safeJoin(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to use path outside ${root}: ${segments.join('/')}`);
  }
  return target;
}

// no checks here; validate.ts handles files we don't trust
export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // temp file + rename so readers never see half a file
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readDirJson<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<T>(path.join(dir, f)));
}

export function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
