// Spawns Playwright for the record and mutate phases.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { paths, readDirJson, resetDir, slug, writeJson } from './store.js';
import { escapeRegExp, tail } from './util.js';
import type { MutantResult, MutantsFile, MutantsTest, Outcome, PlanEntry, Recording, RunPlan, TestResult } from './types.js';

export function resolvePlaywrightCli(cwd: string): string {
  const require = createRequire(path.join(path.resolve(cwd), 'package.json'));
  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    throw new Error(`Could not find @playwright/test from ${cwd}. Install it in the project you are auditing.`);
  }
}

export function defaultWorkers(): number {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

export interface PlaywrightRun {
  code: number;
  output: string;
}

// keeps only the last 20k chars of output
export function runPlaywright({ cwd, args, env = {}, echo = false }: { cwd: string; args: string[]; env?: Record<string, string>; echo?: boolean }): Promise<PlaywrightRun> {
  const cli = resolvePlaywrightCli(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      if (echo) process.stdout.write(text);
      output = (output + text).slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

interface Scope {
  cwd: string;
  outDir: string;
  config?: string;
  project?: string;
}

function baseArgs({ config, project }: { config?: string; project?: string }): string[] {
  const args = ['--reporter=line'];
  if (config) args.push('--config', config);
  if (project) args.push('--project', project);
  return args;
}

export interface RecordResult extends PlaywrightRun {
  passed: Recording[];
  failed: Recording[];
}

export interface RecordOptions extends Scope {
  grep?: string;
  echo?: boolean;
  /** default true */
  redact?: boolean;
  /** on top of the built-in list */
  redactKeys?: string[];
}

export async function record({ cwd, outDir, config, project, grep, echo = true, redact = true, redactKeys = [] }: RecordOptions): Promise<RecordResult> {
  const dirs = paths(outDir);
  resetDir(dirs.recordings);
  const args = baseArgs({ config, project });
  if (grep) args.push('--grep', grep);
  const { code, output } = await runPlaywright({
    cwd,
    args,
    echo,
    env: {
      CATCHRATE_MODE: 'record',
      CATCHRATE_DIR: path.resolve(outDir),
      CATCHRATE_REDACT: redact ? 'on' : 'off',
      CATCHRATE_REDACT_KEYS: redactKeys.join(','),
    },
  });
  const recordings = readDirJson<Recording>(dirs.recordings);
  return {
    code,
    output,
    passed: recordings.filter((r) => r.status === 'passed'),
    failed: recordings.filter((r) => r.status !== 'passed'),
  };
}

// Playwright greps "<project> <file> <describes> <title> <@tags>". Anchoring on
// the file and the full title stops "Mini Cart x" from matching "Cart x"; the
// tail allows the tags Playwright appends for tests declared with { tag }.
export function grepFor(titlePath: readonly string[]): string {
  return `(^|\\s)${escapeRegExp(titlePath.join(' '))}(\\s@\\S+)*$`;
}

export interface RunOptions extends Scope {
  mutantsData: MutantsFile;
  workers?: number;
  timeout?: number;
  onTest?: (result: TestResult) => void;
}

// The unmutated test runs twice, first and last. Two controls catch flaky tests,
// and the lines that differ between them show which parts of the page are live
// data (clocks, tickers), so looksUnchanged() can ignore those.
const CONTROLS = ['control', 'control-2'] as const;

// One Playwright process per test, with --repeat-each covering the two controls
// and one repeat per mutant.
export async function runMutants({ cwd, outDir, config, mutantsData, workers = defaultWorkers(), timeout, onTest = () => {} }: RunOptions): Promise<{ runId: string; results: TestResult[] }> {
  const dirs = paths(outDir);
  // leftovers from earlier runs are useless and would pile up
  resetDir(dirs.plans);
  resetDir(dirs.outcomes);
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const results: TestResult[] = [];

  for (const t of mutantsData.tests) {
    if (!t.mutants.length) continue;
    const started = Date.now();
    const entries: PlanEntry[] = [
      { id: CONTROLS[0], control: true },
      ...t.mutants.map((m) => ({ id: m.id, target: m.target, ops: m.ops })),
      // last, so live data has had time to change since the first control
      { id: CONTROLS[1], control: true },
    ];
    const testRunId = `${runId}/${slug(t.key)}`;
    const planFile = path.resolve(dirs.plans, `${slug(t.key)}.json`);
    const plan: RunPlan = { key: t.key, runId: testRunId, entries };
    writeJson(planFile, plan);

    const args = [...baseArgs({ config, project: t.project }), '--grep', grepFor(t.titlePath), `--repeat-each=${entries.length}`, '--retries=0', `--workers=${workers}`];
    if (timeout) args.push(`--timeout=${timeout}`);

    const { code, output } = await runPlaywright({
      cwd,
      args,
      env: {
        CATCHRATE_MODE: 'mutate',
        CATCHRATE_DIR: path.resolve(outDir),
        CATCHRATE_PLAN: planFile,
      },
    });

    const outcomes = new Map(readDirJson<Outcome>(path.join(dirs.outcomes, testRunId)).map((o) => [o.id, o]));
    const result = classify(t, outcomes, { code, output });
    result.durationMs = Date.now() - started;
    results.push(result);
    onTest(result);
  }
  return { runId, results };
}

export function classify(t: MutantsTest, outcomes: Map<string, Outcome>, { code, output }: Partial<PlaywrightRun> = {}): TestResult {
  const base = { key: t.key, project: t.project, titlePath: t.titlePath, title: t.title, file: t.file };
  const all = (outcome: MutantResult['outcome'], detail: string): MutantResult[] => t.mutants.map((m) => ({ ...m, outcome, detail }));
  const control = outcomes.get(CONTROLS[0]);
  // a crashed second control just means no live-data detection
  const second = outcomes.get(CONTROLS[1]) ?? control;

  if (!control && /no tests found/i.test(output ?? '')) {
    return { ...base, status: 'missing', detail: 'The test was not found in this run (renamed, deleted, or outside this config).', mutants: all('skipped', 'test not found') };
  }
  if (!control) {
    return {
      ...base,
      status: 'error',
      detail: `The test did not run under catchrate (exit code ${code}). Is it importing test from 'catchrate/fixture'?\n${tail(output)}`,
      mutants: all('error', 'test did not run'),
    };
  }
  const failedControl = [control, second].find((c) => c && c.status !== 'passed');
  if (failedControl) {
    return {
      ...base,
      status: 'unstable',
      detail: `An unmutated control run did not pass (${failedControl.status}${failedControl.error ? `: ${failedControl.error}` : ''}). Mutant results for this test were discarded.`,
      mutants: all('skipped', 'control run failed'),
    };
  }
  return {
    ...base,
    status: 'ok',
    mutants: t.mutants.map((m): MutantResult => {
      const o = outcomes.get(m.id);
      if (!o) return { ...m, outcome: 'error', detail: 'no result was recorded for this mutant' };
      if (o.intercepted === 0) return { ...m, outcome: 'not-applied', detail: 'the test never made this request' };
      if (o.applied === 0 && o.routeErrors.length) return { ...m, outcome: 'error', detail: `mutation failed at run time: ${o.routeErrors[0]}` };
      if (o.status === 'passed') {
        if (looksUnchanged(o.snapshot, control.snapshot, second!.snapshot)) {
          return { ...m, outcome: 'no-visible-effect', detail: 'the final page looked the same as without the bug' };
        }
        return { ...m, outcome: 'survived' };
      }
      if (o.status === 'failed' || o.status === 'timedOut') return { ...m, outcome: 'killed', detail: o.error ?? o.status };
      return { ...m, outcome: 'error', detail: `test ended with status ${o.status}` };
    }),
  };
}

const CLOCK = /\d:\d\d/;
const shape = (line: string) => line.replace(/\d/g, '0');

// Does a mutant's final page match the controls'? Lines that differ between the
// two controls are live data, and so are clock-like lines; on those only the
// shape counts (digits masked), so 12:00:01 vs 12:00:02 is the same but
// 27,910.90 vs 27,910.900 isn't. Every other line has to match exactly.
export function looksUnchanged(mutant: string[] | null, a: string[] | null, b: string[] | null): boolean {
  if (!mutant || !a || !b || mutant.length !== a.length || a.length !== b.length) return false;
  return mutant.every((line, i) => {
    const x = a[i]!;
    const y = b[i]!;
    if (line === x || line === y) return true;
    const live = x !== y || CLOCK.test(x);
    return live && (shape(line) === shape(x) || shape(line) === shape(y));
  });
}
